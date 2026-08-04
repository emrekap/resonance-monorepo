# Ultraviolet Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Expo starter's ad-hoc styling in `apps/mobile` with a token layer, a primitive layer, and a user-selectable auto/light/dark theme.

**Architecture:** A pure-data token module (`src/design/tokens.ts`) feeds a `Theme` object built per colour scheme. A context provider resolves the user's stored preference against the OS scheme and drives four consumers: the token object, expo-router's navigation theme, the status bar, and the root system background. Primitives in `src/components/ui/` expose `variant`/`tone` props typed against the tokens, so screens hold layout only.

**Tech Stack:** Expo SDK 57, React Native 0.86, TypeScript 6.0, `bun test`, `@react-native-async-storage/async-storage` (already a dependency), `react-native-svg` (added in Task 8).

## Global Constraints

- **Package manager is Bun.** Run scripts as `bun run --cwd=/Users/emre/Desktop/files/resonance-monorepo/apps/mobile <script>` from the repo root. Do not `cd` — a stale working directory silently rescopes `turbo`.
- **Path alias:** `@/*` → `./src/*` (`apps/mobile/tsconfig.json`).
- **ESLint stays on 9.x, TypeScript at or below 6.0.** See `packages/eslint-config/README.md`. Do not bump either.
- **Formatting is prettier's job.** Run `bunx prettier --write` on specific paths only — a bare `bun run format` rewrites the whole repo.
- **Prisma enums, if ever needed in mobile, import from `@repo/db/enums`,** never the `@repo/db` barrel.
- **`textMuted` does not meet WCAG AA on the light canvas (3.2:1).** It is for large text, disabled states, and decorative labels only. The type system enforces this in Task 4; the contrast test exempts it explicitly in Task 1.
- **Verification is `bun run --cwd=<mobile> test`, `turbo run lint`, `turbo run typecheck`.** Report failures as observed; never assert a pass without running it.
- **Commit only what the task names.** Do not `git add -A`.

## File Structure

| File                             | Responsibility                                                           |
| -------------------------------- | ------------------------------------------------------------------------ |
| `src/design/tokens.ts`           | Pure data: two palettes, space, radius, type scale. No imports.          |
| `src/design/theme.ts`            | `Theme` type, `buildTheme(scheme)`, `resolveScheme(preference, system)`. |
| `src/design/theme-provider.tsx`  | Preference persistence, context, `useTheme` / `useThemePreference`.      |
| `src/design/index.ts`            | Barrel.                                                                  |
| `src/design/contrast.ts`         | WCAG relative-luminance maths, used only by tests.                       |
| `src/design/tokens.test.ts`      | Contrast assertions over both palettes.                                  |
| `src/design/theme.test.ts`       | `resolveScheme` truth table.                                             |
| `src/components/ui/*.tsx`        | Primitives — one file each.                                              |
| `src/components/ui/index.ts`     | Barrel.                                                                  |
| `scripts/generate-design-doc.ts` | Emits `DESIGN.md` from tokens.                                           |

---

### Task 1: Tokens, theme maths, and the tests that guard them

**Files:**

- Create: `apps/mobile/src/design/tokens.ts`
- Create: `apps/mobile/src/design/theme.ts`
- Create: `apps/mobile/src/design/contrast.ts`
- Test: `apps/mobile/src/design/tokens.test.ts`
- Test: `apps/mobile/src/design/theme.test.ts`
- Modify: `apps/mobile/package.json` (add `test` script)
- Modify: `turbo.json` (add `test` task)

**Interfaces:**

- Consumes: nothing.
- Produces: `palettes`, `space`, `radius`, `type` from `tokens.ts`; `Theme`, `ColorScheme`, `ThemePreference`, `ColorToken`, `TypeVariant`, `buildTheme(scheme: ColorScheme): Theme`, `resolveScheme(preference: ThemePreference, system: ColorScheme | null | undefined): ColorScheme` from `theme.ts`; `contrastRatio(a: string, b: string): number` from `contrast.ts`.

- [ ] **Step 1: Write `contrast.ts`**

This is real WCAG maths, needed by the test in Step 3.

```ts
/** sRGB channel (0–255) to linear light, per WCAG 2.1 relative luminance. */
function channelToLinear(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of a `#rrggbb` colour. */
export function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!match?.[1]) throw new Error(`Expected a #rrggbb colour, got: ${hex}`);
  const int = parseInt(match[1], 16);
  const r = channelToLinear((int >> 16) & 0xff);
  const g = channelToLinear((int >> 8) & 0xff);
  const b = channelToLinear(int & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two `#rrggbb` colours. Ranges 1–21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [lighter, darker] = la > lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}
```

- [ ] **Step 2: Write `tokens.ts`**

Every value is copied from the approved spec. No RN imports — this file must stay loadable by `bun test`.

```ts
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
    accentSubtle: '#1A1630',
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
    onAccent: '#FFFFFF',
    bandTrack: '#E7E5F0',
    bandNeutral: '#C6C3D4',
    success: '#16A34A',
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
```

- [ ] **Step 3: Write the failing contrast test**

```ts
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
```

- [ ] **Step 4: Write the failing resolver test**

```ts
import { describe, expect, test } from 'bun:test';

import { buildTheme, resolveScheme } from './theme';

describe('resolveScheme', () => {
  test('an explicit preference ignores the system scheme', () => {
    expect(resolveScheme('dark', 'light')).toBe('dark');
    expect(resolveScheme('light', 'dark')).toBe('light');
  });

  test('auto follows the system scheme', () => {
    expect(resolveScheme('auto', 'dark')).toBe('dark');
    expect(resolveScheme('auto', 'light')).toBe('light');
  });

  test('auto falls back to light when the system scheme is unknown', () => {
    expect(resolveScheme('auto', null)).toBe('light');
    expect(resolveScheme('auto', undefined)).toBe('light');
  });
});

