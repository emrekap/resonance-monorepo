import { useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Alert } from 'react-native';

import { api } from '@/lib/api';
import { pickMedia, registerMedia, uploadToStorage, type UploadKind } from '@/lib/media';

export type AnalysisPhase = 'idle' | 'picking' | 'registering' | 'uploading' | 'queueing';

/** User-facing copy per phase, so screens don't hand-roll status strings. */
export const PHASE_LABELS: Record<Exclude<AnalysisPhase, 'idle'>, string> = {
  picking: 'Choosing media…',
  registering: 'Preparing upload…',
  uploading: 'Uploading…',
  queueing: 'Starting analysis…',
};

/**
 * The whole pick → register → upload → analyze pipeline as one state machine.
 *
 * Phases exist because each step fails differently and the screen should say
 * which one died. Cancel only matters during `uploading` — the abort reaches
 * the native `UploadTask`; earlier phases are quick round trips, and the
 * enqueue is not cancellable once sent (retrying is safe server-side anyway).
 *
 * Images upload fine but TRIBE only takes video/audio, so an image ends the
 * flow at "saved" instead of queueing an analysis the API would refuse.
 */
export function useMediaAnalysis() {
  const router = useRouter();
  const [phase, setPhase] = useState<AnalysisPhase>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(
    async (kind: UploadKind) => {
      setError(null);
      setProgress(0);
      try {
        setPhase('picking');
        const media = await pickMedia(kind);
        if (!media) return; // user backed out — nothing to report

        setPhase('registering');
        const registered = await registerMedia(media);

        setPhase('uploading');
        const abort = new AbortController();
        abortRef.current = abort;
        await uploadToStorage(media, registered, {
          onProgress: setProgress,
          signal: abort.signal,
        });

        if (kind === 'image') {
          Alert.alert('Uploaded', 'Image analysis is coming soon — your file is saved.');
          return;
        }

        setPhase('queueing');
        const res = await api.analyze.$post({ json: { mediaAssetId: registered.mediaAssetId } });
        if (res.status !== 202) {
          const body = await res.json();
          const reason = 'error' in body && typeof body.error === 'string' ? body.error : null;
          throw new Error(reason ?? 'Could not start the analysis.');
        }
        const { jobId } = await res.json();
        router.push(`/analysis/${jobId}`);
      } catch (cause) {
        // An aborted upload is the user's own cancel, not an error to surface.
        if (abortRef.current?.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : 'Something went wrong.');
      } finally {
        abortRef.current = null;
        setPhase('idle');
        setProgress(0);
      }
    },
    [router],
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  return { phase, progress, error, start, cancel };
}
