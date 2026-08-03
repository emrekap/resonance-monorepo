import { Link } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export default function WelcomeScreen() {
  const theme = useTheme();

  return (
    <ThemedView style={styles.root}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.hero}>
          <ThemedText type="title">Resonance</ThemedText>
          <ThemedText type="default" themeColor="textSecondary" style={styles.tagline}>
            Know how your content will land — before you post. Brain-model predictions for video and
            audio.
          </ThemedText>
        </View>

        <View style={styles.actions}>
          <Link href="/sign-up" asChild>
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.primary,
                { backgroundColor: theme.accent, opacity: pressed ? 0.85 : 1 },
              ]}
            >
              <ThemedText type="default" style={{ color: theme.onAccent }}>
                Get started
              </ThemedText>
            </Pressable>
          </Link>
          <Link href="/sign-in" asChild>
            <Pressable accessibilityRole="button" style={styles.secondary}>
              <ThemedText type="default" themeColor="textSecondary">
                I already have an account
              </ThemedText>
            </Pressable>
          </Link>
        </View>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  safe: {
    flex: 1,
    paddingHorizontal: Spacing.four,
    justifyContent: 'space-between',
  },
  hero: {
    flex: 1,
    justifyContent: 'center',
    gap: Spacing.three,
  },
  tagline: {
    maxWidth: 320,
  },
  actions: {
    gap: Spacing.two,
    paddingBottom: Spacing.four,
  },
  primary: {
    alignItems: 'center',
    borderRadius: 14,
    paddingVertical: Spacing.three,
  },
  secondary: {
    alignItems: 'center',
    paddingVertical: Spacing.three,
  },
});
