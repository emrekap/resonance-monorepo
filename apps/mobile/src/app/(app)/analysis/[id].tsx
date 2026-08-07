import { AnalysisStatus, AxisConfidence, ResonanceAxis } from '@repo/db/browser';
import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { AttentionTimeline, formatClock } from '@/components/analysis/attention-timeline';
import { Badge, Button, Card, Meter, Score, Screen, Text } from '@/components/ui';
import { useTheme } from '@/design';
import { api } from '@/lib/api';
import { analysisKey } from '@/lib/query-keys';

const RUNNING: AnalysisStatus[] = [AnalysisStatus.QUEUED, AnalysisStatus.PROCESSING];

const STATUS_COPY: Record<AnalysisStatus, string> = {
  [AnalysisStatus.QUEUED]: 'Waiting for a worker…',
  [AnalysisStatus.PROCESSING]: 'The model is watching your media…',
  [AnalysisStatus.SUCCEEDED]: 'Done',
  [AnalysisStatus.FAILED]: 'Analysis failed',
  [AnalysisStatus.CANCELLED]: 'Cancelled',
};

const AXIS_LABELS: Record<ResonanceAxis, string> = {
  [ResonanceAxis.VISUAL_ATTENTION]: 'Visual attention',
  [ResonanceAxis.AUDIO_ENGAGEMENT]: 'Audio engagement',
  [ResonanceAxis.CLARITY]: 'Clarity',
  [ResonanceAxis.EMOTIONAL_PULL]: 'Emotional pull',
  [ResonanceAxis.MEMORABILITY]: 'Memorability',
};

/**
 * The result screen, read top to bottom: **verdict → timeline → why → what to
 * fix** (docs/resonance-model-design.md §1b).
 *
 * The ordering is the argument. A creator sees the number, then where attention
 * actually moved, then which channel drove it, then what to change — each
 * section justifying the one above it. Raw model telemetry appears nowhere: a
 * z-scored BOLD value is dev output, not a thing to show a person.
 *
 * Status arrives as a push (`useAnalysisRealtime`, mounted in the `(app)`
 * layout). The recommendations are written a beat after the analysis flips
 * SUCCEEDED, so this screen renders without them and fills in on the next
 * invalidation — which is why the tips section has a pending state rather than
 * being hidden when empty.
 */
