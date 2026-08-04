import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { Text } from '@/components/ui/text';
import { useTheme } from '@/design';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ComponentProps<typeof Ionicons>['name'];
  /** Shows a spinner and blocks presses, keeping the label for context. */
  busy?: boolean;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
}

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

  const palette = {
    // `accentSurface`, not `accent` — a filled button carries white text, and
    // the on-canvas accent is too light to do that at AA. See tokens.ts.
    primary: {
      background: theme.colors.accentSurface,
      pressed: theme.colors.accentSurfacePressed,
      border: 'transparent',
      tone: 'onAccent' as const,
    },
    secondary: {
      background: theme.colors.surface,
      pressed: theme.colors.surfaceElevated,
      border: theme.colors.border,
      tone: 'default' as const,
    },
    ghost: {
      background: 'transparent',
      pressed: theme.colors.surface,
      border: 'transparent',
      tone: 'default' as const,
    },
    danger: {
      background: 'transparent',
      pressed: theme.colors.surface,
      border: 'transparent',
      tone: 'danger' as const,
    },
  }[variant];

  // 40/48/56 keep every target at or above platform touch guidance.
  const metrics = {
    sm: { minHeight: 40, paddingHorizontal: theme.space.base, iconSize: 16 },
    md: { minHeight: 48, paddingHorizontal: theme.space.lg, iconSize: 20 },
    lg: { minHeight: 56, paddingHorizontal: theme.space.xl, iconSize: 22 },
  }[size];

  const textColor = {
    onAccent: theme.colors.onAccent,
    default: theme.colors.text,
    danger: theme.colors.danger,
  }[palette.tone];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: blocked, busy: Boolean(busy) }}
      disabled={blocked}
      hitSlop={size === 'sm' ? theme.space.sm : undefined}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: theme.space.sm,
          borderRadius: theme.radius.pill,
          borderWidth: palette.border === 'transparent' ? 0 : 1,
          borderColor: palette.border,
          minHeight: metrics.minHeight,
          paddingHorizontal: metrics.paddingHorizontal,
          backgroundColor: pressed && !blocked ? palette.pressed : palette.background,
          opacity: blocked && !busy ? 0.5 : 1,
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
        },
        style,
      ]}
      {...rest}
    >
      {busy ? (
        <ActivityIndicator size="small" color={textColor} />
      ) : icon ? (
        <Ionicons name={icon} size={metrics.iconSize} color={textColor} />
      ) : null}
      <Text
        variant={size === 'sm' ? 'labelStrong' : 'bodyStrong'}
        tone={palette.tone}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}
