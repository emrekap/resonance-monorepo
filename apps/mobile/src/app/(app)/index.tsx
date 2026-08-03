import { Link } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { ProgressBar } from '@/components/progress-bar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { PHASE_LABELS, useMediaAnalysis } from '@/hooks/use-media-analysis';
import { useSession } from '@/providers/session-provider';

export default function HomeScreen() {
  const { session, signOut } = useSession();
  const analysis = useMediaAnalysis();

  const user = session?.user;
  const displayName =
    (typeof user?.user_metadata?.full_name === 'string' && user.user_metadata.full_name) ||
    user?.email ||
    'there';

  const busy = analysis.phase !== 'idle';

  return (
    <ThemedView style={styles.root}>
      <View style={styles.header}>
        <ThemedText type="subtitle">Hi, {displayName}</ThemedText>
        <ThemedText type="default" themeColor="textSecondary">
          Run an analysis to see how your next post will resonate.
        </ThemedText>
      </View>

      <Card>
        <ThemedText type="smallBold">New analysis</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Pick something from your library. It uploads privately to your workspace and lands on
          the model.
        </ThemedText>

        {busy ? (
          <View style={styles.progress}>
            <ThemedText type="small" themeColor="textSecondary">
              {PHASE_LABELS[analysis.phase as Exclude<typeof analysis.phase, 'idle'>]}
            </ThemedText>
            {analysis.phase === 'uploading' ? (
              <>
                <ProgressBar progress={analysis.progress} />
                <Button
                  label="Cancel upload"
                  variant="danger"
                  size="sm"
                  onPress={analysis.cancel}
                />
              </>
            ) : null}
          </View>
        ) : (
          <View style={styles.actions}>
            <Button
              label="Video"
              icon="videocam"
              fullWidth
              onPress={() => analysis.start('video')}
            />
            <Button
              label="Photo"
              icon="image"
              variant="secondary"
              fullWidth
              onPress={() => analysis.start('image')}
            />
            <Button
              label="Audio"
              icon="musical-notes"
              variant="secondary"
              fullWidth
              onPress={() => analysis.start('audio')}
            />
          </View>
        )}

        {analysis.error ? (
          <ThemedText type="small" themeColor="danger">
            {analysis.error}
          </ThemedText>
        ) : null}
      </Card>

      <Card>
        <ThemedText type="smallBold">Better with your audience</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Connect a channel so results can be ranked against your own audience.
        </ThemedText>
        <Link href="/accounts" asChild>
          <Button label="Connect an account" variant="outline" size="sm" />
        </Link>
      </Card>

      <View style={styles.signOut}>
        <Button label="Sign out" variant="danger" size="sm" onPress={signOut} />
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    padding: Spacing.four,
    gap: Spacing.four,
  },
  header: {
    gap: Spacing.two,
  },
  actions: {
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
  progress: {
    gap: Spacing.two,
    marginTop: Spacing.one,
    alignItems: 'stretch',
  },
  signOut: {
    marginTop: 'auto',
    alignItems: 'center',
  },
});
