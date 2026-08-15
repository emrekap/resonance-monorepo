import { describe, expect, test } from 'bun:test';

import { TEXT_RETENTION_DAYS, isTextExpired, sweepText, textCutoff } from './sweep.ts';

const NOW = new Date('2026-08-12T04:00:00.000Z');
const daysBefore = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe('the clock', () => {
  test('the cutoff is 30 days back', () => {
    expect(textCutoff(NOW).toISOString()).toBe(daysBefore(TEXT_RETENTION_DAYS).toISOString());
  });

  test('a row the poller refreshed is not expired', () => {
    // The poller refreshes on its own cadence, so the sweep is a backstop for
    // abandoned rows rather than the primary mechanism (spec §6).
    expect(isTextExpired(daysBefore(1), NOW)).toBe(false);
    expect(isTextExpired(daysBefore(29), NOW)).toBe(false);
  });

  test('a row untouched for over 30 days is expired', () => {
    expect(isTextExpired(daysBefore(31), NOW)).toBe(true);
  });

  test('a row already swept is not swept again', () => {
    // The sweep nulls `textRefreshedAt` along with the text, so a nulled row
    // stops matching. Without that, every sweep rewrites every dead row forever.
    expect(isTextExpired(null, NOW)).toBe(false);
  });
});

describe('sweepText', () => {
  test('nulls posts and channel titles against the same cutoff', async () => {
    const seen: Date[] = [];
    const result = await sweepText({
      now: NOW,
      store: {
        async nullPostText(cutoff) {
          seen.push(cutoff);
          return 7;
        },
        async nullChannelText(cutoff) {
          seen.push(cutoff);
          return 2;
        },
      },
    });

    expect(result).toEqual({ posts: 7, channels: 2 });
    expect(seen.map((d) => d.toISOString())).toEqual([
      textCutoff(NOW).toISOString(),
      textCutoff(NOW).toISOString(),
    ]);
  });
});
