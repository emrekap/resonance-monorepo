import { AnalysisStatus } from '@repo/db/browser';
import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Button, Card, Score, Screen, Text } from '@/components/ui';
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

/**
 * The screen behind `POST /analyze`. Inference is seconds-to-minutes on a GPU
 * worker, so the status arrives as a push: `useAnalysisRealtime`, mounted in
 * the `(app)` layout, invalidates this query when the row changes. Before that
 * it polled every 2.5s.
 */
export default function AnalysisScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

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
          {job.data.status === AnalysisStatus.SUCCEEDED ? (
            <Score
              // Already the absolute 0–100 the model design specifies (see
              // apps/worker/README.md) — scaling it by 100 would render 8700.
              value={job.data.result?.resonanceScore ?? null}
              caption={
                job.data.result?.percentileInChannel != null
                  ? `Top ${100 - Math.round(job.data.result.percentileInChannel)}% for your channel`
                  : undefined
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
});
