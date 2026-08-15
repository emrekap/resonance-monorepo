/**
 * The attention timeline's pure logic, kept out of the component so it can run
 * under `bun test` (the `.tsx` half needs a native renderer).
 */

export type TimelineBands = {
  startSec: readonly number[];
  visual: readonly number[];
  audio: readonly number[];
  language: readonly number[];
};

export type TimelineMarker = {
  kind: 'peak' | 'dip';
  startSec: number;
};

export type BandKey = 'visual' | 'audio' | 'language';

/** Which lines to fade. True = the clip does not contain this channel. */
export type MutedBands = Record<BandKey, boolean>;

export const BANDS = [
  { key: 'visual', label: 'Visual', token: 'bandVisual' },
  { key: 'audio', label: 'Audio', token: 'bandAudio' },
  { key: 'language', label: 'Language', token: 'bandLanguage' },
] as const;

/**
 * Muting reads the `stimulus_has_*` flags off the analysis result.
 *
 * Only an explicit `false` mutes: the model fills every band no matter what the
 * clip contains, so "this channel is absent" is a fact about the *stimulus*
 * (ffmpeg probe + transcript), and null means the fact was never established —
 * a row from before the probe existed renders exactly as it always did.
 *
 * Language keys off *speech*, not audio: a music-only clip has sound but
 * nothing for the language network to follow.
 */
export function mutedBands(
  stimulus:
    | {
        stimulusHasAudio?: boolean | null;
        stimulusHasVisual?: boolean | null;
        stimulusHasSpeech?: boolean | null;
      }
    | null
    | undefined,
): MutedBands {
  return {
    visual: stimulus?.stimulusHasVisual === false,
    audio: stimulus?.stimulusHasAudio === false,
    language: stimulus?.stimulusHasSpeech === false,
  };
}

/**
 * The strongest peak and deepest dip in the combined response.
 *
 * Derived here rather than passed in. The screen only knows which moments the
 * recommendations point at, and it cannot tell a peak from a dip — an earlier
 * version mapped every recommendation to `kind: 'dip'`, so a moment the model
 * praised was drawn in warning colour. The curve is right here; classifying it
 * is three lines and cannot disagree with what is on screen.
 *
 * Muted bands are excluded from the sum: a silent clip's auditory curve is the
 * model's baseline, and letting it place the green "peak" marker would point a
 * creator at a moment nothing happens in.
 *
 * `apps/worker` runs its own marker detection for the prompt. The two need not
 * agree: that one decides what Claude explains, this one decides what a creator
 * sees, and both read the same curve.
 */
export function deriveMarkers(timeline: TimelineBands, muted: MutedBands): TimelineMarker[] {
  const live = BANDS.filter((band) => !muted[band.key]);
  const combined = timeline.startSec.map((startSec, index) => ({
    startSec,
    value: live.reduce((sum, band) => sum + (timeline[band.key][index] ?? 0), 0),
  }));
  if (combined.length < 3) return [];

  const sorted = [...combined].sort((a, b) => a.value - b.value);
  const dip = sorted[0];
  const peak = sorted[sorted.length - 1];
  if (!dip || !peak || dip.startSec === peak.startSec || dip.value === peak.value) return [];

  return [
    { kind: 'peak' as const, startSec: peak.startSec },
    { kind: 'dip' as const, startSec: dip.startSec },
  ].sort((a, b) => a.startSec - b.startSec);
}

/** `73.5` -> `1:13`. */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * Build an SVG path for one band.
 *
 * All three bands share one y-scale, taken across all of them together, so their
 * relative heights are comparable. Scaling each band to its own range would make
 * a flat audio track look as dynamic as a busy visual one.
 */
export function buildPath(
  values: readonly number[],
  xs: readonly number[],
  domain: { min: number; max: number },
  width: number,
  height: number,
): string {
  if (values.length === 0 || xs.length === 0) return '';
  const spanX = Math.max(1e-6, (xs[xs.length - 1] ?? 0) - (xs[0] ?? 0));
  const spanY = Math.max(1e-6, domain.max - domain.min);

  return values
    .map((value, index) => {
      const x = (((xs[index] ?? 0) - (xs[0] ?? 0)) / spanX) * width;
      // SVG y grows downward; invert so a higher response draws higher.
      const y = height - ((value - domain.min) / spanY) * height;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}
