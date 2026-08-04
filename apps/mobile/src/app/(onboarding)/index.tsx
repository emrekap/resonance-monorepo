import { Link } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { Screen, Text } from '@/components/ui';
import { useTheme } from '@/design';

export default function WelcomeScreen() {
  const theme = useTheme();

  return (
    <Screen>
      <View style={[styles.hero, { gap: theme.space.base }]}>
        <Text variant="display" numberOfLines={1} adjustsFontSizeToFit>
          Resonance
        </Text>
        <Text variant="body" tone="secondary" style={styles.tagline}>
          Know how your content will land — before you post. Brain-model predictions for video and
          audio.
        </Text>
      </View>

      <View style={{ gap: theme.space.sm, paddingBottom: theme.space.lg }}>
        <Link href="/sign-up" asChild>
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) =>
              StyleSheet.flatten([
                styles.primary,
                {
                  backgroundColor: theme.colors.accentSurface,
                  borderRadius: theme.radius.lg,
                  paddingVertical: theme.space.base,
                  opacity: pressed ? 0.85 : 1,
                },
              ])
            }
          >
            <Text variant="body" tone="onAccent">
              Get started
            </Text>
          </Pressable>
        </Link>
        <Link href="/sign-in" asChild>
          <Pressable
            accessibilityRole="button"
            style={StyleSheet.flatten([styles.secondary, { paddingVertical: theme.space.base }])}
          >
            <Text variant="body" tone="secondary">
              I already have an account
            </Text>
          </Pressable>
        </Link>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: {
    flex: 1,
    justifyContent: 'center',
  },
  tagline: {
    maxWidth: 320,
  },
  primary: {
    alignItems: 'center',
  },
  secondary: {
    alignItems: 'center',
  },
});
