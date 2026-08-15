import { describe, expect, test } from 'bun:test';

import {
  FALLBACK_N_DAYS,
  PHASE2_MIN_OBSERVATIONS,
  chooseMaturation,
  type GainByAge,
} from './maturation.ts';

const gain = (ageDays: number, medianGain: number, observations = 500): GainByAge => ({
  ageDays,
  medianGain,
  observations,
});

/** Growth that flattens below the threshold from day 11 onward. */
const FLATTENS_AT_11: GainByAge[] = [
  gain(7, 0.4),
  gain(8, 0.22),
  gain(9, 0.1),
  gain(10, 0.05),
  gain(11, 0.015),
  gain(12, 0.01),
];

describe('phase 1', () => {
  test('uses the fallback while the corpus is younger than 29 days', () => {
    // The fallback is not a placeholder to be deleted — it is the value used
    // whenever the query cannot answer, so a fresh environment is never blocked
    // on four weeks of history.
    expect(chooseMaturation({ corpusAgeDays: 3, gains: FLATTENS_AT_11 })).toEqual({
      nDays: FALLBACK_N_DAYS,
      phase: 1,
    });
    expect(chooseMaturation({ corpusAgeDays: 28, gains: FLATTENS_AT_11 })).toEqual({
      nDays: FALLBACK_N_DAYS,
      phase: 1,
    });
  });
});

describe('phase 2', () => {
  test('takes the smallest age at which growth has flattened', () => {
    expect(chooseMaturation({ corpusAgeDays: 60, gains: FLATTENS_AT_11 })).toEqual({
      nDays: 11,
      phase: 2,
    });
  });

  test('ignores an age with too few observations to have a median', () => {
    const thin = [gain(8, 0.001, PHASE2_MIN_OBSERVATIONS - 1), ...FLATTENS_AT_11];
    expect(chooseMaturation({ corpusAgeDays: 60, gains: thin }).nDays).toBe(11);
  });

  test('ignores ages outside the searched range', () => {
    const early = [gain(2, 0.0), ...FLATTENS_AT_11];
    expect(chooseMaturation({ corpusAgeDays: 60, gains: early }).nDays).toBe(11);
  });

  test('falls back, and says PHASE 1, when nothing has flattened', () => {
    // The phase is reported honestly: a run using the fallback must never claim
    // phase 2, or the manifest would say the parameter was measured when it was
    // assumed.
    const stillGrowing = [gain(7, 0.5), gain(14, 0.3), gain(28, 0.2)];
    expect(chooseMaturation({ corpusAgeDays: 60, gains: stillGrowing })).toEqual({
      nDays: FALLBACK_N_DAYS,
      phase: 1,
    });
  });

  test('falls back on an empty result set', () => {
    expect(chooseMaturation({ corpusAgeDays: 60, gains: [] })).toEqual({
      nDays: FALLBACK_N_DAYS,
      phase: 1,
    });
  });
});
