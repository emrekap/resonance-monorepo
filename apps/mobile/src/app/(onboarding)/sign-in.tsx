import { Link } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { SocialAuthPanel } from '@/components/social-auth-panel';
import { Screen, Text } from '@/components/ui';
import { useTheme } from '@/design';

export default function SignInScreen() {
  const theme = useTheme();

  return (
    <Screen>
      <View style={{ gap: theme.space.sm, marginTop: theme.space.base }}>
        <Text variant="title">Welcome back</Text>
        <Text variant="body" tone="secondary">
          Sign in with the account you used before.
        </Text>
      </View>

      <SocialAuthPanel />

      <View style={styles.footer}>
        <Text variant="label" tone="secondary">
          New to Resonance?{' '}
          <Link href="/sign-up" replace>
            <Text variant="labelStrong" tone="accent">
              Create an account
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
});
