import type { AxisBands, AxisSummary } from '@repo/queue';

/**
 * The pure primitives that turn TRIBE's raw band activations into one number.
 *
 * Extracted out of `apps/worker/src/scoring.ts` so `apps/poller` scores the
 * research corpus with the SAME function that scores a customer's analysis. A
 * separate queue is not a separate inference path (corpus spec §4b): if corpus
 * features were reduced by a second copy of these constants, the backtest would
 * silently stop describing the product and no test would catch it.
 *
 * Everything here is pure and deterministic. The percentile is NOT here — it
 * ranks against a workspace's prior analyses, which the corpus does not have
 * (§4c), so it stays in `apps/worker`.
 */

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
 * finding. The corpus is the batch that can settle it.
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
export const COMPOSITE_WEIGHTS = { visual: 0.4, audio: 0.35, language: 0.25 } as const;

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
