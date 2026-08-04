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
