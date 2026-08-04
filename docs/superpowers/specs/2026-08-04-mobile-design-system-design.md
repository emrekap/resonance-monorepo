# Mobile design system — "Ultraviolet"

**Date:** 2026-08-04
**Scope:** `apps/mobile`
**Status:** design approved, ready for implementation planning

## Problem

`apps/mobile` inherited the Expo starter's styling: an ad-hoc `Colors` map, a `Spacing` scale whose
names carry no meaning (`Spacing.three === 16`), no radius tokens at all, and eight font sizes
hardcoded inside `ThemedText`. Screens hand-roll `StyleSheet.create` per file.

The drift is already measurable:

| Value                    | Where                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `borderRadius: 14`       | `card.tsx`, `social-button.tsx` (×2), `(app)/accounts.tsx`, `(onboarding)/index.tsx` |
| `borderRadius: 12` / `3` | `button.tsx` / `progress-bar.tsx`                                                    |
| `color: '#3c87f7'`       | `themed-text.tsx:66` — bypasses the theme, so it is wrong in dark mode today         |
| 8 font sizes             | hardcoded in `themed-text.tsx`                                                       |
| missing `12` and `48`    | absent from `Spacing`, so screens improvise                                          |

Two sources of truth for the colour scheme also exist: `_layout.tsx:8` imports `useColorScheme`
from `react-native` while `hooks/use-theme.ts` imports it from `@/hooks/use-color-scheme`.

The app has no visual identity of its own, and no way for a user to choose a theme — only the OS
scheme is honoured.

## Goals

1. A Resonance visual identity ("Ultraviolet"), expressed as tokens.
2. A primitive layer that makes the identity the path of least resistance and off-system values a
   type error.
3. A user-facing theme preference: auto / light / dark.

## Non-goals

- A shared `packages/ui` or `packages/design-tokens`. `apps/web` is not scaffolded; the portable
  artifact is `apps/mobile/DESIGN.md` (below), which can seed web later. Revisit when web exists.
- A styling library. No NativeWind, Unistyles, or Tamagui — see "Mechanism".
- A `NetworkBands` composite. See "Deferred, and why".
- Component-level testing infrastructure. See "Verification".

## Identity — Ultraviolet

Neutral near-black canvas, white numerals, a violet bloom behind the score, and colour spent almost
entirely on the network that actually fired. The seven Yeo networks render as graded neutrals with
the peak lit in `accent` and the runner-up in `accentMuted`, rather than seven categorical hues.

The reasoning behind that restraint: seven categorical hues imply seven categories a creator must
learn, whereas graded neutrals with one lit band says _this one fired_ — the actual message. It
also survives the adjacency constraint that governs this app: Resonance screens always sit next to
the user's own thumbnails, and a high-chroma spectrum loses that fight.

Light mode is "Paper": the bloom becomes a faint violet wash at the top edge, ink carries the
numeral, and violet stays the voltage on the peak band and the primary action. Rejected
alternative: a dark inverted panel carrying the bloom into light mode. It photographs better but
makes "does this screen get a dark panel?" a question every future screen must answer, and
connected-accounts, upload, settings, and history have no hero number to justify one. If that
treatment is wanted later it arrives as an opt-in `tone="inverted"` on the `Score` component, not
as a theme-wide fork.

## Mechanism

React Native `StyleSheet` plus a typed token module. No new styling dependency.

- Matches the code already in the repo.
- Works in Expo Go — every native module currently used (`expo-file-system`, `expo-image-picker`,
  `expo-auth-session`, `expo-web-browser`) is Expo Go-compatible, and Unistyles would have forced a
  custom dev client.
- Survives the `react-native-web` path that `apps/web` will need.
- Typed `variant`/`tone` props recover the ergonomics that utility classes would have provided,
  and unlike `className` strings they are checked against the token set by the compiler.

## Token layer — `src/design/tokens.ts`

Pure data, `as const`, no React imports.

### Colour

Token _names_ are identical across schemes; values are not, because contrast does not survive
inversion.

