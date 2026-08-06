import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { invalidationKeys } from '@/lib/query-keys';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/providers/session-provider';

/**
 * Push, not poll: `analyses` status changes arrive over Supabase Realtime and
 * invalidate the queries that render them.
 *
 * The payload is only ever a signal. A list row needs `analysis_results` and
 * `media_assets` too — `GET /analyze` joins all three — so the row shape stays
 * the API's to define and this hook only answers *when* to ask again. That is
 * safe because apps/worker commits the result row and the SUCCEEDED status in
 * one transaction (`apps/worker/src/results.ts`), so the score is always
 * readable by the time the event lands.
 *
 * Mounted once, in the `(app)` layout: a per-screen subscription would tear
 * down and rebuild a websocket on every push between History and a detail
 * screen, and a run started from Home should reach the History tab already
 * mounted behind it.
 *
 * Delivery depends on `20260805140000_realtime_analyses` — Realtime hands a row
 * only to a role with column privileges on it, and without that grant this
 * subscribes successfully and then receives nothing.
 */
export function useAnalysisRealtime(): void {
  const queryClient = useQueryClient();
  const { session } = useSession();
  const userId = session?.user.id;

  useEffect(() => {
    if (!userId) return;

    const invalidate = (id?: string) => {
      for (const queryKey of invalidationKeys(id)) {
        void queryClient.invalidateQueries({ queryKey });
      }
    };

    // No `filter`: RLS already restricts delivery to the caller's workspaces,
    // and a `workspace_id` filter would need an id this client never learns.
    // No `setAuth` either — supabase-js pushes the token to the socket on
    // SIGNED_IN / INITIAL_SESSION / TOKEN_REFRESHED, so the hourly refresh
    // re-auths this channel without resubscribing.
    const channel = supabase
      .channel('analyses')
      .on<{ id: string }>(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'analyses' },
        (payload) => invalidate('id' in payload.new ? payload.new.id : undefined),
      )
      .subscribe();

    // A backgrounded app's socket drops and the events it missed are not
    // replayed. This is not a poll — it fires on resume only — but without it
    // "no more polling" would read as "stale after every backgrounding".
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') invalidate();
    });

    return () => {
      appState.remove();
      void supabase.removeChannel(channel);
    };
    // Keyed on `userId`, not `session`: the session object's identity changes
    // on every token refresh, which would rebuild a working channel hourly.
  }, [userId, queryClient]);
}
