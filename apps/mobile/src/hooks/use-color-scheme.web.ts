import { useSyncExternalStore } from 'react';
import { useColorScheme as useRNColorScheme } from 'react-native';

/** No-op: hydration flips once and never changes again, so there is nothing to subscribe to. */
const subscribe = () => () => {};

/**
 * Static rendering on web emits markup before a colour scheme is known, so the
 * first client render has to agree with the server's or hydration mismatches.
 *
 * `useSyncExternalStore` supplies `false` for the server snapshot and `true`
 * on the client, giving the same guard as a `setState`-in-effect without the
 * extra render pass that cascades from it.
 */
export function useColorScheme() {
  const hasHydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const colorScheme = useRNColorScheme();

  return hasHydrated ? colorScheme : 'light';
}
