-- Realtime on public.analyses.
--
-- apps/mobile replaces its status polls (the History list and analysis/[id])
-- with a Postgres Changes subscription. Two things have to be true for that,
-- and the first one walks back part of `20260802191500_security_rls` §6.
--
-- §6 revoked every table privilege from `anon` and `authenticated` on purpose:
-- clients read through apps/api, never PostgREST. Realtime cannot honour that.
-- `realtime.apply_rls` decides what a subscriber sees using
-- `pg_catalog.has_column_privilege(<the JWT's role>, ...)`, so a role holding
-- no privilege receives nothing — silently, from the client's side.
--
-- It calls `has_column_privilege` exclusively and never `has_table_privilege`,
-- which is what makes a column-scoped grant work. The list below is the
-- narrowest set that delivers an event:
--
--   * `id` is mandatory. apply_rls short-circuits to "Error 401: Unauthorized"
--     for any non-DELETE event whose primary key is not selectable.
--   * `workspace_id` is mandatory. It is what `analyses_select` is rooted at,
--     and what the RLS probe resolves membership through.
--   * the rest is what a client needs to decide a cached row is stale.
--
-- Deliberately excluded: `error`, `credits_charged`, `model_version_id`,
-- `requested_by_id`. apply_rls builds the payload from selectable columns only,
-- so those never leave the database. The payload is a signal to refetch through
-- apps/api — which still returns them under its own authz — not a row.
--
-- The cost, stated plainly: `analyses` becomes readable over PostgREST to any
-- signed-in user, bounded to these seven columns and still row-scoped by the
-- unchanged `analyses_select` policy against forced RLS.

GRANT SELECT (id, workspace_id, media_asset_id, status, created_at, started_at, completed_at)
  ON public.analyses TO authenticated;

-- Replica identity stays DEFAULT. `full` only populates `old_record`, which
-- apply_rls truncates to the primary key whenever RLS is enabled anyway.
ALTER PUBLICATION supabase_realtime ADD TABLE public.analyses;
