import { describe, expect, test } from 'bun:test';

import { MIN_POSTS_PER_CHANNEL, renderReadiness, summarise } from './readiness.ts';

const GENERATED_AT = new Date('2026-08-17T05:00:00.000Z');

const channel = (name: string, posts: number, ccbyUnder30s: number, maturePosts = posts) => ({
  platformChannelId: `UC${name.padEnd(22, 'x')}`,
  title: name,
  niche: 'cooking',
  posts,
  ccbyUnder30s,
  maturePosts,
});

const input = {
  generatedAt: GENERATED_AT,
  maturation: { nDays: 14, phase: 1 as const },
  channels: [channel('alpha', 42, 30), channel('beta', 41, 3), channel('gamma', 12, 12)],
  exclusions: {
    duration_over_max_limit: 118,
    not_public: 4,
    not_a_clip: 2,
    missing_published_at: 0,
  },
};

describe('summarise', () => {
  test('counts the channels clearing the >=20-post floor', () => {
    const readiness = summarise(input);
    expect(readiness.totals.channels).toBe(3);
    expect(readiness.totals.posts).toBe(95);
    expect(readiness.totals.clearingFloor).toBe(2);
  });

  test('counts the CC-BY floor separately — that is the §7 number', () => {
    // Whether the deferred source-file question has a licence-based answer is
    // exactly "how many channels have >=20 CC-BY Shorts under 30 s", and it is
    // NOT the same count as the overall floor: beta clears one and not the other.
    expect(summarise(input).totals.ccbyClearingFloor).toBe(1);
    expect(MIN_POSTS_PER_CHANNEL).toBe(20);
  });
});

describe('renderReadiness', () => {
  const report = renderReadiness(summarise(input));

  test('names the maturation value AND its phase', () => {
    // Two runs at different floors are silently incomparable unless the phase
    // is visible — the label itself changed meaning between them.
    expect(report).toContain('N = 14 days');
    expect(report).toContain('phase 1');
  });

  test('states exclusions by reason', () => {
    expect(report).toContain('duration_over_max_limit');
    expect(report).toContain('118');
  });

  test('states both floors, so the §7 decision is a standing number', () => {
    expect(report).toMatch(/2\s*\/\s*3 channels/);
    expect(report).toMatch(/1\s*\/\s*3 channels/);
  });

  test('is a plain Markdown document with a dated title', () => {
    expect(report.split('\n')[0]).toBe('# Corpus readiness — 2026-08-17');
  });
});
