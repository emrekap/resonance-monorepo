import { Stack } from 'expo-router';

/**
 * The signed-out flow: a full-screen welcome, with sign-in / sign-up as
 * modals on top. The root layout only mounts this group when there is no
 * session, so nothing here checks auth.
 */
export default function OnboardingLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="sign-in" options={{ presentation: 'modal', title: 'Sign in' }} />
      <Stack.Screen name="sign-up" options={{ presentation: 'modal', title: 'Create account' }} />
    </Stack>
  );
}
