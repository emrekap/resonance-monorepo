/**
 * Ultraviolet — the Resonance design tokens.
 *
 * Token *names* are identical across schemes; values are not. Contrast does not
 * survive inversion, so `accent` is a darker violet in light mode. See
 * `tokens.test.ts`, which fails if a future edit breaks WCAG AA.
 *
 * `accent` and `accentSurface` are two tokens because they cannot be one. On a
 * #0A0A0C canvas, clearing 4.5:1 against the canvas needs luminance >= 0.1889,
 * while carrying white text at 4.5:1 needs <= 0.1833 — there is no violet that
 * does both. So `accent` is the on-canvas colour (text, bands, the bloom) and
 * `accentSurface` is the filled-button colour that `onAccent` sits on. In light
 * mode one value satisfies both, and they are deliberately identical.
 *
 * The same conflict recurs for `accentSubtle`: in dark mode there is no single
 * lightness that is both distinguishable from `canvas` and dark enough for
 * `accent` text at AA, so `onAccentSubtle` is a dedicated text token for that
 * pairing.
 */
export const palettes = {
  dark: {
    canvas: '#0A0A0C',
    surface: '#16161A',
    surfaceElevated: '#1E1D24',
    border: '#26252E',
    borderStrong: '#35343E',
    text: '#FFFFFF',
    textSecondary: '#A3A0B0',
    textMuted: '#6E6B7D',
    accent: '#7C5CFF',
    accentSurface: '#6D4AFF',
    accentSurfacePressed: '#5B34E0',
    accentMuted: '#6D55C4',
    accentSubtle: '#241E42',
    onAccentSubtle: '#A78BFF',
    onAccent: '#FFFFFF',
    bandTrack: '#1F1E26',
    bandNeutral: '#3B3B47',
    success: '#4ADE80',
    warning: '#FBBF24',
    danger: '#FF6369',
  },
  light: {
    canvas: '#F6F5FA',
    surface: '#FFFFFF',
    surfaceElevated: '#FFFFFF',
    border: '#E7E5F0',
    borderStrong: '#D5D2E2',
    text: '#12111A',
    textSecondary: '#6B6880',
    textMuted: '#8A87A0',
    accent: '#6338E8',
    accentSurface: '#6338E8',
    accentSurfacePressed: '#5227D6',
    accentMuted: '#9A85E8',
    accentSubtle: '#EFEBFD',
    onAccentSubtle: '#6338E8',
    onAccent: '#FFFFFF',
    bandTrack: '#E7E5F0',
    bandNeutral: '#C6C3D4',
    success: '#15803D',
    warning: '#B45309',
    danger: '#DC2626',
  },
} as const;

/** 4-based, with the 2px hairline step the old scale lacked. */
export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
  xxxl: 64,
} as const;

/** `lg` is the card. `pill` is every action — Ultraviolet's shape rule. */
export const radius = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 18,
  xl: 26,
  pill: 999,
} as const;

/**
 * System typeface throughout. SF Pro Display at 700 with tight tracking carries
 * the score; `tabular` keeps digits from reflowing as the number animates.
 */
export const type = {
  display: { fontSize: 64, lineHeight: 55, fontWeight: 700, letterSpacing: -3.5, tabular: true },
  title: { fontSize: 28, lineHeight: 34, fontWeight: 700, letterSpacing: -0.6, tabular: false },
  heading: { fontSize: 20, lineHeight: 26, fontWeight: 600, letterSpacing: -0.2, tabular: false },
  body: { fontSize: 16, lineHeight: 24, fontWeight: 400, letterSpacing: 0, tabular: false },
  bodyStrong: { fontSize: 16, lineHeight: 24, fontWeight: 600, letterSpacing: 0, tabular: false },
  label: { fontSize: 14, lineHeight: 20, fontWeight: 500, letterSpacing: 0, tabular: false },
  labelStrong: { fontSize: 14, lineHeight: 20, fontWeight: 600, letterSpacing: 0, tabular: false },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: 400, letterSpacing: 0, tabular: false },
  eyebrow: { fontSize: 11, lineHeight: 12, fontWeight: 600, letterSpacing: 1.5, tabular: false },
  mono: { fontSize: 13, lineHeight: 18, fontWeight: 400, letterSpacing: 0, tabular: true },
} as const;
