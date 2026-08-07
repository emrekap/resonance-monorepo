import { describe, expect, test } from 'bun:test';
import { AxisConfidence, ResonanceAxis } from '@repo/db/enums';
import type { AxisBands, AxisSummary } from '@repo/queue';

import {
  BAND_SUMMARY,
  MIN_HISTORY,
  composite,
  confidence,
  percentile,
  scoreAnalysis,
} from './scoring';

/**
 * Only the statistic `BAND_SUMMARY` selects carries the value; the other two get
 * an obviously-wrong sentinel, so a test that passes because scoring read the
 * wrong field fails loudly instead of quietly agreeing.
 *
 * Keyed off the exported constant rather than hardcoding `peak`, so switching
 * the chosen statistic does not silently invalidate every assertion below.
 */
const summary = (value: number): AxisSummary => ({
  mean: -999,
  std: -999,
  peak: -999,
  [BAND_SUMMARY]: value,
});

const AXES = ['visual', 'audio', 'language', 'emotional', 'memorability'] as const;

const bands = (overrides: Partial<Record<keyof AxisBands, number>> = {}): AxisBands =>
  Object.fromEntries(AXES.map((axis) => [axis, summary(overrides[axis] ?? 0)])) as AxisBands;

/** `n` prior analyses whose composite climbs 0, 1, 2, … so ranks are predictable. */
const ladder = (n: number): AxisBands[] =>
  Array.from({ length: n }, (_, index) => bands({ visual: index, audio: index, language: index }));

describe('percentile', () => {
  test('pins the ends of the observed range', () => {
    expect(percentile(5, [1, 2, 3, 4])).toBe(100);
    expect(percentile(9, [1, 2, 3, 4])).toBe(100);
    expect(percentile(0, [1, 2, 3, 4])).toBe(0);
    expect(percentile(1, [1, 2, 3, 4])).toBe(0);
  });

  test('lands on the plain rank when the value sits on a prior', () => {
    expect(percentile(2, [1, 2, 3, 4])).toBeCloseTo(100 / 3);
    expect(percentile(3, [1, 2, 3, 4])).toBeCloseTo(200 / 3);
  });

  test('interpolates between priors instead of stepping', () => {
    // The whole point of #2: with 5 priors a raw count gives only 0/20/…/100.
    const history = [0, 1, 2, 3, 4];
    const scores = [0.5, 1.5, 2.5, 3.5].map((value) => percentile(value, history));
    expect(scores).toEqual([12.5, 37.5, 62.5, 87.5]);
    // Every value distinct — a counting implementation would repeat.
    expect(new Set(scores).size).toBe(scores.length);
  });

  test('is monotonic', () => {
    const history = [0, 1, 2, 3, 4];
    const scores = [0, 0.3, 1.1, 2.7, 3.9, 4].map((value) => percentile(value, history));
    expect([...scores].sort((a, b) => a - b)).toEqual(scores);
  });

  test('a clip matching an entirely flat history is typical, not worst', () => {
    // Previously returned 0, which rendered as "worst" for an average clip.
    expect(percentile(2, [2, 2, 2, 2])).toBe(50);
    expect(percentile(3, [2, 2, 2, 2])).toBe(100);
    expect(percentile(1, [2, 2, 2, 2])).toBe(0);
  });

  test('is 0 on empty history rather than dividing by zero', () => {
    expect(percentile(1, [])).toBe(0);
  });
});

describe('composite', () => {
  test('weights only the three defensible axes', () => {
    expect(composite(bands({ visual: 1, audio: 1, language: 1 }))).toBeCloseTo(1);
    // A BETA axis must not move the headline number at all.
    expect(composite(bands({ emotional: 100, memorability: 100 }))).toBe(0);
  });
});

describe('confidence', () => {
  test('needs both history depth and clip length — neither alone is enough', () => {
    expect(confidence(20, 20)).toBe(1);
    expect(confidence(100, 2)).toBeCloseTo(0.1); // long history, 2-segment clip
    expect(confidence(2, 100)).toBeCloseTo(0.1); // long clip, 2 prior analyses
    expect(confidence(0, 0)).toBe(0);
  });
});

