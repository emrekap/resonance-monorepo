import { Stack } from 'expo-router';

import { useAnalysisRealtime } from '@/hooks/use-analysis-realtime';

/**
 * The signed-in shell. The root layout's `Stack.Protected` guard is the only
 * gate — by the time this mounts there is a session, so screens below just use
 * `useSession()` / the RPC client.
 *
 * A Stack wrapping the tabs, rather than the tabs themselves: `analysis/[id]`
 * and `settings` are pushed from inside a tab, and a screen only gets a back
 * button and an edge-swipe if something actually pushed a card. The tab bar
 * belongs to `(tabs)`, so those two cover it — which is the point, they are
 * destinations, not a fourth and fifth tab.
 */
export default function AppLayout() {
  // One subscription for the whole signed-in shell — see the hook for why it
  // lives here rather than in the screens that consume it.
  useAnalysisRealtime();

  return (
    <Stack>
      {/* `headerShown: false` because `(tabs)` draws its own per-tab header —
          without it there are two. `title` because hiding the header does not
          excuse the route from having a name: long-pressing back opens iOS's
          back-stack menu, which lists titles and fell back to the literal
          route name, "(tabs)". */}
      <Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'Home' }} />
      <Stack.Screen name="analysis/[id]" options={{ title: 'Analysis' }} />
      <Stack.Screen name="settings" options={{ title: 'Settings' }} />
    </Stack>
  );
}