| Token             | Dark      | Light     | Note                                |
| ----------------- | --------- | --------- | ----------------------------------- |
| `canvas`          | `#0A0A0C` | `#F6F5FA` | both violet-tinted, never pure grey |
| `surface`         | `#16161A` | `#FFFFFF` | cards                               |
| `surfaceElevated` | `#1E1D24` | `#FFFFFF` | sheets, menus                       |
| `border`          | `#26252E` | `#E7E5F0` | hairlines                           |
| `borderStrong`    | `#35343E` | `#D5D2E2` | focus, dividers                     |
| `text`            | `#FFFFFF` | `#12111A` |                                     |
| `textSecondary`   | `#A3A0B0` | `#6B6880` | 7.7:1 / 4.9:1 — both AA             |
| `textMuted`       | `#6E6B7D` | `#8A87A0` | **3.2:1 in light — see below**      |
| `accent`          | `#7C5CFF` | `#6338E8` | 4.6:1 / 6.4:1                       |
| `accentPressed`   | `#6D4AFF` | `#5227D6` |                                     |
| `accentMuted`     | `#6D55C4` | `#9A85E8` | second-rank band                    |
| `accentSubtle`    | `#1A1630` | `#EFEBFD` | pill / chip backgrounds             |
| `onAccent`        | `#FFFFFF` | `#FFFFFF` |                                     |
| `bandTrack`       | `#1F1E26` | `#E7E5F0` | unfilled meter track                |
| `bandNeutral`     | `#3B3B47` | `#C6C3D4` | networks that did not fire          |
| `success`         | `#4ADE80` | `#16A34A` |                                     |
| `warning`         | `#FBBF24` | `#B45309` |                                     |
| `danger`          | `#FF6369` | `#DC2626` |                                     |

`textMuted` measures 3.2:1 on the light canvas and therefore does **not** meet WCAG AA for body
text. This is deliberate and documented rather than silently shipped: three text ranks that all
clear AA on a light canvas is not achievable without the third going nearly as dark as the second.
`textMuted` is for large text, disabled states, and decorative labels only. The primitives do not
offer it as a body-text tone, and the contrast test (below) exempts it explicitly.

### Space

Replaces `Spacing`, whose names meant nothing.

`xxs 2 · xs 4 · sm 8 · md 12 · base 16 · lg 24 · xl 32 · xxl 48 · xxxl 64`

Adds the `12` and `48` steps that screens currently improvise around.

### Radius

New — there are no radius tokens today.

`xs 4 · sm 8 · md 12 · lg 18 · xl 26 · pill 999`

`lg` is the card. `pill` is every action — that is Ultraviolet's shape rule.

### Type

Ten semantic styles replacing the eight ad-hoc `ThemedText` types.

| Style         | Size / line-height | Weight | Notes                                  |
| ------------- | ------------------ | ------ | -------------------------------------- |
| `display`     | 64 / 55            | 700    | the score; letterSpacing −3.5; tabular |
| `title`       | 28 / 34            | 700    |                                        |
| `heading`     | 20 / 26            | 600    |                                        |
| `body`        | 16 / 24            | 400    | was 500 — body should not be medium    |
| `bodyStrong`  | 16 / 24            | 600    |                                        |
| `label`       | 14 / 20            | 500    |                                        |
| `labelStrong` | 14 / 20            | 600    |                                        |
| `caption`     | 12 / 16            | 400    |                                        |
| `eyebrow`     | 11 / 12            | 600    | uppercase, letterSpacing +1.5          |
| `mono`        | 13 / 18            | 400    | tabular figures                        |

**Typeface: system.** SF Pro Display at 700 with tight tracking is strong for numerals, costs no
bundle weight and no font-load flash. `fontVariant: ['tabular-nums']` on `display` and `mono` keeps
the score from jittering as it animates. A custom face can arrive later as a token change without
touching a screen.

## Module layout

```text
src/design/
  tokens.ts           palettes, space, radius, type — pure data, as const
  theme.ts            Theme type + buildTheme(scheme)
  theme-provider.tsx  preference store + useTheme() + useThemePreference()
  index.ts
src/components/ui/    primitives (below)
src/components/       composites — social-button, social-auth-panel
```

The `ui/` split is the boundary: a primitive knows tokens and nothing about Resonance; a composite
knows the product.

## Primitives — `src/components/ui/`

