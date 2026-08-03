import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type Variant = 'primary' | 'secondary' | 'outline' | 'danger';
type Size = 'sm' | 'md';

export interface ButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  label: string;
  variant?: Variant;
  size?: Size;
  icon?: ComponentProps<typeof Ionicons>['name'];
  /** Shows a spinner and blocks presses, keeping the label for context. */
  busy?: boolean;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * The app's one button. Variants map to intent — `primary` for the screen's
 * main action, `secondary` for the rest, `outline` for low-emphasis, `danger`
 * for destructive — so screens never hand-roll a Pressable for a plain action.
 */
export function Button({
  label,
  variant = 'primary',
  size = 'md',
  icon,
  busy,
  disabled,
  fullWidth,
  style,
  ...rest
}: ButtonProps) {
  const theme = useTheme();
  const blocked = Boolean(disabled) || Boolean(busy);

  const palette: Record<Variant, { background: string; pressed: string; text: string }> = {
    primary: { background: theme.accent, pressed: theme.accent, text: theme.onAccent },
    secondary: {
      background: theme.backgroundElement,
      pressed: theme.backgroundSelected,
      text: theme.text,
    },
    outline: { background: 'transparent', pressed: theme.backgroundElement, text: theme.text },
    danger: { background: 'transparent', pressed: theme.backgroundElement, text: theme.danger },
  };
  const colors = palette[variant];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: blocked, busy: Boolean(busy) }}
      disabled={blocked}
      hitSlop={size === 'sm' ? Spacing.two : undefined}
      style={({ pressed }) => [
        styles.base,
        size === 'sm' ? styles.sm : styles.md,
        {
          backgroundColor: pressed && !blocked ? colors.pressed : colors.background,
          borderColor: variant === 'outline' ? theme.border : 'transparent',
          borderWidth: variant === 'outline' ? StyleSheet.hairlineWidth : 0,
          opacity: blocked && !busy ? 0.5 : pressed && variant === 'primary' ? 0.85 : 1,
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
        },
        style,
      ]}
      {...rest}
    >
      {busy ? (
        <ActivityIndicator size="small" color={colors.text} />
      ) : icon ? (
        <Ionicons name={icon} size={size === 'sm' ? 16 : 20} color={colors.text} />
      ) : null}
      <ThemedText
        type={size === 'sm' ? 'smallBold' : 'default'}
        style={{ color: colors.text }}
        numberOfLines={1}
      >
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    borderRadius: 12,
  },
  // 48 / 40 min heights keep the touch target at or above platform guidance.
  md: {
    minHeight: 48,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  sm: {
    minHeight: 40,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
  },
});
