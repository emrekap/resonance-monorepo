import { createApiClient } from '@repo/api-contract';

import { supabase } from './supabase';

const baseUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

/**
 * The typed RPC client for the Bun API, with the Supabase access token
 * attached per request. `getSession()` refreshes an expired token before
 * handing it over, so a request fired after a long background sleep still
 * carries a live JWT.
 */
export const api = createApiClient(baseUrl, {
  fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { data } = await supabase.auth.getSession();
    const headers = new Headers(init?.headers);
    const token = data.session?.access_token;
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  }) as typeof fetch,
});
