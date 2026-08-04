/// <reference types="bun-types/test" />
import { describe, expect, test } from 'bun:test';

import { contrastRatio } from './contrast';
import { palettes } from './tokens';

const SCHEMES = ['dark', 'light'] as const;

/**
 * `textMuted` measures 3.2:1 on the light canvas. That is a documented,
 * deliberate exemption — it is for large text, disabled states and decorative
 * labels only, and the `Text` primitive refuses it for body copy. Every other
 * foreground must clear AA.
 */
const AA_TOKENS = ['text', 'textSecondary', 'accent'] as const;

describe('palette contrast', () => {
  for (const scheme of SCHEMES) {
    const palette = palettes[scheme];

    for (const token of AA_TOKENS) {
      test(`${scheme}.${token} clears 4.5:1 on canvas`, () => {
        expect(contrastRatio(palette[token], palette.canvas)).toBeGreaterThanOrEqual(4.5);
      });
    }

    test(`${scheme}.onAccent clears 4.5:1 on accentSurface`, () => {
      expect(contrastRatio(palette.onAccent, palette.accentSurface)).toBeGreaterThanOrEqual(4.5);
    });

    // 3:1 is the WCAG floor for a UI component boundary, which is what a filled
    // button is against the page. It cannot also clear 4.5:1 — see tokens.ts.
    test(`${scheme}.accentSurface clears 3:1 on canvas`, () => {
      expect(contrastRatio(palette.accentSurface, palette.canvas)).toBeGreaterThanOrEqual(3);
    });

    test(`${scheme}.textMuted is the documented sub-AA exemption`, () => {
      const ratio = contrastRatio(palette.textMuted, palette.canvas);
      expect(ratio).toBeLessThan(4.5);
      expect(ratio).toBeGreaterThanOrEqual(3);
    });
  }
});
