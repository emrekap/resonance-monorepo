import { describe, expect, test } from 'bun:test';

import { pollJobDataSchema, resolveRunAt, utcDayStart } from './jobs.ts';
import { SCHEDULES } from './queues.ts';

describe('resolveRunAt', () => {
  test('quantises the wall clock to the UTC day', () => {
    const at = resolveRunAt({}, new Date('2026-08-12T03:00:00.000Z'));
    expect(at.toISOString()).toBe('2026-08-12T00:00:00.000Z');
  });

  test('a retry minutes later lands on the same capturedAt', () => {
    // This IS the idempotency property. `@@unique([postId, capturedAt])` only
    // absorbs a retry if the retry computes the same key — so the value must
    // not come from the instant the handler happens to run.
    const first = resolveRunAt({}, new Date('2026-08-12T03:00:00.000Z'));
    const retry = resolveRunAt({}, new Date('2026-08-12T03:04:12.000Z'));
    expect(retry.toISOString()).toBe(first.toISOString());
  });

  test('honours an explicit runAt, for a manual backfill of one day', () => {
    const at = resolveRunAt({ runAt: '2026-07-01T00:00:00.000Z' }, new Date());
    expect(at.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  test('rejects a malformed runAt rather than silently using today', () => {
    expect(() => resolveRunAt({ runAt: 'yesterday' }, new Date())).toThrow();
  });

  test('accepts an absent payload — the scheduler sends none', () => {
    expect(() => pollJobDataSchema.parse({})).not.toThrow();
    expect(resolveRunAt(undefined, new Date('2026-08-12T23:59:59Z')).toISOString()).toBe(
      '2026-08-12T00:00:00.000Z',
    );
  });
});

describe('utcDayStart', () => {
  test('is idempotent and ignores local time', () => {
    const at = new Date('2026-08-12T23:30:00.000Z');
    expect(utcDayStart(utcDayStart(at)).toISOString()).toBe('2026-08-12T00:00:00.000Z');
  });
});

describe('the schedules', () => {
  test('poll daily, sweep nightly, readiness weekly', () => {
    expect(SCHEDULES.poll).toBe('0 3 * * *');
    expect(SCHEDULES.sweep).toBe('0 4 * * *');
    // Monday. The readiness report is meant to be read at the start of a week,
    // not to arrive mid-Friday and wait until Monday to be looked at.
    expect(SCHEDULES.readiness).toBe('0 5 * * 1');
  });

  test('the sweep runs after the poll, so a refreshed row is never swept', () => {
    const hour = (cron: string) => Number(cron.split(' ')[1]);
    expect(hour(SCHEDULES.sweep)).toBeGreaterThan(hour(SCHEDULES.poll));
  });
});
