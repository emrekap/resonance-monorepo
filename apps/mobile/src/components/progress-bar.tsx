import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

export interface ProgressBarProps {
  /** 0..1. Values outside the range are clamped. */
  progress: number;
}

/** A determinate progress track (uploads). Announces its value to a11y tools. */
export function ProgressBar({ progress }: ProgressBarProps) {
  const theme = useTheme();
  const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: pct }}
      style={[styles.track, { backgroundColor: theme.backgroundSelected }]}
    >
      <View style={[styles.fill, { backgroundColor: theme.accent, width: `${pct}%` }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 3,
  },
});
