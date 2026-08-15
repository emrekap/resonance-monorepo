import { describe, expect, test } from 'bun:test';

import { parseIsoDuration } from './duration.ts';

describe('parseIsoDuration', () => {
  test('reads the shapes YouTube actually returns', () => {
    expect(parseIsoDuration('PT29S')).toBe(29);
    expect(parseIsoDuration('PT1M')).toBe(60);
    expect(parseIsoDuration('PT1M2S')).toBe(62);
    expect(parseIsoDuration('PT1H1M1S')).toBe(3661);
    expect(parseIsoDuration('PT8M12S')).toBe(492);
  });

  test('returns 0 for the P0D a live broadcast reports', () => {
    // Not null: the string parsed fine and genuinely says "no duration". The
    // caller excludes it as `not_a_clip`, which is a different fact from
    // "we could not read this".
    expect(parseIsoDuration('P0D')).toBe(0);
  });

  test('returns null for anything it cannot read', () => {
    expect(parseIsoDuration(null)).toBeNull();
    expect(parseIsoDuration('')).toBeNull();
    expect(parseIsoDuration('29 seconds')).toBeNull();
  });
});