describe('scoreAnalysis cold start', () => {
  test('returns nulls and no axis rows below the history threshold', () => {
    const scored = scoreAnalysis({
      bands: bands({ visual: 1 }),
      history: ladder(MIN_HISTORY - 1),
      nSegments: 40,
      hasSpeech: true,
    });

    expect(scored.resonanceScore).toBeNull();
    expect(scored.percentileInChannel).toBeNull();
    expect(scored.confidence).toBeNull();
    // A sentinel 0 would render as a zero-length "Visual attention" bar, which
    // reads as bad rather than unknown.
    expect(scored.axisRows).toEqual([]);
  });

  test('turns on exactly at the threshold', () => {
    const scored = scoreAnalysis({
      bands: bands({ visual: 99, audio: 99, language: 99 }),
      history: ladder(MIN_HISTORY),
      nSegments: 40,
      hasSpeech: true,
    });

    expect(scored.resonanceScore).toBe(100);
    expect(scored.axisRows).toHaveLength(5);
  });
});

describe('scoreAnalysis', () => {
  test('score and percentile are the same number in two presentations', () => {
    const scored = scoreAnalysis({
      bands: bands({ visual: 5, audio: 5, language: 5 }),
      history: ladder(10),
      nSegments: 40,
      hasSpeech: true,
    });

    // Value 5 against priors 0..9 sits 5/9 of the way along the observed range.
    expect(scored.percentileInChannel).toBeCloseTo((5 / 9) * 100);
    expect(scored.resonanceScore).toBe(Math.round(scored.percentileInChannel as number));
    // The property that matters: one rank, two presentations — never two numbers.
    expect(scored.resonanceScore).toBe(56);
  });

  test('emits axes in position order matching the enum', () => {
    const scored = scoreAnalysis({
      bands: bands(),
      history: ladder(10),
      nSegments: 40,
      hasSpeech: true,
    });

    expect(scored.axisRows.map((row) => row.axis)).toEqual([
      ResonanceAxis.VISUAL_ATTENTION,
      ResonanceAxis.AUDIO_ENGAGEMENT,
      ResonanceAxis.CLARITY,
      ResonanceAxis.EMOTIONAL_PULL,
      ResonanceAxis.MEMORABILITY,
    ]);
    expect(scored.axisRows.map((row) => row.position)).toEqual([0, 1, 2, 3, 4]);
  });

  test('ranks each axis independently, not off the composite', () => {
    // Top of the range on visual, bottom on audio.
    const history = Array.from({ length: 10 }, (_, index) =>
      bands({ visual: index, audio: index }),
    );
    const scored = scoreAnalysis({
      bands: bands({ visual: 99, audio: -99 }),
      history,
      nSegments: 40,
      hasSpeech: true,
    });

    expect(scored.axisRows[0]?.score).toBe(100);
    expect(scored.axisRows[1]?.score).toBe(0);
  });

  test('downgrades CLARITY to BETA when the clip has no speech', () => {
    const withSpeech = scoreAnalysis({
      bands: bands(),
      history: ladder(10),
      nSegments: 40,
      hasSpeech: true,
    });
    const silent = scoreAnalysis({
      bands: bands(),
      history: ladder(10),
      nSegments: 40,
      hasSpeech: false,
    });

    expect(withSpeech.axisRows[2]?.confidence).toBe(AxisConfidence.MEDIUM);
    expect(silent.axisRows[2]?.confidence).toBe(AxisConfidence.BETA);
    // The two STABLE axes are unaffected by the transcript.
    expect(silent.axisRows[0]?.confidence).toBe(AxisConfidence.STABLE);
    expect(silent.axisRows[1]?.confidence).toBe(AxisConfidence.STABLE);
  });

  test('keeps the two proxy axes labelled BETA regardless of their score', () => {
    const scored = scoreAnalysis({
      bands: bands({ emotional: 999, memorability: 999 }),
      history: ladder(10),
      nSegments: 40,
      hasSpeech: true,
    });

    expect(scored.axisRows[3]?.confidence).toBe(AxisConfidence.BETA);
    expect(scored.axisRows[4]?.confidence).toBe(AxisConfidence.BETA);
  });
});