describe('buildTheme', () => {
  test('carries the scheme and its palette', () => {
    expect(buildTheme('dark').colors.canvas).toBe('#0A0A0C');
    expect(buildTheme('light').colors.canvas).toBe('#F6F5FA');
    expect(buildTheme('dark').scheme).toBe('dark');
  });

  test('shares scheme-independent scales', () => {
    expect(buildTheme('dark').space).toBe(buildTheme('light').space);
  });
});
```

- [ ] **Step 5: Run both tests and verify they fail**

Run: `bun run --cwd=/Users/emre/Desktop/files/resonance-monorepo/apps/mobile test`

Expected: FAIL — `theme.test.ts` cannot resolve `./theme`. `tokens.test.ts` should already pass, since Steps 1–2 wrote its dependencies; that is fine and expected.

- [ ] **Step 6: Write `theme.ts`**

```ts
import { palettes, radius, space, type } from './tokens';

export type ColorScheme = 'light' | 'dark';
export type ThemePreference = 'auto' | ColorScheme;

export type Palette = (typeof palettes)['dark'];
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
```

- [ ] **Step 7: Add the `test` script and Turbo task**

In `apps/mobile/package.json`, add to `scripts` (keep keys alphabetical among the existing ones):

```json
"test": "bun test"
```

In `turbo.json`, add to `tasks`, after `"lint"`:

```json
"test": {
  "dependsOn": ["^build"]
},
```

- [ ] **Step 8: Run the tests and verify they pass**

Run: `bun run --cwd=/Users/emre/Desktop/files/resonance-monorepo/apps/mobile test`
Expected: PASS — 17 tests, 0 fail.

Then run: `bunx turbo --cwd /Users/emre/Desktop/files/resonance-monorepo run lint typecheck test`
Expected: all tasks successful.

> If `dark.accent` fails at 4.5:1, that is not a flaky test. `#7C5CFF` on `#0A0A0C` measures 4.55:1 — genuinely close to the floor. Do not lower the threshold; lighten the accent and re-run.

- [ ] **Step 9: Commit**

```bash
git add apps/mobile/src/design apps/mobile/package.json turbo.json
git commit -m "feat(mobile): add Ultraviolet design tokens with contrast tests"
```

---

### Task 2: Theme provider and root wiring

**Files:**

- Create: `apps/mobile/src/design/theme-provider.tsx`
- Create: `apps/mobile/src/design/index.ts`
- Modify: `apps/mobile/src/app/_layout.tsx`

**Interfaces:**

- Consumes: `Theme`, `ColorScheme`, `ThemePreference`, `buildTheme`, `resolveScheme` (Task 1).
- Produces: `<ThemeProvider>`, `useTheme(): Theme`, `useThemePreference(): { preference, scheme, setPreference, isReady }`. Everything downstream imports from `@/design`.

- [ ] **Step 1: Write `theme-provider.tsx`**

```tsx
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';
import { useColorScheme } from 'react-native';

import {
  buildTheme,
  resolveScheme,
  type ColorScheme,
  type Theme,
  type ThemePreference,
} from './theme';

const STORAGE_KEY = 'resonance.theme-preference';

function isPreference(value: string | null): value is ThemePreference {
  return value === 'auto' || value === 'light' || value === 'dark';
}

interface ThemeContextValue {
  theme: Theme;
  preference: ThemePreference;
  scheme: ColorScheme;
  setPreference: (next: ThemePreference) => void;
  /** False until the stored preference has been read. */
  isReady: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Owns the theme preference and resolves it against the OS scheme.
 *
 * `isReady` exists because the AsyncStorage read is async: without gating the
 * splash on it, the app paints in the OS scheme and then snaps to the user's
 * override. The root layout holds the splash until this is true.
 */
export function ThemeProvider({ children }: PropsWithChildren) {
  const system = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>('auto');
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (isPreference(stored)) setPreferenceState(stored);
      })
      .catch(() => {
        // An unreadable preference is the same as not having one.
      })
      .finally(() => {
        setIsReady(true);
      });
  }, []);

  const value = useMemo<ThemeContextValue>(() => {
    const scheme = resolveScheme(preference, system);
    return {
      theme: buildTheme(scheme),
      preference,
      scheme,
      isReady,
      setPreference: (next) => {
        setPreferenceState(next);
        // Persisting is not worth blocking the UI on, and a failed write only
        // costs the preference on next launch.
        void AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
      },
    };
  }, [preference, system, isReady]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

function useThemeContext(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside <ThemeProvider>');
  return value;
}

export function useTheme(): Theme {
  return useThemeContext().theme;
}

export function useThemePreference() {
  const { preference, scheme, setPreference, isReady } = useThemeContext();
  return { preference, scheme, setPreference, isReady };
}
```

- [ ] **Step 2: Write the barrel `index.ts`**

```ts
export * from './theme';
export * from './theme-provider';
export { palettes, radius, space, type } from './tokens';
```

- [ ] **Step 3: Rewrite `_layout.tsx`**

Replace the whole file. The four consumers of the resolved scheme are the token object, the navigation theme, the status bar, and the root system background.

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Linking from 'expo-linking';
import {
  DarkTheme,
  DefaultTheme,
  Stack,
  ThemeProvider as NavigationThemeProvider,
} from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useMemo } from 'react';

import { ThemeProvider, useTheme, useThemePreference } from '@/design';
import { createSessionFromUrl } from '@/lib/auth';
import { SessionProvider, useSession } from '@/providers/session-provider';

void SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function RootNavigator() {
  const { session, isLoading } = useSession();
  const { isReady: themeReady, scheme } = useThemePreference();
  const theme = useTheme();

  // Fallback for OAuth redirects that arrive as a plain deep link instead of
  // through `openAuthSessionAsync` (cold starts, some Android browsers).
  // URLs without a `?code=` — like the connect-account returns — resolve to
  // null inside, and a code the in-flow handler already exchanged just throws
  // into this catch.
  const url = Linking.useURL();
  useEffect(() => {
    if (url) createSessionFromUrl(url).catch(() => {});
  }, [url]);

  const ready = !isLoading && themeReady;

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  // Without this the window behind the navigator stays the platform default,
  // which flashes white during screen transitions in dark mode.
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(theme.colors.canvas);
  }, [theme.colors.canvas]);

  // React Navigation owns header/card chrome, so it needs the same palette.
  // `fonts` is required by its Theme type and has no Ultraviolet equivalent.
  const navigationTheme = useMemo(() => {
    const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      dark: scheme === 'dark',
      colors: {
        ...base.colors,
        primary: theme.colors.accent,
        background: theme.colors.canvas,
        card: theme.colors.surface,
        text: theme.colors.text,
        border: theme.colors.border,
        notification: theme.colors.danger,
      },
    };
  }, [scheme, theme]);

  // Keep the splash up rather than flashing onboarding at a signed-in user,
  // or the wrong theme at anyone.
  if (!ready) return null;

  return (
    <NavigationThemeProvider value={navigationTheme}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Protected guard={session !== null}>
          <Stack.Screen name="(app)" />
        </Stack.Protected>
        <Stack.Protected guard={session === null}>
          <Stack.Screen name="(onboarding)" />
        </Stack.Protected>
      </Stack>
      {/* Explicit, not "auto": auto follows the OS and would be wrong the
          moment a user overrides the theme. */}
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
    </NavigationThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <RootNavigator />
        </SessionProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
```

- [ ] **Step 4: Verify it compiles and still lints**

Run: `bunx turbo --cwd /Users/emre/Desktop/files/resonance-monorepo run lint typecheck`
Expected: all successful. The old `@/hooks/use-theme` still exists and still compiles; it is deleted in Task 6.

- [ ] **Step 5: Run the app and confirm the theme switch works end to end**

Run: `bun run --cwd=/Users/emre/Desktop/files/resonance-monorepo/apps/mobile start`

Toggle the simulator between light and dark appearance. The canvas behind the navigator must follow, with no white flash on transitions. There is no settings UI yet — that is Task 7. Report what you observe, including any flash.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/design apps/mobile/src/app/_layout.tsx
git commit -m "feat(mobile): add theme provider with persisted auto/light/dark preference"
```

---

### Task 3: `Text`, `Surface`, and `Screen`

**Files:**

- Create: `apps/mobile/src/components/ui/text.tsx`
- Create: `apps/mobile/src/components/ui/surface.tsx`
- Create: `apps/mobile/src/components/ui/screen.tsx`
- Create: `apps/mobile/src/components/ui/index.ts`

**Interfaces:**

- Consumes: `useTheme` (Task 2), `TypeVariant` (Task 1).
- Produces: `<Text variant tone>`, `<Surface tone>`, `<Screen scroll padded>`, and the `@/components/ui` barrel that Tasks 4–8 import from.

- [ ] **Step 1: Write `text.tsx`**

The `tone`/`variant` pairing is a discriminated union on purpose: it makes the documented `textMuted` accessibility rule a compile error rather than a comment nobody reads.

```tsx
import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { useTheme, type TypeVariant } from '@/design';

/** Tones safe for body copy — every one clears WCAG AA on its canvas. */
export type TextTone = 'default' | 'secondary' | 'accent' | 'danger' | 'success' | 'onAccent';

/** Variants large or incidental enough to carry the sub-AA `textMuted`. */
type MutedSafeVariant = 'display' | 'title' | 'caption' | 'eyebrow';

type ToneProps =
  { tone?: TextTone; variant?: TypeVariant } | { tone: 'muted'; variant: MutedSafeVariant };

export type TextProps = Omit<RNTextProps, 'style'> & ToneProps & { style?: RNTextProps['style'] };

export function Text({ variant = 'body', tone = 'default', style, ...rest }: TextProps) {
  const theme = useTheme();
  const scale = theme.type[variant];

  const color = {
    default: theme.colors.text,
    secondary: theme.colors.textSecondary,
    muted: theme.colors.textMuted,
    accent: theme.colors.accent,
    danger: theme.colors.danger,
    success: theme.colors.success,
    onAccent: theme.colors.onAccent,
  }[tone];

  return (
    <RNText
      style={[
        {
          color,
          fontSize: scale.fontSize,
          lineHeight: scale.lineHeight,
          fontWeight: scale.fontWeight,
          letterSpacing: scale.letterSpacing,
        },
        scale.tabular ? { fontVariant: ['tabular-nums' as const] } : null,
        variant === 'eyebrow' ? { textTransform: 'uppercase' as const } : null,
        style,
      ]}
      {...rest}
    />
  );
}
```

- [ ] **Step 2: Write `surface.tsx`**

```tsx
import { View, type ViewProps } from 'react-native';

import { useTheme } from '@/design';

export type SurfaceTone = 'canvas' | 'surface' | 'elevated';

export interface SurfaceProps extends ViewProps {
  tone?: SurfaceTone;
}

/** A background. Surface colour always comes from the theme — that is the one rule. */
export function Surface({ tone = 'canvas', style, ...rest }: SurfaceProps) {
  const theme = useTheme();
  const backgroundColor = {
    canvas: theme.colors.canvas,
    surface: theme.colors.surface,
    elevated: theme.colors.surfaceElevated,
  }[tone];

  return <View style={[{ backgroundColor }, style]} {...rest} />;
}
```

- [ ] **Step 3: Write `screen.tsx`**

```tsx
import { ScrollView, View, type ViewProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/design';

export interface ScreenProps extends ViewProps {
  /** Wraps content in a ScrollView. Use for anything that can overflow. */
  scroll?: boolean;
  /** Applies the standard screen gutter. Turn off for edge-to-edge content. */
  padded?: boolean;
}

/**
 * The outermost element of every screen. Exists because each screen was
 * re-deriving `{ flex: 1, padding, gap }` and drifting while doing it.
 */
export function Screen({ scroll, padded = true, style, children, ...rest }: ScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const layout = {
    paddingTop: insets.top,
    paddingBottom: insets.bottom,
    paddingHorizontal: padded ? theme.space.lg : 0,
    gap: theme.space.lg,
  };

  if (scroll) {
    return (
      <ScrollView
        style={[{ flex: 1, backgroundColor: theme.colors.canvas }, style]}
        contentContainerStyle={layout}
        {...rest}
      >
        {children}
      </ScrollView>
    );
  }

  return (
    <View style={[{ flex: 1, backgroundColor: theme.colors.canvas }, layout, style]} {...rest}>
      {children}
    </View>
  );
}
```

- [ ] **Step 4: Write the barrel `index.ts`**

Tasks 4 and 8 append to this file.

```ts
export * from './screen';
export * from './surface';
export * from './text';
```

- [ ] **Step 5: Verify**

Run: `bunx turbo --cwd /Users/emre/Desktop/files/resonance-monorepo run lint typecheck`
Expected: all successful. Nothing consumes these yet.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/components/ui
git commit -m "feat(mobile): add Text, Surface and Screen primitives"
```

---

### Task 4: `Card`, `Button`, `Meter`, `Badge`

**Files:**

- Create: `apps/mobile/src/components/ui/card.tsx`
- Create: `apps/mobile/src/components/ui/button.tsx`
- Create: `apps/mobile/src/components/ui/meter.tsx`
- Create: `apps/mobile/src/components/ui/badge.tsx`
- Modify: `apps/mobile/src/components/ui/index.ts`

**Interfaces:**

- Consumes: `useTheme` (Task 2), `Text` (Task 3).
- Produces: `<Card padding>`, `<Button label variant size icon busy fullWidth onPress>`, `<Meter value tone>`, `<Badge label tone>`.

- [ ] **Step 1: Write `card.tsx`**

```tsx
import { View, type ViewProps } from 'react-native';

import { useTheme } from '@/design';

export interface CardProps extends ViewProps {
  padding?: 'none' | 'base' | 'lg';
}

export function Card({ padding = 'base', style, ...rest }: CardProps) {
  const theme = useTheme();
  const pad = { none: 0, base: theme.space.base, lg: theme.space.lg }[padding];

  return (
    <View
      style={[
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: theme.radius.lg,
          padding: pad,
          gap: theme.space.sm,
        },
        style,
      ]}
      {...rest}
    />
  );
}
```

- [ ] **Step 2: Write `button.tsx`**

Preserves the existing `Button`'s API (`label`, `variant`, `size`, `icon`, `busy`, `fullWidth`) so the migration in Task 5 is a swap, not a rewrite.

```tsx
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { Text } from '@/components/ui/text';
import { useTheme } from '@/design';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ComponentProps<typeof Ionicons>['name'];
  /** Shows a spinner and blocks presses, keeping the label for context. */
  busy?: boolean;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Button({
  label,
  variant = 'primary',
  size = 'md',
  icon,
  busy,
  disabled,
  fullWidth,
  style,
  ...rest
}: ButtonProps) {
  const theme = useTheme();
  const blocked = Boolean(disabled) || Boolean(busy);

  const palette = {
    // `accentSurface`, not `accent` — a filled button carries white text, and
    // the on-canvas accent is too light to do that at AA. See tokens.ts.
    primary: {
      background: theme.colors.accentSurface,
      pressed: theme.colors.accentSurfacePressed,
      border: 'transparent',
      tone: 'onAccent' as const,
    },
    secondary: {
      background: theme.colors.surface,
      pressed: theme.colors.surfaceElevated,
      border: theme.colors.border,
      tone: 'default' as const,
    },
    ghost: {
      background: 'transparent',
      pressed: theme.colors.surface,
      border: 'transparent',
      tone: 'default' as const,
    },
    danger: {
      background: 'transparent',
      pressed: theme.colors.surface,
      border: 'transparent',
      tone: 'danger' as const,
    },
  }[variant];

  // 40/48/56 keep every target at or above platform touch guidance.
  const metrics = {
    sm: { minHeight: 40, paddingHorizontal: theme.space.base, iconSize: 16 },
    md: { minHeight: 48, paddingHorizontal: theme.space.lg, iconSize: 20 },
    lg: { minHeight: 56, paddingHorizontal: theme.space.xl, iconSize: 22 },
  }[size];

  const textColor = {
    onAccent: theme.colors.onAccent,
    default: theme.colors.text,
    danger: theme.colors.danger,
  }[palette.tone];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: blocked, busy: Boolean(busy) }}
      disabled={blocked}
      hitSlop={size === 'sm' ? theme.space.sm : undefined}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: theme.space.sm,
          borderRadius: theme.radius.pill,
          borderWidth: palette.border === 'transparent' ? 0 : 1,
          borderColor: palette.border,
          minHeight: metrics.minHeight,
          paddingHorizontal: metrics.paddingHorizontal,
          backgroundColor: pressed && !blocked ? palette.pressed : palette.background,
          opacity: blocked && !busy ? 0.5 : 1,
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
        },
        style,
      ]}
      {...rest}
    >
      {busy ? (
        <ActivityIndicator size="small" color={textColor} />
      ) : icon ? (
        <Ionicons name={icon} size={metrics.iconSize} color={textColor} />
      ) : null}
      <Text
        variant={size === 'sm' ? 'labelStrong' : 'bodyStrong'}
        tone={palette.tone}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}
