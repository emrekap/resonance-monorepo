import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    'EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_KEY are not set — see apps/mobile/.env.example',
  );
}

/**
 * The Supabase client — auth only, from this app's point of view. Data goes
 * through the Bun API (`@repo/api-contract`), authenticated with the access
 * token this client holds; the app never queries Postgres directly.
 *
 * `flowType: 'pkce'` because the OAuth round trip leaves the app for a browser
 * tab: the authorization code returned on the deep link is useless without the
 * verifier held here. `detectSessionInUrl` is a web-only affordance.
 */
export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
    flowType: 'pkce',
  },
});

// Refresh only while foregrounded: a backgrounded app cannot rotate a token
// that expires mid-sleep, so pause the timer and let the next `getSession()`
// refresh on demand instead.
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}
