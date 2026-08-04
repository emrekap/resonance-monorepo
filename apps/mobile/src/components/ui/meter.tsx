import { View } from 'react-native';

import { useTheme } from '@/design';

export interface MeterProps {
  /** 0–1. Values outside the range are clamped. */
  value: number;
  /** `accent` for the network that fired or an active upload; `neutral` for the rest. */
  tone?: 'accent' | 'accentMuted' | 'neutral';
  /** Accessible name. Omit only when an adjacent label already names it. */
  label?: string;
}

export function Meter({ value, tone = 'accent', label }: MeterProps) {
  const theme = useTheme();
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);

  const fill = {
    accent: theme.colors.accent,
    accentMuted: theme.colors.accentMuted,
    neutral: theme.colors.bandNeutral,
  }[tone];

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: pct }}
      style={{
        height: 7,
        borderRadius: theme.radius.pill,
        backgroundColor: theme.colors.bandTrack,
        overflow: 'hidden',
      }}
    >
      <View style={{ height: '100%', width: `${pct}%`, backgroundColor: fill }} />
    </View>
  );
}
