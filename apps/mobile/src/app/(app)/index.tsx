import { Link } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useSession } from '@/providers/session-provider';

export default function HomeScreen() {
  const theme = useTheme();
  const { session, signOut } = useSession();

  const user = session?.user;
  const displayName =
    (typeof user?.user_metadata?.full_name === 'string' && user.user_metadata.full_name) ||
    user?.email ||
    'there';

  return (
    <ThemedView style={styles.root}>
      <View style={styles.header}>
        <ThemedText type="subtitle">Hi, {displayName}</ThemedText>
        <ThemedText type="default" themeColor="textSecondary">
          Run an analysis to see how your next post will resonate.
        </ThemedText>
      </View>

      {/* Placeholder until the analyze flow ships in the app. */}
      <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
        <ThemedText type="smallBold">No analyses yet</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Connect a channel first so results can be ranked against your own audience.
        </ThemedText>
        <Link href="/accounts" asChild>
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.cardAction,
              { backgroundColor: theme.accent, opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <ThemedText type="smallBold" style={{ color: theme.onAccent }}>
              Connect an account
            </ThemedText>
          </Pressable>
        </Link>
      </View>

      <Pressable accessibilityRole="button" onPress={signOut} style={styles.signOut}>
        <ThemedText type="small" themeColor="danger">
          Sign out
        </ThemedText>
      </Pressable>
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
  card: {
    borderRadius: 14,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  cardAction: {
    alignSelf: 'flex-start',
    borderRadius: 10,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    marginTop: Spacing.two,
  },
  signOut: {
    marginTop: 'auto',
    alignItems: 'center',
    paddingVertical: Spacing.three,
  },
});
