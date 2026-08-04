import { AnalysisStatus } from '@repo/db/browser';
import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Button, Card, Screen, Text } from '@/components/ui';
import { useTheme } from '@/design';
import { api } from '@/lib/api';

const RUNNING: AnalysisStatus[] = [AnalysisStatus.QUEUED, AnalysisStatus.PROCESSING];

const STATUS_COPY: Record<AnalysisStatus, string> = {
  [AnalysisStatus.QUEUED]: 'Waiting for a worker…',
  [AnalysisStatus.PROCESSING]: 'The model is watching your media…',
  [AnalysisStatus.SUCCEEDED]: 'Done',
  [AnalysisStatus.FAILED]: 'Analysis failed',
  [AnalysisStatus.CANCELLED]: 'Cancelled',
};

/**
 * The poll screen behind `POST /analyze` — refetches every 2.5s while the job
 * is queued/processing and goes quiet on any terminal status. Inference is
 * seconds-to-minutes on a GPU worker, so polling *is* the contract (see the
 * queue design in CLAUDE.md), not a stand-in for a socket.
 */
export default function AnalysisScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const job = useQuery({
    queryKey: ['analysis', id],
    enabled: Boolean(id),
    queryFn: async () => {
      const res = await api.analyze[':id'].$get({ param: { id } });
      if (res.status === 404) throw new Error('This analysis does not exist.');
      if (res.status !== 200) throw new Error('Could not load the analysis.');
      return res.json();
    },
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && (RUNNING as string[]).includes(status) ? 2500 : false;
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

          {job.data.status === AnalysisStatus.SUCCEEDED ? (
            <Card>
              <Text variant="labelStrong">Resonance</Text>
              <Text variant="display">
                {job.data.result?.resonanceScore != null
                  ? Math.round(job.data.result.resonanceScore * 100)
                  : '—'}
              </Text>
              <Text variant="label" tone="secondary">
                {job.data.result?.percentileInChannel != null
                  ? `Top ${100 - Math.round(job.data.result.percentileInChannel)}% for your channel`
                  : 'Score calibration is still training — raw encoding finished successfully.'}
              </Text>
            </Card>
          ) : null}

          <Button
            label="Analyze another"
            variant="secondary"
            fullWidth
            onPress={() => router.replace('/')}
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
