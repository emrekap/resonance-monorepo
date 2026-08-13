import { describe, expect, test } from 'bun:test';
import type { AxisBands } from '@repo/queue';

import { BAND_SUMMARY, COMPOSITE_WEIGHTS, band, composite } from './composite.ts';

const bands = (visual: number, audio: number, language: number): AxisBands => ({
  visual: { mean: 0, std: 0, peak: visual },
  audio: { mean: 0, std: 0, peak: audio },
  language: { mean: 0, std: 0, peak: language },
  emotional: { mean: 0, std: 0, peak: 9 },
  memorability: { mean: 0, std: 0, peak: 9 },
});

describe('composite', () => {
  test('reads the chosen statistic, not the mean', () => {
    expect(BAND_SUMMARY).toBe('peak');
    expect(band(bands(0.5, 0, 0), 'visual')).toBe(0.5);
  });

  test('weights visual/audio/language and ignores the BETA axes', () => {
    // EMOTIONAL_PULL and MEMORABILITY are cortical shadows of subcortical
    // structures fsaverage5 does not contain — a BETA axis must not move the
    // number on the front of the screen. Both are 9 above, so a composite that
    // included them could not land on this value.
    expect(composite(bands(1, 1, 1))).toBeCloseTo(1, 10);
    expect(composite(bands(1, 0, 0))).toBeCloseTo(0.4, 10);
    expect(composite(bands(0, 1, 0))).toBeCloseTo(0.35, 10);
    expect(composite(bands(0, 0, 1))).toBeCloseTo(0.25, 10);
  });

  test('the weights sum to one, so the composite stays in band units', () => {
    const total = Object.values(COMPOSITE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });
});