```

- [ ] **Step 3: Write `meter.tsx`**

One component serves both upload progress and the network bands.

```tsx
import { View } from 'react-native';

import { useTheme } from '@/design';

export interface MeterProps {
  /** 0–1. Values outside the range are clamped. */
  value: number;
  /** `accent` for the network that fired or an active upload; `neutral` for the rest. */
  tone?: 'accent' | 'accentMuted' | 'neutral';
  /** Accessible name. Omit only when an adjacent label already names it. */
  label?: string;
}

export function Meter({ value, tone = 'accent', label }: MeterProps) {
  const theme = useTheme();
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);

  const fill = {
    accent: theme.colors.accent,
    accentMuted: theme.colors.accentMuted,
    neutral: theme.colors.bandNeutral,
  }[tone];

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: pct }}
      style={{
        height: 7,
        borderRadius: theme.radius.pill,
        backgroundColor: theme.colors.bandTrack,
        overflow: 'hidden',
      }}
    >
      <View style={{ height: '100%', width: `${pct}%`, backgroundColor: fill }} />
    </View>
  );
}
```

- [ ] **Step 4: Write `badge.tsx`**

```tsx
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useTheme } from '@/design';

export interface BadgeProps {
  label: string;
  tone?: 'accent' | 'neutral' | 'success' | 'danger';
}

