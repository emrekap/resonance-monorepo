---
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
    canvas: '#0A0A0C'
    surface: '#16161A'
    surfaceElevated: '#1E1D24'
    border: '#26252E'
    borderStrong: '#35343E'
    text: '#FFFFFF'
    textSecondary: '#A3A0B0'
    textMuted: '#6E6B7D'
    accent: '#7C5CFF'
    accentSurface: '#6D4AFF'
    accentSurfacePressed: '#5B34E0'
    accentMuted: '#6D55C4'
    accentSubtle: '#241E42'
    onAccentSubtle: '#A78BFF'
    onAccent: '#FFFFFF'
    bandTrack: '#1F1E26'
    bandNeutral: '#3B3B47'
    success: '#4ADE80'
    warning: '#FBBF24'
    danger: '#FF6369'
  light:
    canvas: '#F6F5FA'
    surface: '#FFFFFF'
    surfaceElevated: '#FFFFFF'
    border: '#E7E5F0'
    borderStrong: '#D5D2E2'
    text: '#12111A'
    textSecondary: '#6B6880'
    textMuted: '#8A87A0'
    accent: '#6338E8'
    accentSurface: '#6338E8'
    accentSurfacePressed: '#5227D6'
    accentMuted: '#9A85E8'
    accentSubtle: '#EFEBFD'
    onAccentSubtle: '#6338E8'
    onAccent: '#FFFFFF'
    bandTrack: '#E7E5F0'
    bandNeutral: '#C6C3D4'
    success: '#15803D'
    warning: '#B45309'
    danger: '#DC2626'

typography:
  display:
    fontSize: 64
    lineHeight: 55
    fontWeight: 700
    letterSpacing: -3.5
    tabular: true
  title:
    fontSize: 28
    lineHeight: 34
    fontWeight: 700
    letterSpacing: -0.6
    tabular: false
  heading:
    fontSize: 20
    lineHeight: 26
    fontWeight: 600
    letterSpacing: -0.2
    tabular: false
  body:
    fontSize: 16
    lineHeight: 24
    fontWeight: 400
    letterSpacing: 0
    tabular: false
  bodyStrong:
    fontSize: 16
    lineHeight: 24
    fontWeight: 600
    letterSpacing: 0
    tabular: false
  label:
    fontSize: 14
    lineHeight: 20
    fontWeight: 500
    letterSpacing: 0
    tabular: false
  labelStrong:
    fontSize: 14
    lineHeight: 20
    fontWeight: 600
    letterSpacing: 0
    tabular: false
  caption:
    fontSize: 12
    lineHeight: 16
    fontWeight: 400
    letterSpacing: 0
    tabular: false
  eyebrow:
    fontSize: 11
    lineHeight: 12
    fontWeight: 600
    letterSpacing: 1.5
    tabular: false
  mono:
    fontSize: 13
    lineHeight: 18
    fontWeight: 400
    letterSpacing: 0
    tabular: true

rounded:
  xs: 4
  sm: 8
  md: 12
  lg: 18
  xl: 26
  pill: 999

spacing:
  xxs: 2
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  xxl: 48
  xxxl: 64
---

## Overview

Ultraviolet is a single-voltage system. Violet is the only chromatic colour, and
it is spent on exactly three things: the primary action, the network that fired,
and the bloom. Everything else is a graded neutral.

That restraint is a product constraint, not a taste: Resonance screens always sit
next to the creator's own thumbnails, and a high-chroma palette loses that fight.
Seven categorical hues across the Yeo networks would also imply seven categories
a creator has to learn, whereas one lit band says _this one fired_.

## Accessibility

Every foreground clears WCAG AA against its canvas except `textMuted`, which
measures 3.2:1 in light mode and is restricted to large text, disabled states and
decorative labels. The `Text` primitive enforces this in its type signature, and
`src/design/tokens.test.ts` fails if a palette edit breaks any of the ratios.

## Do not hand-edit

This file is generated from `src/design/tokens.ts` by
`scripts/generate-design-doc.ts`. Change the tokens and run `bun run design:doc`.
