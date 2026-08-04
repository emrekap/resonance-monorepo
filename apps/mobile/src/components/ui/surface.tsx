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