export function Badge({ label, tone = 'accent' }: BadgeProps) {
  const theme = useTheme();

  const background = {
    accent: theme.colors.accentSubtle,
    neutral: theme.colors.surface,
    success: theme.colors.surface,
    danger: theme.colors.surface,
  }[tone];

  const textTone = {
    accent: 'accent',
    neutral: 'secondary',
    success: 'success',
    danger: 'danger',
  }[tone] as 'accent' | 'secondary' | 'success' | 'danger';

  return (
    <View
      style={{
        alignSelf: 'flex-start',
        backgroundColor: background,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: theme.radius.pill,
        paddingHorizontal: theme.space.md,
        paddingVertical: theme.space.xs,
      }}
    >
      <Text variant="caption" tone={textTone}>
        {label}
      </Text>
    </View>
  );
}
```

- [ ] **Step 5: Extend the barrel**

Replace `apps/mobile/src/components/ui/index.ts` with:

```ts
export * from './badge';
export * from './button';
export * from './card';
export * from './meter';
export * from './screen';
export * from './surface';
export * from './text';
```

- [ ] **Step 6: Verify**

Run: `bunx turbo --cwd /Users/emre/Desktop/files/resonance-monorepo run lint typecheck`
Expected: all successful.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/components/ui
git commit -m "feat(mobile): add Card, Button, Meter and Badge primitives"
```

---

### Task 5: Migrate the six screens and the two composites

**Files:**

- Modify: `apps/mobile/src/app/(app)/index.tsx`
- Modify: `apps/mobile/src/app/(app)/accounts.tsx`
- Modify: `apps/mobile/src/app/(app)/analysis/[id].tsx`
- Modify: `apps/mobile/src/app/(onboarding)/index.tsx`
- Modify: `apps/mobile/src/app/(onboarding)/sign-in.tsx`
- Modify: `apps/mobile/src/app/(onboarding)/sign-up.tsx`
- Modify: `apps/mobile/src/components/social-button.tsx`
- Modify: `apps/mobile/src/components/social-auth-panel.tsx`

**Interfaces:**

- Consumes: every primitive from `@/components/ui` (Tasks 3–4), `useTheme` (Task 2).
- Produces: no new exports. `social-button.tsx` and `social-auth-panel.tsx` keep their current prop signatures exactly.

- [ ] **Step 1: Migrate one screen and establish the pattern**

Start with `(app)/index.tsx`. The transformation, applied to every file in this task:

- `<ThemedView style={styles.root}>` → `<Screen>`
- `<ThemedText type="subtitle">` → `<Text variant="title">`; `type="default"` → `variant="body"`; `type="small"` → `variant="label"`; `type="smallBold"` → `variant="labelStrong"`
- `themeColor="textSecondary"` → `tone="secondary"`; `themeColor="danger"` → `tone="danger"`
- `import { Card } from '@/components/card'` → `import { Card } from '@/components/ui'`
- `<ProgressBar progress={x} />` → `<Meter value={x} label="Upload progress" />`
- Delete every `StyleSheet.create` entry that sets a colour, `borderRadius`, or a font property. Keep only layout: `flex`, `gap`, `alignItems`, `marginTop`, and similar.
- Replace `Spacing.three` etc. with `theme.space.*` where a local style still needs a value.

Preserve all behaviour, including the `void` annotations added earlier — `onPress={() => void analysis.start('video')}` stays exactly as it is.

- [ ] **Step 2: Verify the first screen before continuing**

Run: `bunx turbo --cwd /Users/emre/Desktop/files/resonance-monorepo run lint typecheck`
Expected: all successful.

Then run the app and confirm the home screen renders in both schemes with no visual regression beyond the intended restyle. If the pattern above turns out wrong for this codebase, fix it here before repeating it seven more times.

- [ ] **Step 3: Migrate the remaining five screens**

Apply the identical transformation to `(app)/accounts.tsx`, `(app)/analysis/[id].tsx`, `(onboarding)/index.tsx`, `(onboarding)/sign-in.tsx`, `(onboarding)/sign-up.tsx`.

Two specifics: `accounts.tsx` uses `theme.success` / `theme.warning` / `theme.danger` in a status-colour map — those become `theme.colors.*` and stay. `(onboarding)/index.tsx` has its own `borderRadius: 14`, which becomes `theme.radius.lg` or moves into a `Card`.

- [ ] **Step 4: Migrate the two composites**

