import { describe, expect, test } from 'bun:test';
import { RecommendationKind } from '@repo/db/enums';
import type { Timeline } from '@repo/queue';

import { findMarkers, validate, type ModelRecommendations } from './insights';

/**
 * The validation layer is the whole safety story for the one non-deterministic
 * step in the pipeline, so it is tested against output a model plausibly
 * produces — wrong timestamps, too many notes, repeated notes — rather than
 * against the happy path only. No test here makes a network call.
 */

const raw = (items: ModelRecommendations['recommendations']): ModelRecommendations => ({
  recommendations: items,
});

describe('validate', () => {
  test('assigns priority from array order, never from the model', () => {
    const out = validate(
      raw([
        { kind: RecommendationKind.HOOK, message: 'first' },
        { kind: RecommendationKind.AUDIO, message: 'second' },
      ]),
      30,
    );
    expect(out.map((item) => item.priority)).toEqual([0, 1]);
  });

  test('strips timestamps outside the clip but keeps the note', () => {
    const out = validate(
      raw([
        { kind: RecommendationKind.TRIM, message: 'after the end', targetStartSec: 99 },
        { kind: RecommendationKind.HOOK, message: 'negative', targetStartSec: -4 },
      ]),
      30,
    );
    // The advice may still be sound; only the anchor was wrong.
    expect(out).toHaveLength(2);
    expect(out[0]?.targetStartSec).toBeNull();
    expect(out[1]?.targetStartSec).toBeNull();
  });

  test('keeps in-range timestamps and swaps a reversed pair', () => {
    const out = validate(
      raw([
        { kind: RecommendationKind.TRIM, message: 'trim', targetStartSec: 9, targetStopSec: 3 },
      ]),
      30,
    );
    expect(out[0]?.targetStartSec).toBe(3);
    expect(out[0]?.targetStopSec).toBe(9);
  });

  test('rejects non-finite timestamps', () => {
    const out = validate(
      raw([
        { kind: RecommendationKind.PACING, message: 'nan', targetStartSec: Number.NaN },
        {
          kind: RecommendationKind.LENGTH,
          message: 'inf',
          targetStartSec: Number.POSITIVE_INFINITY,
        },
      ]),
      30,
    );
    expect(out[0]?.targetStartSec).toBeNull();
    expect(out[1]?.targetStartSec).toBeNull();
  });

  test('truncates an over-long message', () => {
    const out = validate(raw([{ kind: RecommendationKind.CLARITY, message: 'x'.repeat(500) }]), 30);
    expect(out[0]?.message).toHaveLength(200);
  });

  test('drops a note that is only whitespace', () => {
    const out = validate(raw([{ kind: RecommendationKind.HOOK, message: '   ' }]), 30);
    expect(out).toEqual([]);
  });

  test('caps the list at four', () => {
    const out = validate(
      raw(
        Array.from({ length: 9 }, (_, index) => ({
          kind: RecommendationKind.PACING,
          message: `note ${index}`,
          targetStartSec: index,
        })),
      ),
      30,
    );
    expect(out).toHaveLength(4);
  });

  test('dedupes the same kind at the same moment but keeps it at different ones', () => {
    const out = validate(
      raw([
        { kind: RecommendationKind.TRIM, message: 'trim here', targetStartSec: 4 },
        { kind: RecommendationKind.TRIM, message: 'trim here again', targetStartSec: 4 },
        { kind: RecommendationKind.TRIM, message: 'trim there', targetStartSec: 12 },
      ]),
      30,
    );
    expect(out).toHaveLength(2);
    expect(out.map((item) => item.targetStartSec)).toEqual([4, 12]);
  });

  test('a boundary timestamp of exactly 0 or the duration is in range', () => {
    const out = validate(
      raw([
        { kind: RecommendationKind.HOOK, message: 'start', targetStartSec: 0 },
        { kind: RecommendationKind.LENGTH, message: 'end', targetStartSec: 30 },
      ]),
      30,
    );
    expect(out[0]?.targetStartSec).toBe(0);
    expect(out[1]?.targetStartSec).toBe(30);
  });
});

describe('findMarkers', () => {
  const timeline = (attention: number[]): Timeline => ({
    startSec: attention.map((_, index) => index),
    attention,
    visual: attention,
    audio: attention,
    language: attention,
  });

  test('finds the peaks and dips a creator would point at', () => {
    const markers = findMarkers(timeline([0, 9, 0, -9, 0, 8, 0, -8, 0]));
    const peaks = markers.filter((marker) => marker.kind === 'peak').map((m) => m.startSec);
    const dips = markers.filter((marker) => marker.kind === 'dip').map((m) => m.startSec);
    expect(peaks).toEqual([1, 5]);
    expect(dips).toEqual([3, 7]);
  });

  test('spaces markers out so one broad dip does not take every slot', () => {
    // Three adjacent near-identical lows; only one should survive the gap rule.
    const markers = findMarkers(timeline([5, 5, 5, -9, -8.9, -8.8, 5, 5, -1]), 2);
    const dips = markers.filter((marker) => marker.kind === 'dip');
    expect(dips).toHaveLength(2);
    expect(Math.abs((dips[0]?.startSec ?? 0) - (dips[1]?.startSec ?? 0))).toBeGreaterThanOrEqual(2);
  });

  test('returns nothing for a curve too short to have shape', () => {
    expect(findMarkers(timeline([]))).toEqual([]);
    expect(findMarkers(timeline([1]))).toEqual([]);
  });

  test('is ordered by time, not by magnitude', () => {
    const markers = findMarkers(timeline([0, -9, 0, 0, 9, 0]));
    const times = markers.map((marker) => marker.startSec);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});
