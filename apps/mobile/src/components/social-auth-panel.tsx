import type { Provider } from '@supabase/supabase-js';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { SocialButton } from '@/components/social-button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { signInWithProvider } from '@/lib/auth';
import { LOGIN_PROVIDERS } from '@/lib/social';

/**
 * The provider stack both auth screens share — OAuth has no real
 * sign-in/sign-up distinction, so the screens differ only in copy.
 *
 * No navigation on success: the session lands in `SessionProvider`, the root
 * layout's `Stack.Protected` guard flips, and the router swaps stacks.
 */
export function SocialAuthPanel() {
  const [busyProvider, setBusyProvider] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handlePress = async (provider: Provider) => {
    setError(null);
    setBusyProvider(provider);
    try {
      await signInWithProvider(provider);
      // null = user closed the browser — stay on the screen, no error.
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in failed. Please try again.');
    } finally {
      setBusyProvider(null);
    }
  };

  return (
    <View style={styles.stack}>
      {LOGIN_PROVIDERS.map((entry) => (
        <SocialButton
          key={entry.provider}
          label={entry.label}
          glyph={entry.glyph}
          comingSoon={!entry.available}
          busy={busyProvider === entry.provider}
          disabled={busyProvider !== null}
          onPress={() => handlePress(entry.provider)}
        />
      ))}
      {error ? (
        <ThemedText type="small" themeColor="danger" style={styles.error}>
          {error}
        </ThemedText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: Spacing.two,
  },
  error: {
    textAlign: 'center',
    marginTop: Spacing.two,
  },
});