| Primitive | API                                                                                         | Replaces / why                                                    |
| --------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `Text`    | `variant` (10 type styles) · `tone`                                                         | `ThemedText`; removes the `#3c87f7` leak                          |
| `Surface` | `tone: canvas \| surface \| elevated`                                                       | `ThemedView`                                                      |
| `Screen`  | `scroll?` · `padded?`                                                                       | new — every screen re-derives `{flex:1, padding, gap}` today      |
| `Card`    | `padding: none \| base \| lg`                                                               | `Card`, on `radius.lg` instead of `14`                            |
| `Button`  | `variant: primary \| secondary \| ghost \| danger` · `size` · `busy` · `icon` · `fullWidth` | `Button`, on `radius.pill`                                        |
| `Meter`   | `value` · `tone: accent \| neutral`                                                         | absorbs `ProgressBar`; serves upload progress _and_ network bands |
| `Badge`   | `tone: accent \| neutral \| success \| danger`                                              | new — the "▲ Top 20%" chip                                        |
| `Score`   | `value` · `max` · `bloom?`                                                                  | new — the signature numeral, tabular figures                      |
| `Bloom`   | `intensity?`                                                                                | new — the radial wash                                             |

`tone` and `variant` are unions derived from the token object, so reaching for a colour outside the
system is a compile error rather than a review comment.

### Bloom implementation — `react-native-svg`

React Native has no radial-gradient primitive. Three candidates were checked:

- **`expo-linear-gradient`** — rejected. It exports only `LinearGradient` with
  `colors`/`start`/`end`/`locations`/`dither`. No `RadialGradient`, no `type` prop. Its own docs
  point elsewhere for radial.
