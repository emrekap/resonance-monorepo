import Ionicons from '@expo/vector-icons/Ionicons';
import { AnalysisStatus, MediaKind } from '@repo/db/browser';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { useTheme } from '@/design';
import type { Analysis } from '@/hooks/use-analyses';

/** Short enough for a row. The detail screen carries the sentence-length copy. */
const STATUS_LABEL: Record<AnalysisStatus, string> = {
  [AnalysisStatus.QUEUED]: 'Queued',
  [AnalysisStatus.PROCESSING]: 'Processing',
  [AnalysisStatus.SUCCEEDED]: 'Done',
  [AnalysisStatus.FAILED]: 'Failed',
  [AnalysisStatus.CANCELLED]: 'Cancelled',
};

const KIND_LABEL: Record<MediaKind, string> = {
  [MediaKind.VIDEO]: 'Video',
  [MediaKind.AUDIO]: 'Audio',
  [MediaKind.IMAGE]: 'Image',
};

/** Compact age, not a timestamp — the exact minute never matters in a list. */
function age(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function duration(seconds: number | null): string | null {
  if (seconds == null) return null;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export interface AnalysisRowProps {
  analysis: Analysis;
  onPress: () => void;
}

/**
 * One analysis in the history list.
 *
 * The leading slot is the score when there is one and a status dot when there
 * is not — every score is null until calibration ships, so the dot is the
 * common case today and the layout must not look broken in it.
 *
 * `fileName` is null for assets registered from a URL and for everything
 * uploaded before the column existed, so the title falls back to the media
 * kind. `durationSec` is likewise unwritten today, so the subtitle composes
 * from whichever parts exist rather than assuming all of them.
 */
export function AnalysisRow({ analysis, onPress }: AnalysisRowProps) {
  const theme = useTheme();

  const score = analysis.result?.resonanceScore ?? null;
  const kindLabel = KIND_LABEL[analysis.media.kind];
  const statusLabel = STATUS_LABEL[analysis.status];
  const title = analysis.media.fileName ?? kindLabel;

  const statusColor = {
    [AnalysisStatus.QUEUED]: theme.colors.textSecondary,
    [AnalysisStatus.PROCESSING]: theme.colors.accent,
    [AnalysisStatus.SUCCEEDED]: theme.colors.success,
    [AnalysisStatus.FAILED]: theme.colors.danger,
    [AnalysisStatus.CANCELLED]: theme.colors.textMuted,
  }[analysis.status];

  // Skip the kind when it is already the title, or the row reads "Video · Video".
  const details = [
    analysis.media.fileName ? kindLabel : null,
    duration(analysis.media.durationSec),
    statusLabel,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${statusLabel}${score != null ? `, score ${score}` : ''}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          gap: theme.space.base,
          padding: theme.space.base,
          borderRadius: theme.radius.lg,
          backgroundColor: pressed ? theme.colors.surfaceElevated : theme.colors.surface,
        },
      ]}
    >
      <View style={[styles.lead, { minWidth: 40 }]}>
        {score != null ? (
          <Text variant="heading">{score}</Text>
        ) : (
          <View
            style={[styles.dot, { backgroundColor: statusColor, borderRadius: theme.radius.pill }]}
            // The dot repeats the status already in `details`; announcing it
            // again would read as two separate facts.
            accessibilityElementsHidden
            importantForAccessibility="no"
          />
        )}
      </View>

      <View style={[styles.body, { gap: theme.space.xxs }]}>
        <Text variant="body" numberOfLines={1}>
          {title}
        </Text>
        <Text variant="label" tone="secondary" numberOfLines={1}>
          {details}
        </Text>
      </View>

      <View style={[styles.trail, { gap: theme.space.xs }]}>
        <Text variant="caption" tone="secondary">
          {age(analysis.createdAt)}
        </Text>
        <Ionicons name="chevron-forward" size={16} color={theme.colors.textMuted} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  lead: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    width: 10,
    height: 10,
  },
  body: {
    flex: 1,
  },
  trail: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
