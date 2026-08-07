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

/** Shortest angle between two hues on the colour wheel, 0–180°. */
function hueDistance(a: string, b: string): number {
  const hue = (hex: string): number => {
    const [r, g, blue] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
      number,
      number,
      number,
    ];
    const max = Math.max(r, g, blue);
    const chroma = max - Math.min(r, g, blue);
    if (chroma === 0) return 0;
    const raw =
      max === r
        ? ((g - blue) / chroma) % 6
        : max === g
          ? (blue - r) / chroma + 2
          : (r - g) / chroma + 4;
    return (raw * 60 + 360) % 360;
  };

  const delta = Math.abs(hue(a) - hue(b));
  return Math.min(delta, 360 - delta);
}

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

    test(`${scheme}.onAccentSubtle clears 4.5:1 on accentSubtle`, () => {
      expect(contrastRatio(palette.onAccentSubtle, palette.accentSubtle)).toBeGreaterThanOrEqual(
        4.5,
      );
    });

    test(`${scheme}.success clears 4.5:1 on surface`, () => {
      expect(contrastRatio(palette.success, palette.surface)).toBeGreaterThanOrEqual(4.5);
    });

    test(`${scheme}.danger clears 4.5:1 on surface`, () => {
      expect(contrastRatio(palette.danger, palette.surface)).toBeGreaterThanOrEqual(4.5);
    });

    // The timeline curves are non-text graphics, so 3:1 is the bar — but they
    // are also the only thing distinguishing three overlapping lines, which is
    // why they are asserted rather than eyeballed.
    for (const token of ['bandVisual', 'bandAudio', 'bandLanguage'] as const) {
      test(`${scheme}.${token} clears 3:1 on canvas`, () => {
        expect(contrastRatio(palette[token], palette.canvas)).toBeGreaterThanOrEqual(3);
      });
    }

    // Separation between the three curves is a *hue* property, not a contrast
    // one: contrastRatio compares luminance, and two colours can be equally
    // bright yet obviously different (teal against amber). Asserting contrast
    // here would measure the wrong thing and fail on a correct palette.
    test(`${scheme} band colours are separated by hue`, () => {
      const pairs = [
        ['bandVisual', 'bandAudio'],
        ['bandVisual', 'bandLanguage'],
        ['bandAudio', 'bandLanguage'],
      ] as const;
      for (const [a, b] of pairs) {
        expect(hueDistance(palette[a], palette[b])).toBeGreaterThanOrEqual(60);
      }
    });
  }
});
