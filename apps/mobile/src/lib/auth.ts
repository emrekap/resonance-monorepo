import type { Provider, Session } from '@supabase/supabase-js';
import { makeRedirectUri } from 'expo-auth-session';
import * as QueryParams from 'expo-auth-session/build/QueryParams';
import * as WebBrowser from 'expo-web-browser';

import { supabase } from './supabase';

// Closes the pending auth popup on web after the redirect lands. No-op native.
WebBrowser.maybeCompleteAuthSession();

/**
 * Where Supabase sends the browser back to: `resonance://` in a build,
 * `exp://.../--/` in Expo Go. Must be allowlisted under Auth → URL
 * Configuration → Redirect URLs in the Supabase dashboard.
 */
export const authRedirectTo = makeRedirectUri();

/**
 * Turn an OAuth redirect URL into a session. PKCE hands back `?code=`, which
 * only this app instance can exchange (it holds the verifier). URLs without a
 * code — e.g. the connect-account return links the API redirects to — are not
 * auth callbacks and resolve to null rather than throwing.
 */
export async function createSessionFromUrl(url: string): Promise<Session | null> {
  const { params, errorCode } = QueryParams.getQueryParams(url);
  if (errorCode) throw new Error(errorCode);
  if (params.error_description) throw new Error(params.error_description);
  if (!params.code) return null;

  const { data, error } = await supabase.auth.exchangeCodeForSession(params.code);
  if (error) throw error;
  return data.session;
}

/**
 * Sign in (or up — OAuth does not distinguish) with a social provider.
 *
 * The browser flow rather than per-provider native SDKs on purpose: one code
 * path serves Google today and Facebook/TikTok later with zero native config
 * beyond the app scheme, and it runs in Expo Go. Swap Google to
 * `signInWithIdToken` + `@react-native-google-signin` later if the tab hop
 * hurts conversion.
 *
 * Returns null when the user closes the browser without finishing.
 */
export async function signInWithProvider(provider: Provider): Promise<Session | null> {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: authRedirectTo, skipBrowserRedirect: true },
  });
  console.log('data: ', data);
  console.log('error: ', error);
  console.log(new URL(data.url ?? 'https://anan.com').searchParams.get('redirect_to'));

  if (error) throw error;

  const result = await WebBrowser.openAuthSessionAsync(data.url, authRedirectTo);
  if (result.type !== 'success') return null;
  return createSessionFromUrl(result.url);
}
