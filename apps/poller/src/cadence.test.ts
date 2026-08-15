import { describe, expect, test } from 'bun:test';

import { DAILY_WINDOW_DAYS, isDue, pollIntervalDays, utcDaysBetween } from './cadence.ts';

const at = (iso: string) => new Date(iso);
const RUN = at('2026-08-12T03:00:00Z');
const days = (n: number) => new Date(RUN.getTime() - n * 86_400_000);

describe('utcDaysBetween', () => {
  test('counts whole UTC days', () => {
    expect(utcDaysBetween(at('2026-08-11T23:00:00Z'), at('2026-08-12T03:00:00Z'))).toBe(0);
    expect(utcDaysBetween(at('2026-08-11T01:00:00Z'), at('2026-08-12T03:00:00Z'))).toBe(1);
    expect(utcDaysBetween(at('2026-07-13T03:00:00Z'), at('2026-08-12T03:00:00Z'))).toBe(30);
  });
});

describe('pollIntervalDays', () => {
  test('is daily inside the first 14 days and weekly after', () => {
    expect(pollIntervalDays(days(0), RUN)).toBe(1);
    expect(pollIntervalDays(days(13), RUN)).toBe(1);
    // Exactly at the boundary the post is 14 days old — the daily window has
    // closed. Stated as a test because "the first 14 days" is ambiguous prose.
    expect(pollIntervalDays(days(DAILY_WINDOW_DAYS), RUN)).toBe(7);
    expect(pollIntervalDays(days(40), RUN)).toBe(7);
  });
});

describe('isDue', () => {
  test('a post never snapshotted is always due', () => {
    expect(isDue({ firstSeenAt: days(0), lastSnapshotAt: null }, RUN)).toBe(true);
    expect(isDue({ firstSeenAt: days(200), lastSnapshotAt: null }, RUN)).toBe(true);
  });

  test('a post snapshotted today is not due again', () => {
    // The daily job runs at a fixed hour, but a retry or a manual run must not
    // append a second observation for the same day.
    expect(isDue({ firstSeenAt: days(3), lastSnapshotAt: days(0) }, RUN)).toBe(false);
  });

  test('inside the daily window, yesterday is due', () => {
    expect(isDue({ firstSeenAt: days(3), lastSnapshotAt: days(1) }, RUN)).toBe(true);
  });

  test('outside it, three days old is not due but seven is', () => {
    expect(isDue({ firstSeenAt: days(40), lastSnapshotAt: days(3) }, RUN)).toBe(false);
    expect(isDue({ firstSeenAt: days(40), lastSnapshotAt: days(7) }, RUN)).toBe(true);
  });
});