`social-button.tsx` and `social-auth-panel.tsx` keep their exported prop types unchanged; only their internals move onto `Text`, `useTheme`, `theme.radius.lg` and `theme.space.*`. `social-button.tsx` currently hardcodes `borderRadius: 14` twice — the outer row becomes `theme.radius.lg`, the round glyph stays `theme.radius.pill`.

- [ ] **Step 5: Verify everything**

Run: `bunx turbo --cwd /Users/emre/Desktop/files/resonance-monorepo run lint typecheck test`
Expected: all successful.

Run the app and walk every screen in light, dark, and after an OS appearance switch. Report anything that looks wrong.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/app apps/mobile/src/components
git commit -m "refactor(mobile): move screens and composites onto design primitives"
```

---

### Task 6: Delete the old styling layer and add the lint rule

This is the task that makes the system enforceable. It comes only after Task 5, because the rule's violations must be gone before the rule exists.

**Files:**

- Delete: `apps/mobile/src/components/themed-text.tsx`
- Delete: `apps/mobile/src/components/themed-view.tsx`
- Delete: `apps/mobile/src/components/card.tsx`
- Delete: `apps/mobile/src/components/button.tsx`
- Delete: `apps/mobile/src/components/progress-bar.tsx`
- Delete: `apps/mobile/src/constants/theme.ts`
- Delete: `apps/mobile/src/hooks/use-theme.ts`
- Modify: `apps/mobile/eslint.config.js`

**Interfaces:**

- Consumes: nothing new.
- Produces: nothing. This task only removes code and adds a rule.

- [ ] **Step 1: Confirm nothing imports the doomed modules**

Run:

```bash
grep -rn "themed-text\|themed-view\|components/card\|components/button\|progress-bar\|constants/theme\|hooks/use-theme" /Users/emre/Desktop/files/resonance-monorepo/apps/mobile/src
```

Expected: no output. If anything is listed, migrate that file first — do not proceed.

- [ ] **Step 2: Delete the files**

```bash
git rm apps/mobile/src/components/themed-text.tsx \
       apps/mobile/src/components/themed-view.tsx \
       apps/mobile/src/components/card.tsx \
       apps/mobile/src/components/button.tsx \
       apps/mobile/src/components/progress-bar.tsx \
       apps/mobile/src/constants/theme.ts \
       apps/mobile/src/hooks/use-theme.ts
```

Note `src/global.css` and `src/types/css.d.ts` stay: `global.css` still supplies the web font variables and is imported by nothing else now that `constants/theme.ts` is gone — if `turbo run typecheck` passes without it, delete it too and say so.

- [ ] **Step 3: Add the rule to `apps/mobile/eslint.config.js`**

```js
import config from '@repo/eslint-config/react-native';

/**
 * The design system's enforcement layer. Colour and radius are decided in
 * `src/design/tokens.ts` and applied by `src/components/ui/*` — everywhere
 * else, a literal is drift. This rule is what caught `#3c87f7` sitting in
 * `themed-text.tsx` ignoring the theme, and five copies of `borderRadius: 14`.
 */
export default [
  ...config,
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/design/**', 'src/components/ui/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^#[0-9a-fA-F]{3,8}$/]',
          message:
            'Colour literals belong in src/design/tokens.ts. Use a theme token via useTheme() or a ui/ primitive.',
        },
        {
          selector: 'Property[key.name="borderRadius"] > Literal',
          message:
            'Radius literals belong in src/design/tokens.ts. Use theme.radius.* or a ui/ primitive.',
        },
      ],
    },
  },
];
```

- [ ] **Step 4: Verify the rule fires, then verify the codebase is clean**

First prove the rule works. Temporarily add `const debugColor = '#ff0000';` to `apps/mobile/src/app/(app)/index.tsx` and run:

Run: `bun run --cwd=/Users/emre/Desktop/files/resonance-monorepo/apps/mobile lint`
Expected: FAIL, with the "Colour literals belong in src/design/tokens.ts" message.

Remove the line, then run again.
Expected: PASS with no errors. A rule that never fires proves nothing.

- [ ] **Step 5: Full verification**

Run: `bunx turbo --cwd /Users/emre/Desktop/files/resonance-monorepo run lint typecheck test`
Expected: all successful.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile
git commit -m "refactor(mobile): delete starter styling layer, enforce tokens via lint"
```

---

### Task 7: Settings screen

**Files:**

- Create: `apps/mobile/src/app/(app)/settings.tsx`
- Modify: `apps/mobile/src/app/(app)/index.tsx`

**Interfaces:**

- Consumes: `useThemePreference` (Task 2), `Screen`/`Card`/`Text`/`Button` (Tasks 3–4).
- Produces: the `/settings` route.

- [ ] **Step 1: Write the settings screen**

```tsx
import { View } from 'react-native';

import { Button, Card, Screen, Text } from '@/components/ui';
import { useThemePreference, type ThemePreference } from '@/design';

const OPTIONS: { value: ThemePreference; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Follow the system appearance' },
  { value: 'light', label: 'Light', hint: 'Always use the light theme' },
  { value: 'dark', label: 'Dark', hint: 'Always use the dark theme' },
];

export default function SettingsScreen() {
  const { preference, setPreference } = useThemePreference();

  return (
    <Screen scroll>
      <Text variant="title">Settings</Text>

      <Card>
        <Text variant="eyebrow" tone="secondary">
          Appearance
        </Text>
        <View style={{ gap: 8 }}>
          {OPTIONS.map((option) => (
            <Button
              key={option.value}
              label={option.label}
              variant={preference === option.value ? 'primary' : 'secondary'}
              fullWidth
              accessibilityState={{ selected: preference === option.value }}
              onPress={() => setPreference(option.value)}
            />
          ))}
        </View>
        <Text variant="caption" tone="secondary">
          {OPTIONS.find((option) => option.value === preference)?.hint}
        </Text>
      </Card>
    </Screen>
  );
}
```

- [ ] **Step 2: Add the entry point from home**

In `(app)/index.tsx`, next to the existing sign-out control, add:

```tsx
<Link href="/settings" asChild>
  <Button label="Settings" variant="ghost" size="sm" icon="settings-outline" />
</Link>
```

`Link` is already imported in that file from `expo-router`.

- [ ] **Step 3: Verify**

Run: `bunx turbo --cwd /Users/emre/Desktop/files/resonance-monorepo run lint typecheck test`
Expected: all successful.

Run the app. Select each of Auto, Light and Dark, confirm the whole app including navigation chrome and status bar follows immediately, then force-quit and relaunch to confirm the choice survived. Confirm Auto still tracks an OS appearance change. Report what you observe.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/app
git commit -m "feat(mobile): add settings screen with auto/light/dark theme control"
```

---

### Task 8: `Score` and `Bloom`

Last, because it is the only task with a native dependency.

**Files:**

- Create: `apps/mobile/src/components/ui/bloom.tsx`
- Create: `apps/mobile/src/components/ui/score.tsx`
- Modify: `apps/mobile/src/components/ui/index.ts`
- Modify: `apps/mobile/src/app/(app)/analysis/[id].tsx`
- Modify: `apps/mobile/package.json` (adds `react-native-svg`)

**Interfaces:**

- Consumes: `useTheme` (Task 2), `Text`, `Badge` (Tasks 3–4).
- Produces: `<Bloom intensity? height?>`, `<Score value max bloom?>`.

- [ ] **Step 1: Install `react-native-svg`**

```bash
bun run --cwd=/Users/emre/Desktop/files/resonance-monorepo/apps/mobile expo install react-native-svg
```

`expo install` picks the version matched to SDK 57 rather than npm `latest`. Then run `bun install` from the repo root to relink the workspace.

> Why not the alternatives: `expo-linear-gradient` exports only `LinearGradient` — no radial. RN 0.86's `experimental_backgroundImage` does support `radial-gradient()`, but the prop is still `experimental_`-prefixed and `react-native-web` does not implement it, so the bloom would vanish on web.

- [ ] **Step 2: Write `bloom.tsx`**

```tsx
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

import { useTheme } from '@/design';

export interface BloomProps {
  /** Peak opacity at the centre. Lower it when the bloom sits behind dense content. */
  intensity?: number;
  height?: number;
}

