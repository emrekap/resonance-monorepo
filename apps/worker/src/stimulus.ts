import type { AnalysisSucceeded } from '@repo/queue';

/**
 * The three `stimulus_has_*` columns on `analysis_results`.
 *
 * The model predicts every brain network regardless of what the clip contains,
 * so these flags — not the curves — are how the result screen knows which
 * timeline lines to fade. Audio and visual come from the ffmpeg probe in
 * `apps/ml`; speech is derived here from the transcript whisperx produced,
 * because "audio" and "speech" genuinely differ (a music-only clip has one and
 * not the other) and the probe never ran an ASR pass.
 *
 * Null means **unknown**, never "no": a payload without the probe (older ml
 * image) or without a transcript writes nulls, and the client renders null
 * exactly as it rendered rows from before these columns existed.
 */
export type StimulusColumns = {
  stimulusHasAudio: boolean | null;
  stimulusHasVisual: boolean | null;
  stimulusHasSpeech: boolean | null;
};

export function stimulusColumns(
  result: Pick<AnalysisSucceeded, 'stimulus' | 'transcript'>,
): StimulusColumns {
  const transcript = result.transcript ?? null;
  return {
    stimulusHasAudio: result.stimulus?.hasAudio ?? null,
    stimulusHasVisual: result.stimulus?.hasVisual ?? null,
    stimulusHasSpeech:
      transcript === null ? null : transcript.some((entry) => entry.text.trim().length > 0),
  };
}
