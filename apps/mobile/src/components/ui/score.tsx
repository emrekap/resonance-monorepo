import { View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Bloom } from '@/components/ui/bloom';
import { Text } from '@/components/ui/text';
import { useTheme } from '@/design';

export interface ScoreProps {
  /**
   * Null while the analysis is unfinished, and also once it is: `apps/worker`
   * withholds the score below five prior analyses in the workspace, since the
   * number is a rank against that history. Renders as "Pending" either way.
   */
  value: number | null;
  max?: number;
  /**
   * Short comparative note, e.g. "Top 20% of your posts". Rendered in BOTH
   * states — the caller knows why a score is missing and this component does
   * not, so a withheld score must be able to say so in the caller's words.
   */
  caption?: string;
  bloom?: boolean;
}

/**
 * A missing score is not always a pending one, so this is the honest default:
 * it names the cause without promising a number is on its way. The caller
 * should override it whenever it knows better.
 */
const PENDING_CAPTION = 'Scores start once there are a few analyses to rank this against.';

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
            {caption ?? PENDING_CAPTION}
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
