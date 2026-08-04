import { palettes, radius, space, type } from './tokens';

export type ColorScheme = 'light' | 'dark';
export type ThemePreference = 'auto' | ColorScheme;

// `(typeof palettes)['dark']` alone would fix `Palette` to dark's literal hex
// values, so `buildTheme('light').colors.canvas` (in reality `'#F6F5FA'`)
// wouldn't type as assignable to it. Values are `string`; only the key set —
// identical across schemes by construction — needs to be exact.
export type Palette = { [K in keyof (typeof palettes)['dark']]: string };
export type ColorToken = keyof Palette;
export type TypeVariant = keyof typeof type;
export type SpaceToken = keyof typeof space;
export type RadiusToken = keyof typeof radius;

export interface Theme {
  scheme: ColorScheme;
  colors: Palette;
  space: typeof space;
  radius: typeof radius;
  type: typeof type;
}

/**
 * The whole preference model, as one pure function. `system` is whatever
 * `useColorScheme()` reports, which is `null` before the OS answers — treated
 * as light so the first paint is deterministic.
 */
export function resolveScheme(
  preference: ThemePreference,
  system: ColorScheme | null | undefined,
): ColorScheme {
  if (preference !== 'auto') return preference;
  return system === 'dark' ? 'dark' : 'light';
}

export function buildTheme(scheme: ColorScheme): Theme {
  return { scheme, colors: palettes[scheme], space, radius, type };
}
