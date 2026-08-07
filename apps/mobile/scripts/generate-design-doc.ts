/// <reference types="bun" />
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
Seventeen categorical hues across the cortical networks would also imply
seventeen categories a creator has to learn, whereas one lit band says
*this one fired*.

The attention timeline is the deliberate exception, and the smallest one that
works. Three curves are drawn at once and cross constantly, so they cannot be
told apart by lightness — \`bandVisual\`, \`bandAudio\` and \`bandLanguage\` are
three hues rather than three tints. Three is the count the product actually
needs; the other fourteen networks stay folded into the five axes and never get
a colour. Everywhere else, one violet still means *this one fired*.

## Accessibility

Every foreground clears WCAG AA against its canvas except \`textMuted\`, which
measures 3.2:1 in light mode and is restricted to large text, disabled states and
decorative labels. The \`Text\` primitive enforces this in its type signature, and
\`src/design/tokens.test.ts\` fails if a palette edit breaks any of the ratios.

The three band colours are non-text graphics, so they are held to 3:1 against the
canvas rather than 4.5:1 — and additionally to 60° of hue separation from one
another, since that, not contrast, is what keeps three overlapping lines legible.
Both are asserted in the same test file.

## Do not hand-edit

This file is generated from \`src/design/tokens.ts\` by
\`scripts/generate-design-doc.ts\`. Change the tokens and run \`bun run design:doc\`.
`;

await Bun.write(new URL('../DESIGN.md', import.meta.url), doc);
console.log('✓ DESIGN.md regenerated from tokens');
