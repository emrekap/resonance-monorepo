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
