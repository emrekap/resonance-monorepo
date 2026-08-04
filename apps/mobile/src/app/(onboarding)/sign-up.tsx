import { Link } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { SocialAuthPanel } from '@/components/social-auth-panel';
import { Screen, Text } from '@/components/ui';
import { useTheme } from '@/design';

export default function SignUpScreen() {
  const theme = useTheme();

  return (
    <Screen>
      <View style={{ gap: theme.space.sm, marginTop: theme.space.base }}>
        <Text variant="title">Create your account</Text>
        <Text variant="body" tone="secondary">
          Your workspace is created automatically — connect your channels once you&apos;re in.
        </Text>
      </View>

      <SocialAuthPanel />

      <View style={[styles.footer, { gap: theme.space.base }]}>
        <Text variant="label" tone="secondary" style={styles.legal}>
          By continuing you agree to the Terms of Service and Privacy Policy.
        </Text>
        <Text variant="label" tone="secondary">
          Already have an account?{' '}
          <Link href="/sign-in" replace>
            <Text variant="labelStrong" tone="accent">
              Sign in
            </Text>
          </Link>
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  footer: {
    alignItems: 'center',
  },
  legal: {
    textAlign: 'center',
  },
});
