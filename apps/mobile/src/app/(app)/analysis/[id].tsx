import { AnalysisStatus } from '@repo/db/browser';
import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
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
    <ThemedView style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        {job.isPending ? (
          <ActivityIndicator style={styles.loader} color={theme.textSecondary} />
        ) : job.isError ? (
          <Card>
            <ThemedText type="small" themeColor="danger">
              {job.error.message}
            </ThemedText>
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
              <View style={styles.statusRow}>
                {running ? <ActivityIndicator size="small" color={theme.accent} /> : null}
                <ThemedText type="smallBold">{STATUS_COPY[job.data.status]}</ThemedText>
              </View>
              <ThemedText type="small" themeColor="textSecondary">
                {job.data.media.kind.toLowerCase()} · job {job.data.jobId.slice(0, 8)}
              </ThemedText>
              {job.data.status === AnalysisStatus.FAILED && job.data.error ? (
                <ThemedText type="small" themeColor="danger">
                  {job.data.error}
                </ThemedText>
              ) : null}
            </Card>

            {job.data.status === AnalysisStatus.SUCCEEDED ? (
              <Card>
                <ThemedText type="smallBold">Resonance</ThemedText>
                <ThemedText type="title">
                  {job.data.result?.resonanceScore != null
                    ? Math.round(job.data.result.resonanceScore * 100)
                    : '—'}
                </ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  {job.data.result?.percentileInChannel != null
                    ? `Top ${100 - Math.round(job.data.result.percentileInChannel)}% for your channel`
                    : 'Score calibration is still training — raw encoding finished successfully.'}
                </ThemedText>
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
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  content: {
    padding: Spacing.four,
    gap: Spacing.four,
  },
  loader: {
    marginTop: Spacing.five,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
});
