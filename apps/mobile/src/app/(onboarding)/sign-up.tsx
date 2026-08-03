import { Link } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { SocialAuthPanel } from '@/components/social-auth-panel';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';

export default function SignUpScreen() {
  return (
    <ThemedView style={styles.root}>
      <View style={styles.copy}>
        <ThemedText type="subtitle">Create your account</ThemedText>
        <ThemedText type="default" themeColor="textSecondary">
          Your workspace is created automatically — connect your channels once you're in.
        </ThemedText>
      </View>

      <SocialAuthPanel />

      <View style={styles.footer}>
        <ThemedText type="small" themeColor="textSecondary" style={styles.legal}>
          By continuing you agree to the Terms of Service and Privacy Policy.
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Already have an account?{' '}
          <Link href="/sign-in" replace>
            <ThemedText type="smallBold" themeColor="accent">
              Sign in
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
    gap: Spacing.three,
  },
  legal: {
    textAlign: 'center',
  },
});