export default function AnalysisScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [focusSec, setFocusSec] = useState<number | null>(null);

  const job = useQuery({
    queryKey: analysisKey(id),
    enabled: Boolean(id),
    queryFn: async () => {
      const res = await api.analyze[':id'].$get({ param: { id } });
      if (res.status === 404) throw new Error('This analysis does not exist.');
      if (res.status !== 200) throw new Error('Could not load the analysis.');
      return res.json();
    },
  });

  const running = Boolean(job.data && (RUNNING as string[]).includes(job.data.status));
  const result = job.data?.result ?? null;
  const succeeded = job.data?.status === AnalysisStatus.SUCCEEDED;

  // The five arrays are equal-length by database constraint, so one length check
  // stands in for all of them.
  const hasTimeline = Boolean(result && result.timelineStartSec.length > 0);
  const axes = result?.axisScores ?? [];
  const tips = result?.recommendations ?? [];

  return (
    <Screen scroll>
      {job.isPending ? (
        <ActivityIndicator
          style={{ marginTop: theme.space.xl }}
          color={theme.colors.textSecondary}
        />
      ) : job.isError ? (
        <Card>
          <Text variant="label" tone="danger">
            {job.error.message}
          </Text>
          <Button
            label="Try again"
            variant="secondary"
            size="sm"
            onPress={() => void job.refetch()}
          />
        </Card>
      ) : (
        <>
          {succeeded ? (
            <Score
              // Already the absolute 0–100 the model design specifies (see
              // apps/worker/README.md) — scaling it by 100 would render 8700.
              value={result?.resonanceScore ?? null}
              caption={
                result?.percentileInChannel != null
                  ? `Top ${100 - Math.round(result.percentileInChannel)}% of your recent posts`
                  : 'Baseline — analyze a few more to see how this one ranks'
              }
            />
          ) : null}

          <Card>
            <View style={[styles.statusRow, { gap: theme.space.sm }]}>
              {running ? <ActivityIndicator size="small" color={theme.colors.accent} /> : null}
              <Text variant="labelStrong">{STATUS_COPY[job.data.status]}</Text>
            </View>
            <Text variant="label" tone="secondary">
              {job.data.media.kind.toLowerCase()} · job {job.data.jobId.slice(0, 8)}
            </Text>
            {job.data.status === AnalysisStatus.FAILED && job.data.error ? (
              <Text variant="label" tone="danger">
                {job.data.error}
              </Text>
            ) : null}
          </Card>

          {succeeded && hasTimeline && result ? (
            <Card style={{ gap: theme.space.md }}>
              <Text variant="eyebrow" tone="muted">
                Attention over time
              </Text>
              <AttentionTimeline
                timeline={{
                  startSec: result.timelineStartSec,
                  visual: result.timelineVisual,
                  audio: result.timelineAudio,
                  language: result.timelineLanguage,
                }}
                focusSec={focusSec}
              />
            </Card>
          ) : null}

          {succeeded && axes.length > 0 ? (
            <Card style={{ gap: theme.space.md }}>
              <Text variant="eyebrow" tone="muted">
                Why
              </Text>
              {axes.map((axis) => (
                <View key={axis.axis} style={{ gap: theme.space.xs }}>
                  <View style={styles.axisRow}>
                    <View style={[styles.axisRow, { gap: theme.space.sm }]}>
                      <Text variant="label">{AXIS_LABELS[axis.axis]}</Text>
                      {/* The honesty gate: EMOTIONAL_PULL and MEMORABILITY are
                          cortical proxies for structures fsaverage5 does not
                          contain, and CLARITY means nothing without speech. */}
                      {axis.confidence === AxisConfidence.BETA ? (
                        <Badge label="beta" tone="neutral" />
                      ) : null}
                    </View>
                    <Text variant="label" tone="secondary">
                      {Math.round(axis.score)}
                    </Text>
                  </View>
                  <Meter
                    value={axis.score / 100}
                    tone={axis.confidence === AxisConfidence.BETA ? 'neutral' : 'accent'}
                    label={AXIS_LABELS[axis.axis]}
                  />
                </View>
              ))}
            </Card>
          ) : null}

          {succeeded ? (
            <Card style={{ gap: theme.space.md }}>
              <Text variant="eyebrow" tone="muted">
                Do this
              </Text>
              {tips.length === 0 ? (
                <Text variant="label" tone="secondary">
                  Working out what to suggest…
                </Text>
              ) : (
                tips.map((tip, index) => {
                  // Bound once so TypeScript narrows it for the whole row — a
                  // note about the clip as a whole has no moment to scrub to.
                  const start = tip.targetStartSec;
                  const isFocused = start !== null && focusSec === start;
                  return (
                    <Pressable
                      key={`${tip.kind}-${index}`}
                      disabled={start === null}
                      accessibilityRole={start === null ? 'text' : 'button'}
                      accessibilityHint={
                        start === null ? undefined : 'Highlights this moment on the timeline'
                      }
                      onPress={() => setFocusSec(isFocused ? null : start)}
                      style={{ gap: theme.space.xxs }}
                    >
                      <Text variant="label" tone={isFocused ? 'accent' : 'default'}>
                        {tip.message}
                      </Text>
                      {start === null ? null : (
                        <Text variant="caption" tone="muted">
                          {formatClock(start)}
                          {tip.targetStopSec === null ? '' : `–${formatClock(tip.targetStopSec)}`}
                        </Text>
                      )}
                    </Pressable>
                  );
                })
              )}
            </Card>
          ) : null}

          {/* `dismissTo`, not `replace`: this screen is a card on the `(app)`
              Stack, and replacing it would leave a second `(tabs)` sitting on
              top of the one it was pushed from. */}
          <Button
            label="Analyze another"
            variant="secondary"
            fullWidth
            onPress={() => router.dismissTo('/')}
          />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  axisRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
});
