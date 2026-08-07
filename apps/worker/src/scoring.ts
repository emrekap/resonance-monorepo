import type { AxisBands } from '@repo/queue';
import { AxisConfidence, ResonanceAxis } from '@repo/db/enums';

/**
 * Turning the ML layer's raw band activations into the numbers a creator sees.
 *
 * Everything here is pure and deterministic: the same clip against the same
 * history produces the same score, every time. That is the property that makes
 * the score arguable — a number nobody can reproduce is a number nobody can
 * challenge. The prose in `insights.ts` is the only non-deterministic part of
 * the pipeline, and it never touches these values.
 *
 * The central decision (docs/superpowers/specs/2026-08-07-analysis-insights-design.md)
 * is that the score is **relative to the creator's own history**, never absolute
 * and never cross-creator. TRIBE outputs z-scored BOLD; there is no calibration
 * mapping that onto engagement, and inventing one would produce a number that
 * reads as real. Ranking a clip against the same creator's other clips needs no
 * such mapping — and it is also the statistically correct framing, because the
 * creator is the confounder you have to condition on
 * (docs/resonance-model-design.md §2b).
 */

/**
 * Prior analyses required before a percentile is meaningful enough to show.
 *
 * A tuning constant, not a statistical claim: 5 is low enough that the score
 * appears in a creator's first session and high enough that one outlier clip
 * cannot put a new upload at the 100th percentile. Raise it if early scores
 * prove jumpy.
 */
export const MIN_HISTORY = 5;

/**
 * How much each axis moves the headline number.
 *
 * Weighted by the defensibility tiers in docs/resonance-model-design.md §1a —
 * visual and audio are the best-predicted cortex and match their input modality
 * one-to-one, language is solid only for speech. EMOTIONAL_PULL and MEMORABILITY
 * are deliberately **absent**: both are cortical shadows of subcortical
 * structures that fsaverage5 does not contain, and a BETA axis has no business
 * moving the number on the front of the screen.
 */
const COMPOSITE_WEIGHTS = { visual: 0.4, audio: 0.35, language: 0.25 } as const;

/** Axis order — must match `analysis_axis_scores.position` and `AXES` in apps/ml. */
const AXIS_ORDER = [
  { axis: ResonanceAxis.VISUAL_ATTENTION, band: 'visual', confidence: AxisConfidence.STABLE },
  { axis: ResonanceAxis.AUDIO_ENGAGEMENT, band: 'audio', confidence: AxisConfidence.STABLE },
  { axis: ResonanceAxis.CLARITY, band: 'language', confidence: AxisConfidence.MEDIUM },
  { axis: ResonanceAxis.EMOTIONAL_PULL, band: 'emotional', confidence: AxisConfidence.BETA },
  { axis: ResonanceAxis.MEMORABILITY, band: 'memorability', confidence: AxisConfidence.BETA },
] as const satisfies readonly {
  axis: ResonanceAxis;
  band: keyof AxisBands;
  confidence: AxisConfidence;
}[];

export type AxisRow = {
  axis: ResonanceAxis;
  score: number;
  confidence: AxisConfidence;
  position: number;
};

export type Scored = {
  resonanceScore: number | null;
  percentileInChannel: number | null;
  confidence: number | null;
  axisRows: AxisRow[];
};

/** The single number the percentile ranks. See {@link COMPOSITE_WEIGHTS}. */
export function composite(bands: AxisBands): number {
  return (
    bands.visual * COMPOSITE_WEIGHTS.visual +
    bands.audio * COMPOSITE_WEIGHTS.audio +
    bands.language * COMPOSITE_WEIGHTS.language
  );
}

/**
 * Where `value` falls among `history`, as 0–100.
 *
 * Strictly-less-than rank, so a clip tied with everything it is compared to
 * scores 0 rather than 50 — ties should not read as "average", they should read
 * as "not better than". With `history` empty this is 0, which is why every
 * caller gates on {@link MIN_HISTORY} first rather than relying on this.
 */
export function percentile(value: number, history: readonly number[]): number {
  if (history.length === 0) return 0;
  const below = history.reduce((count, prior) => (prior < value ? count + 1 : count), 0);
  return (below / history.length) * 100;
}

/**
 * How much to trust the percentile, 0–1.
 *
 * Two independent things make a rank trustworthy, and both have to hold: how
 * much history it was ranked against, and how much signal the clip itself
 * carried. A 3-second clip has too few segments for its band means to be stable
 * no matter how much history sits behind it, and multiplying rather than
 * averaging is what stops a long history from papering over that.
 */
export function confidence(priorCount: number, nSegments: number): number {
  const historyDepth = Math.min(1, priorCount / 20);
  const signalLength = Math.min(1, nSegments / 20);
  return historyDepth * signalLength;
}

/**
 * The full scoring pass for one analysis.
 *
 * `history` holds the composite-relevant bands of the workspace's prior
 * succeeded analyses — **excluding this one**, which the caller guarantees by
 * reading history before writing.
 *
 * Below {@link MIN_HISTORY} priors this returns nulls and **no axis rows at
 * all**. Both the headline score and the axis bars are ranks against the
 * creator's own past, so neither exists yet; the timeline and the
 * recommendations are about this clip alone and carry the screen until the
 * ranking turns on. Writing axis rows with a sentinel 0 was the alternative and
 * is worse: a zero-length bar labelled "Visual attention" reads as *bad*, not as
 * *unknown*.
 */
export function scoreAnalysis(input: {
  bands: AxisBands;
  history: readonly AxisBands[];
  nSegments: number;
  hasSpeech: boolean;
}): Scored {
  const { bands, history, nSegments, hasSpeech } = input;

  if (history.length < MIN_HISTORY) {
    return { resonanceScore: null, percentileInChannel: null, confidence: null, axisRows: [] };
  }

  const rank = percentile(composite(bands), history.map(composite));

  const axisRows = AXIS_ORDER.map((entry, position) => ({
    axis: entry.axis,
    score: percentile(
      bands[entry.band],
      history.map((prior) => prior[entry.band]),
    ),
    // A language-network score on a clip with no speech is measuring nothing.
    // The label is what tells the creator so — without it the bar looks like a
    // verdict on their writing rather than an artefact of there being none.
    confidence:
      entry.axis === ResonanceAxis.CLARITY && !hasSpeech ? AxisConfidence.BETA : entry.confidence,
    position,
  }));

  return {
    // The same number in two presentations: "72" and "top 28%". A second,
    // differently-scaled number would imply a calibration that does not exist.
    // When a real one lands, it lands here and percentileInChannel is unchanged.
    resonanceScore: Math.round(rank),
    percentileInChannel: rank,
    confidence: confidence(history.length, nSegments),
    axisRows,
  };
}
