import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { useTheme, type TypeVariant } from '@/design';

/** Tones safe for body copy — every one clears WCAG AA on its canvas. */
export type TextTone =
  'default' | 'secondary' | 'accent' | 'danger' | 'success' | 'onAccent' | 'onAccentSubtle';

/** Variants large or incidental enough to carry the sub-AA `textMuted`. */
type MutedSafeVariant = 'display' | 'title' | 'caption' | 'eyebrow';

type ToneProps =
  { tone?: TextTone; variant?: TypeVariant } | { tone: 'muted'; variant: MutedSafeVariant };

export type TextProps = Omit<RNTextProps, 'style'> & ToneProps & { style?: RNTextProps['style'] };

export function Text({ variant = 'body', tone = 'default', style, ...rest }: TextProps) {
  const theme = useTheme();
  const scale = theme.type[variant];

  const color = {
    default: theme.colors.text,
    secondary: theme.colors.textSecondary,
    muted: theme.colors.textMuted,
    accent: theme.colors.accent,
    danger: theme.colors.danger,
    success: theme.colors.success,
    onAccent: theme.colors.onAccent,
    onAccentSubtle: theme.colors.onAccentSubtle,
  }[tone];

  return (
    <RNText
      style={[
        {
          color,
          fontSize: scale.fontSize,
          lineHeight: scale.lineHeight,
          fontWeight: scale.fontWeight,
          letterSpacing: scale.letterSpacing,
        },
        scale.tabular ? { fontVariant: ['tabular-nums' as const] } : null,
        variant === 'eyebrow' ? { textTransform: 'uppercase' as const } : null,
        style,
      ]}
      {...rest}
    />
  );
}
