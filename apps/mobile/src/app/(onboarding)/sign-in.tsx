import { Link } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { SocialAuthPanel } from '@/components/social-auth-panel';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';

export default function SignInScreen() {
  return (
    <ThemedView style={styles.root}>
      <View style={styles.copy}>
        <ThemedText type="subtitle">Welcome back</ThemedText>
        <ThemedText type="default" themeColor="textSecondary">
          Sign in with the account you used before.
        </ThemedText>
      </View>

      <SocialAuthPanel />

      <View style={styles.footer}>
        <ThemedText type="small" themeColor="textSecondary">
          New to Resonance?{' '}
          <Link href="/sign-up" replace>
            <ThemedText type="smallBold" themeColor="accent">
              Create an account
            </ThemedText>
          </Link>
        </ThemedText>
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    padding: Spacing.four,
    gap: Spacing.five,
  },
  copy: {
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
  footer: {
    alignItems: 'center',
  },
});
