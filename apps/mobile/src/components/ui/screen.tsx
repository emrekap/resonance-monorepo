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
