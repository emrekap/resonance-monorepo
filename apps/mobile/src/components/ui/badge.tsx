import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useTheme } from '@/design';

export interface BadgeProps {
  label: string;
  tone?: 'accent' | 'neutral' | 'success' | 'danger';
}

export function Badge({ label, tone = 'accent' }: BadgeProps) {
  const theme = useTheme();

  const background = {
    accent: theme.colors.accentSubtle,
    neutral: theme.colors.surface,
    success: theme.colors.surface,
    danger: theme.colors.surface,
  }[tone];

  const textTone = {
    accent: 'accent',
    neutral: 'secondary',
    success: 'success',
    danger: 'danger',
  }[tone] as 'accent' | 'secondary' | 'success' | 'danger';

  return (
    <View
      style={{
        alignSelf: 'flex-start',
        backgroundColor: background,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: theme.radius.pill,
        paddingHorizontal: theme.space.md,
        paddingVertical: theme.space.xs,
      }}
    >
      <Text variant="caption" tone={textTone}>
        {label}
      </Text>
    </View>
  );
}
