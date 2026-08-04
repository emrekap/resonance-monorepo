import type { ViewProps, RefreshControlProps } from 'react-native';
import { ScrollView, View, StyleSheet } from 'react-native';
// import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/design';

export interface ScreenProps extends ViewProps {
  /** Wraps content in a ScrollView. Use for anything that can overflow. */
  scroll?: boolean;
  /** Applies the standard screen gutter. Turn off for edge-to-edge content. */
  padded?: boolean;
  refreshControl?: React.ReactElement<RefreshControlProps>;
}

/**
 * The outermost element of every screen. Exists because each screen was
 * re-deriving `{ flex: 1, padding, gap }` and drifting while doing it.
 */
export function Screen({
  scroll,
  padded = true,
  style,
  children,
  refreshControl,
  ...rest
}: ScreenProps) {
  const theme = useTheme();
  // const insets = useSafeAreaInsets();

  const layout = {
    // paddingTop: insets.top,
    // paddingBottom: insets.bottom,
    paddingVertical: theme.space.lg,
    paddingHorizontal: padded ? theme.space.lg : 0,
    gap: theme.space.lg,
  };

  if (scroll || refreshControl) {
    return (
      <ScrollView
        style={StyleSheet.flatten([{ flex: 1, backgroundColor: theme.colors.canvas }, style])}
        contentContainerStyle={layout}
        refreshControl={refreshControl}
        {...rest}
      >
        {children}
      </ScrollView>
    );
  }

  return (
    <View
      style={StyleSheet.flatten([{ flex: 1, backgroundColor: theme.colors.canvas }, layout, style])}
      {...rest}
    >
      {children}
    </View>
  );
}
