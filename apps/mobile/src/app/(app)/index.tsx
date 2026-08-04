import { Link } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Meter, Screen, Text } from '@/components/ui';
import { useTheme } from '@/design';
import { PHASE_LABELS, useMediaAnalysis } from '@/hooks/use-media-analysis';
import { useSession } from '@/providers/session-provider';

export default function HomeScreen() {
  const theme = useTheme();
  const { session, signOut } = useSession();
  const analysis = useMediaAnalysis();

  const user = session?.user;
  const displayName =
    (typeof user?.user_metadata?.full_name === 'string' && user.user_metadata.full_name) ||
    user?.email ||
    'there';

  const busy = analysis.phase !== 'idle';

  return (
    <Screen scroll>
      <View style={{ gap: theme.space.sm }}>
        <Text variant="title">Hi, {displayName}</Text>
        <Text variant="body" tone="secondary">
          Run an analysis to see how your next post will resonate.
        </Text>
      </View>

      <Card>
        <Text variant="labelStrong">New analysis</Text>
        <Text variant="label" tone="secondary">
          Pick something from your library. It uploads privately to your workspace and lands on the
          model.
        </Text>

        {busy ? (
          <View style={[styles.progress, { gap: theme.space.sm, marginTop: theme.space.xs }]}>
            <Text variant="label" tone="secondary">
              {PHASE_LABELS[analysis.phase as Exclude<typeof analysis.phase, 'idle'>]}
            </Text>
            {analysis.phase === 'uploading' ? (
              <>
                <Meter value={analysis.progress} label="Upload progress" />
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
          <View style={{ gap: theme.space.sm, marginTop: theme.space.xs }}>
            <Button
              label="Video"
              icon="videocam"
              fullWidth
              onPress={() => void analysis.start('video')}
            />
            <Button
              label="Photo"
              icon="image"
              variant="secondary"
              fullWidth
              onPress={() => void analysis.start('image')}
            />
            <Button
              label="Audio"
              icon="musical-notes"
              variant="secondary"
              fullWidth
              onPress={() => void analysis.start('audio')}
            />
          </View>
        )}

        {analysis.error ? (
          <Text variant="label" tone="danger">
            {analysis.error}
          </Text>
        ) : null}
      </Card>

      <Card>
        <Text variant="labelStrong">Better with your audience</Text>
        <Text variant="label" tone="secondary">
          Connect a channel so results can be ranked against your own audience.
        </Text>
        <Link href="/accounts" asChild>
          <Button label="Connect an account" variant="secondary" size="sm" />
        </Link>
      </Card>

      <View style={[styles.signOut, { gap: theme.space.sm }]}>
        <Link href="/settings" asChild>
          <Button label="Settings" variant="ghost" size="sm" icon="settings-outline" />
        </Link>
        <Button label="Sign out" variant="danger" size="sm" onPress={() => void signOut()} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  progress: {
    alignItems: 'stretch',
  },
  signOut: {
    alignItems: 'center',
  },
});