- **RN's built-in `experimental_backgroundImage`** — rejected. It does support `radial-gradient()`,
  and RN v0.86.0's own tester uses
  `style={{ experimental_backgroundImage: 'radial-gradient(#e66465, #9198e5)' }}`. But the prop is
  still `experimental_`-prefixed in 0.86 and RN's docs advise against production use. The
  disqualifying issue is that `react-native-web` does not implement it
  ([necolas/react-native-web#2787](https://github.com/necolas/react-native-web/issues/2787)), and
  `react-native-web` is a dependency with `apps/web` on the roadmap — the bloom would vanish on web.
- **`react-native-svg`** — chosen. `<RadialGradient>` inside `<Svg>`. Stable, in the Expo SDK so
  `npx expo install` pins the SDK-matched version, renders on native and web.

The dependency stays sealed inside `bloom.tsx`; no other file imports it.

## Theme preference

`type ThemePreference = 'auto' | 'light' | 'dark'`, persisted in AsyncStorage (already a
dependency) under `resonance.theme-preference`.

The resolver is a pure function — `preference === 'auto' ? (systemScheme ?? 'light') : preference`.

`theme-provider.tsx` exposes `useTheme(): Theme` and
`useThemePreference(): { preference, resolved, setPreference }`.

It must drive four things, not one:

1. the `Theme` token object
2. **expo-router's nav theme** — built from our tokens, replacing stock `DarkTheme`/`DefaultTheme`
   at `_layout.tsx:53`
3. **`StatusBar`** — currently `style="auto"`, which follows the OS and therefore goes wrong the
   moment a user overrides
4. **`expo-system-ui` root background** (already a dependency) — otherwise white flashes behind
   screen transitions

It also collapses the two-source bug: after this, `useColorScheme` is read in exactly one place.

**Hydration.** The AsyncStorage read is async, so without a gate the app paints in the OS scheme
and snaps to the override. The splash is already held on `isLoading` from `SessionProvider`
(`_layout.tsx:33`); the theme-preference read joins that gate.

## Migration

**New screen:** `(app)/settings.tsx` — segmented Auto / Light / Dark, plus an entry point from
home. No settings screen exists today.

**Components:**

- `themed-text.tsx`, `themed-view.tsx` — deleted; callers move to `Text` / `Surface`
- `card.tsx`, `button.tsx`, `progress-bar.tsx` — move into `ui/`, rebuilt on tokens
  (`progress-bar` becomes `Meter`)
- `social-button.tsx`, `social-auth-panel.tsx` — keep their role, restyled onto primitives

**Screens** — local `StyleSheet.create` blocks shrink to layout only; all colour, radius, and type
come from primitives:

- `(app)/index.tsx`, `(app)/accounts.tsx`, `(app)/analysis/[id].tsx`
- `(onboarding)/index.tsx`, `(onboarding)/sign-in.tsx`, `(onboarding)/sign-up.tsx`
- `_layout.tsx` — our `ThemeProvider` wraps expo-router's

## Deferred, and why

`resonanceScore` and the `analysis_results` timeline bands are both null today — the Yeo-7
parcellation and the score calibration are open TODOs (see `apps/worker/README.md`).

Consequently:

- `Score` ships with a real empty state — "analysis complete, score pending calibration" — and
  `Bloom` renders neutral until there is a value to key it to.
- **No `NetworkBands` composite.** `Meter` covers the primitive need; the composite should wait
  until real data shapes it. Building it now would be designing against imagination.

Also held in reserve: a cool aqua→violet ramp ("Aurora") for the future scrubbable timeline, where
seven simultaneously-distinguishable series genuinely are needed. One palette for identity, one for
data — so choosing Ultraviolet now costs nothing later.

## Enforcement

Three layers, cheapest first:

1. **Types.** `tokens.ts` is `as const`; `tone`/`variant` props are unions derived from it. This is
   the layer that does most of the work: a colour outside the system is a compile error.
2. **A lint rule.** `no-restricted-syntax` in `apps/mobile/eslint.config.js`, banning hex colour
   literals and numeric `borderRadius:` outside `src/design/**` and `src/components/ui/**`. That
   catches `#3c87f7` and all five stray `borderRadius: 14`s, since after migration only primitives
   set a radius.
3. **Review.** Everything else.

**Status.** `@repo/eslint-config` now exists (added 2026-08-04, see
[`packages/eslint-config/README.md`](../../../packages/eslint-config/README.md)) and all eight
workspaces lint green, so the rule has somewhere to live. It is **not** written yet, deliberately:
the violations it targets are still in the tree, so adding it before the migration would make
`turbo run lint` red for work that has not happened. It lands in step 4 of the implementation
order, once the last screen moves off the old tokens.

An earlier revision of this spec proposed a `bun test` guard instead, on the grounds that ESLint
did not exist in the monorepo. That is no longer true, and a lint rule reports at the violation
site rather than as a test failure listing paths.

## DESIGN.md

`apps/mobile/DESIGN.md` currently holds **Expo's** marketing design system (pulled from shadcn.io):
hero bands, device mockups, pricing tiers, 96px section rhythm, light-only. Those are web-page
components describing another company's brand.

It is replaced by Resonance's own, in the same machine-readable front-matter shape, **generated
from `tokens.ts`** by a `bun run design:doc` script (~60 lines). Generating rather than
hand-writing means the document cannot drift from the code, so future agent sessions read accurate
values instead of aspirational ones.

## Verification

`apps/mobile` has no test infrastructure and no `test` script today. This work adds a `test` script
running `bun test` — Bun's built-in runner, no new dependency — but does **not** add component
testing. Two things are worth asserting, both pure TypeScript with no RN imports:

1. **The preference resolver** — `auto | light | dark` × system scheme → resolved scheme.
2. **A contrast assertion over the palette** — every `text` / `textSecondary` / `accent` value
   computed against its canvas, asserting ≥ 4.5:1, with `textMuted` explicitly exempted and
   documented. This turns "we checked contrast once during design" into something that fails when a
   future palette tweak breaks it.

Beyond that: `turbo run lint`, `turbo run typecheck` (with a `test` task added to `turbo.json`),
and an on-device pass in all three theme modes. Results to be reported as observed, including
failures.

## Implementation order

Sequenced so the app stays runnable at every step:

1. `tokens.ts` + `theme.ts` + the three tests. Nothing consumes them yet.
2. `theme-provider.tsx`, wired into `_layout.tsx` alongside the existing `useTheme` so both work.
3. Primitives in `src/components/ui/`, built against tokens.
4. Screen-by-screen migration; delete `themed-text.tsx` / `themed-view.tsx` once the last caller
   moves, and remove the old `constants/theme.ts` and `hooks/use-theme.ts`.
5. `(app)/settings.tsx` and its entry point from home.
6. `Score` / `Bloom` and the `react-native-svg` dependency — last, because it is the only step with
   a native module and an unverified on-device story.
7. The `design:doc` generator and the rewritten `DESIGN.md`.

## Open risks

- **`react-native-svg` is a new native dependency.** It is in the Expo SDK so Expo Go supports it,
  but this has not yet been run on a device. If it misbehaves, the fallback is a baked per-theme
  asset — no dynamic colour, but zero dependencies.
- **The identity is unvalidated against real data.** The score and bands are rendered from mock
  values in the design mockups. When calibration lands, the chosen `bandNeutral`/`accent` split
  should be re-examined against real distributions — if most analyses light several networks
  roughly equally, "one lit band" stops being the right story.