/**
 * The violet wash behind the score — Ultraviolet's signature.
 *
 * `react-native-svg` rather than RN's `experimental_backgroundImage`, which
 * react-native-web does not implement. This is the only file that imports it.
 */
export function Bloom({ intensity, height = 200 }: BloomProps) {
  const theme = useTheme();
  // Light mode gets a wash, not a glow: at dark-mode strength a violet radial
  // on a near-white canvas reads as a printing defect.
  const peak = intensity ?? (theme.scheme === 'dark' ? 0.5 : 0.16);

  return (
    <Svg
      pointerEvents="none"
      style={{ position: 'absolute', top: -height * 0.3, left: 0, right: 0 }}
      height={height}
      width="100%"
    >
      <Defs>
        <RadialGradient id="bloom" cx="50%" cy="50%" r="70%">
          <Stop offset="0%" stopColor={theme.colors.accent} stopOpacity={peak} />
          <Stop offset="45%" stopColor={theme.colors.accent} stopOpacity={peak * 0.28} />
          <Stop offset="100%" stopColor={theme.colors.accent} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#bloom)" />
    </Svg>
  );
}
```

- [ ] **Step 3: Write `score.tsx`**

The empty state is required, not optional: `resonanceScore` is null for every analysis until calibration lands.

```tsx
import { View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Bloom } from '@/components/ui/bloom';
import { Text } from '@/components/ui/text';
import { useTheme } from '@/design';

export interface ScoreProps {
  /** Null until the calibration behind `resonanceScore` ships. */
  value: number | null;
  max?: number;
  /** Short comparative note, e.g. "Top 20% of your posts". */
  caption?: string;
  bloom?: boolean;
}

