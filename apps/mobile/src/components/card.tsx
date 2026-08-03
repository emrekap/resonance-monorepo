import { View, type ViewProps } from 'react-native';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * The raised-surface container every screen section sits in — one place for
 * the radius/padding so cards stay consistent as screens multiply.
 */
export function Card({ style, ...rest }: ViewProps) {
  const theme = useTheme();

  return (
    <View
      style={[
        {
          backgroundColor: theme.backgroundElement,
          borderRadius: 14,
          padding: Spacing.three,
          gap: Spacing.two,
        },
        style,
      ]}
      {...rest}
    />
  );
}
