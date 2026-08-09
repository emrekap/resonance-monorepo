import type { AxisBands, AxisSummary } from '@repo/queue';
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
 * Which of the three per-axis statistics becomes the score.
 *
 * **This is the most consequential line in the file, and it is a guess.** All
 * three cross the queue (see `axisSummarySchema`) precisely so that settling it
 * against real data is a one-word edit here rather than a change to `apps/ml`,
 * the contract and a GPU deploy.
 *
 * - `peak` — mean of the top quartile of segments. Chosen as the default: it is
 *   the closest of the three to the question the product asks ("did this hold
 *   attention at its best moments"), and unlike `mean` it does not average the
 *   signal away.
 * - `std` — how much the network's response varied. `docs/resonance-model-design.md`
 *   §0 offers this as a "dynamism" proxy. Blind to direction: a clip that swings
 *   downward scores like one that swings up.
 * - `mean` — the original choice, kept for comparison and **not recommended**.
 *   TRIBE predicts z-scored BOLD, so a time-average sits near zero by
 *   construction; that is the same objection §0 raises against the brain-wide
 *   average, and it applies within a network too, just less severely.
 *
 * How to settle it: run a batch of real clips, rank each way, and check which
 * ordering a human would defend. Until then this is a documented guess, not a
 * finding.
 */
export const BAND_SUMMARY: keyof AxisSummary = 'peak';

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

/** The chosen statistic for one axis. See {@link BAND_SUMMARY}. */
export function band(bands: AxisBands, axis: keyof AxisBands): number {
  return bands[axis][BAND_SUMMARY];
}

/** The single number the percentile ranks. See {@link COMPOSITE_WEIGHTS}. */
export function composite(bands: AxisBands): number {
  return (
    band(bands, 'visual') * COMPOSITE_WEIGHTS.visual +
    band(bands, 'audio') * COMPOSITE_WEIGHTS.audio +
    band(bands, 'language') * COMPOSITE_WEIGHTS.language
  );
}

/**
 * Turns a continuous rank into a 0–100 score — the **Weibull plotting position**.
 *
 * `pos` is where the clip sits on the 0..n-1 axis of sorted priors, so the
 * obvious scaling is `pos / (n - 1)`. That is what this used to do, and it pins
 * the smallest prior to exactly 0 and the largest to exactly 100 by
 * construction: a clip better than everything a creator has made scored 100 —
 * "top 0% of your posts" — off as few as five data points.
 *
 * `(pos + 1) / (n + 1)` says the defensible thing instead. Beating 5 of 5 priors
 * is evidence you rank above 5 of 6, not above everything you might ever post.
 * The reachable band tightens as history grows — 17–83 at five priors, 0.5–99.5
 * at the 200-row cap `apps/worker` reads history under — which is the honest
 * shape: 200 clips can nearly justify a 100, five cannot.
 */
function plot(pos: number, n: number): number {
  return ((pos + 1) / (n + 1)) * 100;
}

/**
 * Where `value` falls in the distribution of `history`, as 0–100.
 *
 * **Linear-interpolated ECDF, not a raw count.** A count is the obvious
 * implementation and produces an unusable score at the history sizes this
 * feature actually runs at: ranking against 5 priors, `below/n` can only be 0,
 * 20, 40, 60, 80 or 100. The headline number could never read 72 until a creator
 * had ~20 analyses, and every new upload would move it in 20-point steps.
 *
 * Interpolating between the two bracketing values gives a continuous score from
 * the fifth analysis onward, and converges on the plain rank as history grows.
 * The endpoints are handled by {@link plot} rather than saturating at 0 and 100.
 *
 * Ties and degenerate history (every prior identical) return 50: a clip that
 * matches everything it is compared against is exactly typical, which is what
 * the middle of the range means. An earlier version returned 0 there, which read
 * on screen as "worst" for a clip that was in fact average.
 */
export function percentile(value: number, history: readonly number[]): number {
  // Unreachable through scoreAnalysis, which guards on MIN_HISTORY. 50 rather
  // than 0 for the same reason the flat-history case below returns 50: with
  // nothing to rank against, the middle is the only answer that does not assert
  // "good" or "bad" about a clip nobody has measured.
  if (history.length === 0) return 50;

  const sorted = [...history].sort((a, b) => a - b);
  const n = sorted.length;
  const lowest = sorted[0] as number;
  const highest = sorted[n - 1] as number;

  // Every prior identical: there is no range to place the value inside, only
  // three answers — under it, on it, over it.
  if (highest - lowest < Number.EPSILON) {
    if (value > lowest) return plot(n - 1, n);
    if (value < lowest) return plot(0, n);
    return 50;
  }

  if (value <= lowest) return plot(0, n);
  if (value >= highest) return plot(n - 1, n);

  // Position on the 0..n-1 axis of sorted priors, interpolated within whichever
  // pair brackets `value`.
  const upper = sorted.findIndex((prior) => prior > value);
  const lower = upper - 1;
  const span = (sorted[upper] as number) - (sorted[lower] as number);
  const offset = span < Number.EPSILON ? 0 : (value - (sorted[lower] as number)) / span;
  return plot(lower + offset, n);
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
      band(bands, entry.band),
      history.map((prior) => band(prior, entry.band)),
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
