import { View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Bloom } from '@/components/ui/bloom';
import { Text } from '@/components/ui/text';
import { useTheme } from '@/design';

export interface ScoreProps {
  /** Null until the calibration behind `resonanceScore` ships. */
  value: number | null;
  max?: number;
  /** Short comparative note, e.g. "Top 20% of your posts". */
  caption?: string;
  bloom?: boolean;
}

export function Score({ value, max = 100, caption, bloom = true }: ScoreProps) {
  const theme = useTheme();

  return (
    <View style={{ paddingVertical: theme.space.lg, overflow: 'hidden' }}>
      {bloom && value !== null ? <Bloom /> : null}
      <Text variant="eyebrow" tone="secondary">
        Resonance score
      </Text>

      {value === null ? (
        <>
          <Text variant="title" tone="secondary" style={{ marginTop: theme.space.sm }}>
            Pending
          </Text>
          <Text variant="caption" tone="secondary" style={{ marginTop: theme.space.xs }}>
            Analysis complete. Scoring is waiting on model calibration.
          </Text>
        </>
      ) : (
        <>
          <Text
            variant="display"
            accessibilityLabel={`Resonance score ${value} out of ${max}`}
            style={{ marginTop: theme.space.sm }}
          >
            {value}
          </Text>
          {caption ? (
            <View style={{ marginTop: theme.space.md }}>
              <Badge label={caption} />
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}
