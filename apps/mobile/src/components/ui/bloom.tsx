import { useId } from 'react';
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
  const gradientId = useId();
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
        <RadialGradient id={gradientId} cx="50%" cy="50%" r="70%">
          <Stop offset="0%" stopColor={theme.colors.accent} stopOpacity={peak} />
          <Stop offset="45%" stopColor={theme.colors.accent} stopOpacity={peak * 0.28} />
          <Stop offset="100%" stopColor={theme.colors.accent} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${gradientId})`} />
    </Svg>
  );
}
