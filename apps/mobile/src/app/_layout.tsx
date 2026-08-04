import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Linking from 'expo-linking';
import {
  DarkTheme,
  DefaultTheme,
  Stack,
  ThemeProvider as NavigationThemeProvider,
} from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useMemo } from 'react';

import { ThemeProvider, useTheme, useThemePreference } from '@/design';
import { createSessionFromUrl } from '@/lib/auth';
import { SessionProvider, useSession } from '@/providers/session-provider';

void SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function RootNavigator() {
  const { session, isLoading } = useSession();
  const { isReady: themeReady, scheme } = useThemePreference();
  const theme = useTheme();

  // Fallback for OAuth redirects that arrive as a plain deep link instead of
  // through `openAuthSessionAsync` (cold starts, some Android browsers).
  // URLs without a `?code=` — like the connect-account returns — resolve to
  // null inside, and a code the in-flow handler already exchanged just throws
  // into this catch.
  const url = Linking.useLinkingURL();
  useEffect(() => {
    if (url) createSessionFromUrl(url).catch(() => {});
  }, [url]);

  const ready = !isLoading && themeReady;

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  // Without this the window behind the navigator stays the platform default,
  // which flashes white during screen transitions in dark mode.
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(theme.colors.canvas);
  }, [theme.colors.canvas]);

  // React Navigation owns header/card chrome, so it needs the same palette.
  // `fonts` is required by its Theme type and has no Ultraviolet equivalent.
  const navigationTheme = useMemo(() => {
    const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      dark: scheme === 'dark',
      colors: {
        ...base.colors,
        primary: theme.colors.accent,
        background: theme.colors.canvas,
        card: theme.colors.surface,
        text: theme.colors.text,
        border: theme.colors.border,
        notification: theme.colors.danger,
      },
    };
  }, [scheme, theme]);

  // Keep the splash up rather than flashing onboarding at a signed-in user,
  // or the wrong theme at anyone.
  if (!ready) return null;

  return (
    <NavigationThemeProvider value={navigationTheme}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Protected guard={session !== null}>
          <Stack.Screen name="(app)" />
        </Stack.Protected>
        <Stack.Protected guard={session === null}>
          <Stack.Screen name="(onboarding)" />
        </Stack.Protected>
      </Stack>
      {/* Explicit, not "auto": auto follows the OS and would be wrong the
          moment a user overrides the theme. */}
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
    </NavigationThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <RootNavigator />
        </SessionProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