export function Score({ value, max = 100, caption, bloom = true }: ScoreProps) {
  const theme = useTheme();

  return (
    <View style={{ paddingVertical: theme.space.lg, overflow: 'hidden' }}>
      {bloom && value !== null ? <Bloom /> : null}
      <Text variant="eyebrow" tone="secondary">
        Resonance score
      </Text>

      {value === null ? (
        <>
          <Text variant="title" tone="secondary" style={{ marginTop: theme.space.sm }}>
            Pending
          </Text>
          <Text variant="caption" tone="secondary" style={{ marginTop: theme.space.xs }}>
            Analysis complete. Scoring is waiting on model calibration.
          </Text>
        </>
      ) : (
        <>
          <Text
            variant="display"
            accessibilityLabel={`Resonance score ${value} out of ${max}`}
            style={{ marginTop: theme.space.sm }}
          >
            {value}
          </Text>
          {caption ? (
            <View style={{ marginTop: theme.space.md }}>
              <Badge label={caption} />
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}
```

- [ ] **Step 4: Extend the barrel**

Add to `apps/mobile/src/components/ui/index.ts`, keeping it alphabetical:

```ts
export * from './bloom';
export * from './score';
```

- [ ] **Step 5: Render it on the analysis screen**

In `(app)/analysis/[id].tsx`, inside the success branch, above the existing status card:

```tsx
<Score value={job.data.resonanceScore ?? null} />
```

If the response field is named differently, use the actual name from the typed RPC response — do not add a cast to make this line compile.

- [ ] **Step 6: Verify**

Run: `bunx turbo --cwd /Users/emre/Desktop/files/resonance-monorepo run lint typecheck test`
Expected: all successful.

Run the app on a device or simulator, open a completed analysis, and confirm: the bloom renders in dark mode, the light-mode wash is subtle rather than a smudge, and the pending state shows because no score exists yet. This is the first on-device use of a new native module — if `react-native-svg` fails to link in Expo Go, say so rather than working around it; the documented fallback is a baked per-theme asset.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): add Score and Bloom with react-native-svg"
```

---

### Task 9: Generate `DESIGN.md` from the tokens

**Files:**

- Create: `apps/mobile/scripts/generate-design-doc.ts`
- Modify: `apps/mobile/package.json` (adds `design:doc` script)
- Replace: `apps/mobile/DESIGN.md`

**Interfaces:**

- Consumes: `palettes`, `space`, `radius`, `type` (Task 1).
- Produces: a regenerable `DESIGN.md`.

- [ ] **Step 1: Write the generator**

`apps/mobile/DESIGN.md` currently holds _Expo's_ marketing design system — hero bands, device mockups, pricing tiers. Generating from `tokens.ts` means the document cannot drift from the code.

```ts
/**
 * Emits apps/mobile/DESIGN.md from the design tokens.
 *
 * Generated, not hand-written: a design document that drifts from the code is
 * worse than none, because agents and humans both trust it.
 *
 * Run: bun run design:doc
 */
import { palettes, radius, space, type } from '../src/design/tokens';

const scalarBlock = (record: Record<string, number>) =>
  Object.entries(record)
    .map(([key, value]) => `  ${key}: ${value}`)
    .join('\n');

const colorBlock = (scheme: 'dark' | 'light') =>
  Object.entries(palettes[scheme])
    .map(([key, value]) => `    ${key}: "${value}"`)
    .join('\n');

const typeBlock = Object.entries(type)
  .map(([key, style]) =>
    [
      `  ${key}:`,
      `    fontSize: ${style.fontSize}`,
      `    lineHeight: ${style.lineHeight}`,
      `    fontWeight: ${style.fontWeight}`,
      `    letterSpacing: ${style.letterSpacing}`,
      `    tabular: ${String(style.tabular)}`,
    ].join('\n'),
  )
  .join('\n');

const doc = `---
name: Resonance
description: >-
  Ultraviolet — the Resonance mobile design system. A neutral near-black canvas,
  a white numeral carrying the resonance score, a violet bloom behind it, and
  colour spent almost entirely on the one brain network that actually fired.
  Light mode ("Paper") turns the bloom into a faint violet wash at the top edge.
  System typeface throughout, tabular figures on every number, pill geometry on
  every action.

colors:
  dark:
${colorBlock('dark')}
  light:
${colorBlock('light')}

typography:
${typeBlock}

rounded:
${scalarBlock(radius)}

spacing:
${scalarBlock(space)}
---

## Overview

Ultraviolet is a single-voltage system. Violet is the only chromatic colour, and
it is spent on exactly three things: the primary action, the network that fired,
and the bloom. Everything else is a graded neutral.

That restraint is a product constraint, not a taste: Resonance screens always sit
next to the creator's own thumbnails, and a high-chroma palette loses that fight.
Seven categorical hues across the Yeo networks would also imply seven categories
a creator has to learn, whereas one lit band says *this one fired*.

## Accessibility

Every foreground clears WCAG AA against its canvas except \`textMuted\`, which
measures 3.2:1 in light mode and is restricted to large text, disabled states and
decorative labels. The \`Text\` primitive enforces this in its type signature, and
\`src/design/tokens.test.ts\` fails if a palette edit breaks any of the ratios.

## Do not hand-edit

This file is generated from \`src/design/tokens.ts\` by
\`scripts/generate-design-doc.ts\`. Change the tokens and run \`bun run design:doc\`.
`;

await Bun.write(new URL('../DESIGN.md', import.meta.url), doc);
console.log('✓ DESIGN.md regenerated from tokens');
```

- [ ] **Step 2: Add the script**

In `apps/mobile/package.json` `scripts`:

```json
"design:doc": "bun run scripts/generate-design-doc.ts"
```

- [ ] **Step 3: Generate and inspect**

Run: `bun run --cwd=/Users/emre/Desktop/files/resonance-monorepo/apps/mobile design:doc`
Expected: `✓ DESIGN.md regenerated from tokens`.

Open `apps/mobile/DESIGN.md` and confirm it describes Resonance, not Expo, and that the colour values match `tokens.ts`.

- [ ] **Step 4: Format and verify**

Run:

```bash
bunx prettier --write /Users/emre/Desktop/files/resonance-monorepo/apps/mobile/DESIGN.md
bunx turbo --cwd /Users/emre/Desktop/files/resonance-monorepo run lint typecheck test
```

Expected: all successful.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/DESIGN.md apps/mobile/scripts apps/mobile/package.json
git commit -m "docs(mobile): generate DESIGN.md from design tokens"
```

---

## Done criteria

- `bunx turbo --cwd <repo> run lint typecheck test` passes.
- The app runs in Auto, Light and Dark; the choice survives a relaunch; Auto tracks OS changes.
- No colour or radius literal exists under `apps/mobile/src` outside `src/design/` and `src/components/ui/` — enforced by lint, verified by deliberately introducing one and watching it fail.
- `apps/mobile/DESIGN.md` describes Resonance and is regenerable.

## Deliberately not in this plan

- **A `NetworkBands` composite.** `Meter` covers the primitive need. The timeline bands are null until Yeo-7 parcellation ships; a composite built now would be designed against imagination.
- **The Aurora ramp.** Held for the future scrubbable timeline, where seven simultaneously distinguishable series genuinely are needed. One palette for identity, one for data.
- **A `packages/ui`.** `apps/web` does not exist. `DESIGN.md` is the portable artifact until it does.
- **Component-level testing.** Only the pure logic — the resolver and the contrast maths — is tested.
