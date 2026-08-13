import { describe, expect, test } from 'bun:test';

import { parseSeeds } from './seeds.ts';

const RATIONALE = 'Posts 3-5 Shorts a week with visibly variable reach; not a repost account.';

const yaml = (channels: string) => `version: 1\nchannels:\n${channels}`;

const entry = (overrides: Record<string, string> = {}) => {
  const fields = {
    id: 'UCabcdefghijklmnopqrstuv',
    handle: '"@example"',
    niche: 'cooking',
    tier: 'mid',
    rationale: `"${RATIONALE}"`,
    ...overrides,
  };
  const [first, ...rest] = Object.entries(fields);
  return (
    `  - ${first![0]}: ${first![1]}\n` + rest.map(([k, v]) => `    ${k}: ${v}`).join('\n') + '\n'
  );
};

describe('parseSeeds', () => {
  test('reads a curated frame', () => {
    const seeds = parseSeeds(yaml(entry()));
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.id).toBe('UCabcdefghijklmnopqrstuv');
    expect(seeds[0]!.tier).toBe('mid');
  });

  test('rejects something that is not a channelId', () => {
    // A handle (`@example`) or a video id here would traverse the wrong
    // playlist and quietly build a frame nobody curated.
    expect(() => parseSeeds(yaml(entry({ id: '"@example"' })))).toThrow();
  });

  test('rejects a duplicated channel', () => {
    // The same creator twice is the same creator's variance counted twice,
    // which inflates every within-creator statistic downstream.
    expect(() => parseSeeds(yaml(entry() + entry()))).toThrow(/duplicate/i);
  });

  test('rejects a rationale too short to be a rationale', () => {
    // Spec §5d requires a one-line reason per channel, and the reason the frame
    // is defensible at all is that each line is real. "good channel" is not.
    expect(() => parseSeeds(yaml(entry({ rationale: '"good channel"' })))).toThrow();
  });

  test('rejects an empty frame with an actionable message', () => {
    expect(() => parseSeeds('version: 1\nchannels: []\n')).toThrow(/curate/i);
  });
});
