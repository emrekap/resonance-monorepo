import { describe, expect, test } from 'bun:test';

import fixture from './__fixtures__/analysis-succeeded.json';
import { analysisSucceededSchema, timelineSchema } from './contract.ts';

/**
 * The api↔ml boundary, checked from the TypeScript side.
 *
 * `__fixtures__/analysis-succeeded.json` is produced by **Pydantic**
 * (`apps/ml/tests/test_contract.py` regenerates and diffs it), so this is a real
 * cross-language round trip rather than a TS-to-TS test that would pass no
 * matter how far the two halves drifted.
 *
 * The failure this is built to catch: Pydantic serialises an unset field as
 * `null`, and `.optional()` accepts only `undefined`. Every TS-to-TS test passes
 * and the first real job fails. Hence `.nullish()` throughout the contract — and
 * hence a fixture that actually contains nulls.
 */
describe('analysis.succeeded — the Pydantic payload', () => {
  test('parses as emitted by apps/ml', () => {
    const parsed = analysisSucceededSchema.parse(fixture);
    expect(parsed.analysisId).toBe(fixture.analysisId);
    expect(parsed.timeline.startSec).toHaveLength(3);
    expect(parsed.axisBands?.visual).toBeCloseTo(0.19);
  });

  test('carries all five timeline arrays at equal length', () => {
    const { timeline } = analysisSucceededSchema.parse(fixture);
    const lengths = [
      timeline.startSec.length,
      timeline.attention.length,
      timeline.visual?.length,
      timeline.audio?.length,
      timeline.language?.length,
    ];
    // `analysis_results_timeline_len_chk` rejects a row where these disagree,
    // and it would do so on every retry.
    expect(new Set(lengths).size).toBe(1);
  });

  test('keeps the transcript row-aligned with the curve, silent segments included', () => {
    const parsed = analysisSucceededSchema.parse(fixture);
    expect(parsed.transcript).toHaveLength(parsed.timeline.startSec.length);
    expect(parsed.transcript?.map((entry) => entry.startSec)).toEqual(parsed.timeline.startSec);
    // A dropped silent segment would slide every later caption onto the wrong moment.
    expect(parsed.transcript?.some((entry) => entry.text === '')).toBe(true);
  });

  test('accepts null for the fields Pydantic leaves unset', () => {
    // This is the exact shape a `None` on the Python side serialises to.
    const parsed = analysisSucceededSchema.parse({
      ...fixture,
      durationSec: null,
      transcript: null,
      axisBands: null,
      timeline: { ...fixture.timeline, visual: null, audio: null, language: null },
    });
    expect(parsed.axisBands).toBeNull();
    expect(parsed.timeline.visual).toBeNull();
  });

  test('rejects a payload missing a required field', () => {
    const { durationMs: _dropped, ...incomplete } = fixture;
    expect(() => analysisSucceededSchema.parse(incomplete)).toThrow();
  });

  test('rejects a partially-typed band array', () => {
    expect(() =>
      timelineSchema.parse({
        startSec: [0],
        attention: [0],
        visual: ['not a number'],
      }),
    ).toThrow();
  });
});
