-- ─────────────────────────────────────────────────────────────────────────────
-- Security layer. Entirely hand-written — Prisma cannot express any of it, so
-- never regenerate this file. See packages/db/README.md.
--
-- Threat model: the API is the only thing that touches these tables, but a
-- forgotten `where` clause in a route must not leak one user's data to another.
-- So the API connects as `app_user`, a role that (a) does not own the tables and
-- (b) has no BYPASSRLS — meaning policies genuinely bind to it. The queue worker
-- connects as `app_service`, which does have BYPASSRLS, because writing an ML
-- result or sweeping expired platform data legitimately crosses users.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Roles ────────────────────────────────────────────────────────────────
-- Passwords are set out of band (scripts/set-role-passwords.ts) so they never
-- land in a committed migration. Roles are cluster-level, hence the guards.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_service') THEN
    CREATE ROLE app_service LOGIN BYPASSRLS;
  END IF;
END $$;

-- The entire design rests on app_user being unable to bypass RLS, so assert it
-- rather than assume it. (Supabase's `postgres` is not a superuser and may not
-- ALTER these attributes, so this is a check, not a fix — if it ever fires,
-- someone escalated the role out of band and the migration must not proceed.)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'app_user' AND (rolbypassrls OR rolsuper)
  ) THEN
    RAISE EXCEPTION
      'app_user has BYPASSRLS/SUPERUSER — RLS would not bind to the API connection';
  END IF;
END $$;

-- Policies are written `TO authenticated`. A policy's TO clause matches by role
-- *membership*, so granting app_user membership in `authenticated` is what makes
-- every one of them apply to the API's connection. NOINHERIT on app_user means
-- it does not passively absorb authenticated's table privileges — it only gets
-- the explicit grants below.
GRANT authenticated TO app_user;

GRANT USAGE ON SCHEMA public TO app_user, app_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
GRANT ALL ON ALL TABLES IN SCHEMA public TO app_service;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_service;

-- Tables added by future migrations inherit the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO app_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_service;

-- ─── 2. Keep the Data API closed for app tables ──────────────────────────────
-- Clients use supabase-js for auth + Storage only; all table I/O goes through
-- the Hono API. Supabase's default privileges would otherwise expose these
-- tables through PostgREST to anon/authenticated. RLS controls which *rows* are
-- visible; this controls whether the table is reachable at all.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;

-- ─── 3. Tenancy helpers ──────────────────────────────────────────────────────
-- SECURITY DEFINER so the membership lookup inside is not itself filtered by the
-- policy that calls it (which would recurse). Owned by `postgres`, which carries
-- BYPASSRLS. Each one checks auth.uid() internally, lives in the non-exposed
-- `private` schema, and has EXECUTE revoked from every public role.

CREATE OR REPLACE FUNCTION private.is_workspace_member(p_workspace_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_members m
    WHERE m.workspace_id = p_workspace_id
      AND m.profile_id = (SELECT auth.uid())
  );
$$;

CREATE OR REPLACE FUNCTION private.has_workspace_role(p_workspace_id uuid, p_roles text[])
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_members m
    WHERE m.workspace_id = p_workspace_id
      AND m.profile_id = (SELECT auth.uid())
      AND m.role::text = ANY(p_roles)
  );
$$;

CREATE OR REPLACE FUNCTION private.shares_workspace_with(p_profile_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspace_members me
    JOIN public.workspace_members them ON them.workspace_id = me.workspace_id
    WHERE me.profile_id = (SELECT auth.uid())
      AND them.profile_id = p_profile_id
  );
$$;

CREATE OR REPLACE FUNCTION private.can_access_analysis(p_analysis_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.analyses a
    JOIN public.workspace_members m ON m.workspace_id = a.workspace_id
    WHERE a.id = p_analysis_id AND m.profile_id = (SELECT auth.uid())
  );
$$;

CREATE OR REPLACE FUNCTION private.can_access_post(p_post_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.posts p
    JOIN public.workspace_members m ON m.workspace_id = p.workspace_id
    WHERE p.id = p_post_id AND m.profile_id = (SELECT auth.uid())
  );
$$;

CREATE OR REPLACE FUNCTION private.can_access_comparison(p_comparison_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.comparisons c
    JOIN public.workspace_members m ON m.workspace_id = c.workspace_id
    WHERE c.id = p_comparison_id AND m.profile_id = (SELECT auth.uid())
  );
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO app_user, app_service;

-- ─── 4. Link profiles to Supabase Auth ───────────────────────────────────────
-- `profiles.id` mirrors `auth.users.id`, but there is deliberately NO foreign
-- key. A cross-schema FK forces `auth` into the datasource's `schemas` list, and
-- the moment Prisma can see that schema it treats every GoTrue table it does not
-- know about (sessions, identities, sso_*, webauthn_*, …) as drift to be reset —
-- and GoTrue adds tables across versions, so that breaks on somebody else's
-- release schedule.
--
-- Both directions are covered by triggers instead, which is equivalent in
-- practice because profiles are only ever created by the trigger below:
--   INSERT on auth.users -> create the profile (and its personal workspace)
--   DELETE on auth.users -> delete the profile, cascading through public FKs

-- New auth user -> profile + personal workspace + owner membership + balance,
-- atomically. NOTE: raw_user_meta_data is user-editable, so it is safe as a
-- display-name default and unsafe for anything authorization-related.
CREATE OR REPLACE FUNCTION private.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_workspace_id uuid;
BEGIN
  INSERT INTO public.profiles (id, display_name, avatar_url)
  VALUES (
    NEW.id,
    NULLIF(NEW.raw_user_meta_data ->> 'name', ''),
    NULLIF(NEW.raw_user_meta_data ->> 'avatar_url', '')
  );

  INSERT INTO public.workspaces (kind, name, slug)
  VALUES ('PERSONAL', 'Personal', 'w-' || replace(NEW.id::text, '-', ''))
  RETURNING id INTO v_workspace_id;

  INSERT INTO public.workspace_members (workspace_id, profile_id, role)
  VALUES (v_workspace_id, NEW.id, 'OWNER');

  INSERT INTO public.credit_balances (workspace_id, balance)
  VALUES (v_workspace_id, 0);

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION private.handle_new_user();

-- Stands in for the ON DELETE CASCADE we cannot declare. Removing the profile
-- cascades onward through the public-schema foreign keys, so a deleted auth user
-- takes their workspaces, media, analyses and connected accounts with them.
CREATE OR REPLACE FUNCTION private.handle_deleted_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM public.profiles WHERE id = OLD.id;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS on_auth_user_deleted ON auth.users;
CREATE TRIGGER on_auth_user_deleted
  AFTER DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION private.handle_deleted_user();

-- Creating a team workspace is a legitimate user action, but an INSERT policy
-- on `workspaces` cannot express it: the membership row that would authorize it
-- does not exist yet. So there is no INSERT policy — creation goes through this
-- function, which makes the caller the OWNER in the same transaction.
CREATE OR REPLACE FUNCTION public.create_workspace(p_name text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_workspace_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.workspaces (kind, name, slug)
  VALUES ('TEAM', p_name, 'w-' || replace(public.uuid_generate_v7()::text, '-', ''))
  RETURNING id INTO v_workspace_id;

  INSERT INTO public.workspace_members (workspace_id, profile_id, role)
  VALUES (v_workspace_id, v_uid, 'OWNER');

  INSERT INTO public.credit_balances (workspace_id, balance)
  VALUES (v_workspace_id, 0);

  RETURN v_workspace_id;
END $$;

REVOKE EXECUTE ON FUNCTION public.create_workspace(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_workspace(text) TO app_user, app_service;

-- ─── 5. Enable + force RLS on every table in public ──────────────────────────
-- Done in a loop so a table can never be added and silently left unprotected.

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;

-- ─── 6. Policies ─────────────────────────────────────────────────────────────
-- Rules applied throughout:
--   * every auth.uid()/helper call is wrapped in (SELECT ...) so Postgres
--     evaluates it once per query instead of once per row;
--   * every UPDATE policy has both USING and WITH CHECK, otherwise a user could
--     reassign a row into someone else's workspace;
--   * no policy is `TO authenticated` alone — each carries an ownership
--     predicate, or it would be authentication without authorization.
--
-- Tables with no INSERT/UPDATE/DELETE policy are deliberately read-only to the
-- API: results, metrics, labels, features and the credit ledger are written by
-- the worker through app_service. A user must not be able to mint their own
-- credits or fabricate their own analytics.

-- profiles: yourself, plus people you share a workspace with.
CREATE POLICY profiles_select ON public.profiles
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = id OR (SELECT private.shares_workspace_with(id)));

CREATE POLICY profiles_update ON public.profiles
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = id)
  WITH CHECK ((SELECT auth.uid()) = id);

-- workspaces: keyed on `id`, not `workspace_id`. No INSERT policy on purpose
-- (see public.create_workspace above).
CREATE POLICY workspaces_select ON public.workspaces
  FOR SELECT TO authenticated
  USING ((SELECT private.is_workspace_member(id)));

CREATE POLICY workspaces_update ON public.workspaces
  FOR UPDATE TO authenticated
  USING ((SELECT private.has_workspace_role(id, ARRAY['OWNER','ADMIN'])))
  WITH CHECK ((SELECT private.has_workspace_role(id, ARRAY['OWNER','ADMIN'])));

CREATE POLICY workspaces_delete ON public.workspaces
  FOR DELETE TO authenticated
  USING ((SELECT private.has_workspace_role(id, ARRAY['OWNER'])));

CREATE POLICY workspace_members_select ON public.workspace_members
  FOR SELECT TO authenticated
  USING ((SELECT private.is_workspace_member(workspace_id)));

CREATE POLICY workspace_members_insert ON public.workspace_members
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.has_workspace_role(workspace_id, ARRAY['OWNER','ADMIN'])));

CREATE POLICY workspace_members_update ON public.workspace_members
  FOR UPDATE TO authenticated
  USING ((SELECT private.has_workspace_role(workspace_id, ARRAY['OWNER','ADMIN'])))
  WITH CHECK ((SELECT private.has_workspace_role(workspace_id, ARRAY['OWNER','ADMIN'])));

CREATE POLICY workspace_members_delete ON public.workspace_members
  FOR DELETE TO authenticated
  USING ((SELECT private.has_workspace_role(workspace_id, ARRAY['OWNER','ADMIN'])));

-- Workspace-owned tables the API writes directly.
CREATE POLICY connected_accounts_select ON public.connected_accounts
  FOR SELECT TO authenticated USING ((SELECT private.is_workspace_member(workspace_id)));
CREATE POLICY connected_accounts_insert ON public.connected_accounts
  FOR INSERT TO authenticated WITH CHECK ((SELECT private.is_workspace_member(workspace_id)));
CREATE POLICY connected_accounts_update ON public.connected_accounts
  FOR UPDATE TO authenticated
  USING ((SELECT private.is_workspace_member(workspace_id)))
  WITH CHECK ((SELECT private.is_workspace_member(workspace_id)));
CREATE POLICY connected_accounts_delete ON public.connected_accounts
  FOR DELETE TO authenticated
  USING ((SELECT private.has_workspace_role(workspace_id, ARRAY['OWNER','ADMIN'])));

CREATE POLICY channels_select ON public.channels
  FOR SELECT TO authenticated USING ((SELECT private.is_workspace_member(workspace_id)));
CREATE POLICY channels_insert ON public.channels
  FOR INSERT TO authenticated WITH CHECK ((SELECT private.is_workspace_member(workspace_id)));
CREATE POLICY channels_update ON public.channels
  FOR UPDATE TO authenticated
  USING ((SELECT private.is_workspace_member(workspace_id)))
  WITH CHECK ((SELECT private.is_workspace_member(workspace_id)));
CREATE POLICY channels_delete ON public.channels
  FOR DELETE TO authenticated
  USING ((SELECT private.has_workspace_role(workspace_id, ARRAY['OWNER','ADMIN'])));

CREATE POLICY media_assets_select ON public.media_assets
  FOR SELECT TO authenticated USING ((SELECT private.is_workspace_member(workspace_id)));
CREATE POLICY media_assets_insert ON public.media_assets
  FOR INSERT TO authenticated WITH CHECK ((SELECT private.is_workspace_member(workspace_id)));
CREATE POLICY media_assets_update ON public.media_assets
  FOR UPDATE TO authenticated
  USING ((SELECT private.is_workspace_member(workspace_id)))
  WITH CHECK ((SELECT private.is_workspace_member(workspace_id)));
CREATE POLICY media_assets_delete ON public.media_assets
  FOR DELETE TO authenticated USING ((SELECT private.is_workspace_member(workspace_id)));

CREATE POLICY analyses_select ON public.analyses
  FOR SELECT TO authenticated USING ((SELECT private.is_workspace_member(workspace_id)));
CREATE POLICY analyses_insert ON public.analyses
  FOR INSERT TO authenticated WITH CHECK ((SELECT private.is_workspace_member(workspace_id)));
CREATE POLICY analyses_update ON public.analyses
  FOR UPDATE TO authenticated
  USING ((SELECT private.is_workspace_member(workspace_id)))
  WITH CHECK ((SELECT private.is_workspace_member(workspace_id)));
CREATE POLICY analyses_delete ON public.analyses
  FOR DELETE TO authenticated
  USING ((SELECT private.has_workspace_role(workspace_id, ARRAY['OWNER','ADMIN'])));

CREATE POLICY comparisons_select ON public.comparisons
  FOR SELECT TO authenticated USING ((SELECT private.is_workspace_member(workspace_id)));
CREATE POLICY comparisons_insert ON public.comparisons
  FOR INSERT TO authenticated WITH CHECK ((SELECT private.is_workspace_member(workspace_id)));
CREATE POLICY comparisons_update ON public.comparisons
  FOR UPDATE TO authenticated
  USING ((SELECT private.is_workspace_member(workspace_id)))
  WITH CHECK ((SELECT private.is_workspace_member(workspace_id)));
CREATE POLICY comparisons_delete ON public.comparisons
  FOR DELETE TO authenticated USING ((SELECT private.is_workspace_member(workspace_id)));

CREATE POLICY posts_select ON public.posts
  FOR SELECT TO authenticated USING ((SELECT private.is_workspace_member(workspace_id)));
CREATE POLICY posts_insert ON public.posts
  FOR INSERT TO authenticated WITH CHECK ((SELECT private.is_workspace_member(workspace_id)));
CREATE POLICY posts_update ON public.posts
  FOR UPDATE TO authenticated
  USING ((SELECT private.is_workspace_member(workspace_id)))
  WITH CHECK ((SELECT private.is_workspace_member(workspace_id)));
CREATE POLICY posts_delete ON public.posts
  FOR DELETE TO authenticated
  USING ((SELECT private.has_workspace_role(workspace_id, ARRAY['OWNER','ADMIN'])));

CREATE POLICY api_keys_select ON public.api_keys
  FOR SELECT TO authenticated USING ((SELECT private.is_workspace_member(workspace_id)));
CREATE POLICY api_keys_insert ON public.api_keys
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.has_workspace_role(workspace_id, ARRAY['OWNER','ADMIN'])));
CREATE POLICY api_keys_update ON public.api_keys
  FOR UPDATE TO authenticated
  USING ((SELECT private.has_workspace_role(workspace_id, ARRAY['OWNER','ADMIN'])))
  WITH CHECK ((SELECT private.has_workspace_role(workspace_id, ARRAY['OWNER','ADMIN'])));
CREATE POLICY api_keys_delete ON public.api_keys
  FOR DELETE TO authenticated
  USING ((SELECT private.has_workspace_role(workspace_id, ARRAY['OWNER','ADMIN'])));

-- Child tables: reach through the parent.
CREATE POLICY comparison_entries_select ON public.comparison_entries
  FOR SELECT TO authenticated USING ((SELECT private.can_access_comparison(comparison_id)));
CREATE POLICY comparison_entries_insert ON public.comparison_entries
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.can_access_comparison(comparison_id))
          AND (SELECT private.can_access_analysis(analysis_id)));
CREATE POLICY comparison_entries_update ON public.comparison_entries
  FOR UPDATE TO authenticated
  USING ((SELECT private.can_access_comparison(comparison_id)))
  WITH CHECK ((SELECT private.can_access_comparison(comparison_id)));
CREATE POLICY comparison_entries_delete ON public.comparison_entries
  FOR DELETE TO authenticated USING ((SELECT private.can_access_comparison(comparison_id)));

-- Read-only to the API — written by the worker via app_service.
CREATE POLICY inference_runs_select ON public.inference_runs
  FOR SELECT TO authenticated USING ((SELECT private.can_access_analysis(analysis_id)));

CREATE POLICY analysis_results_select ON public.analysis_results
  FOR SELECT TO authenticated USING ((SELECT private.can_access_analysis(analysis_id)));

CREATE POLICY analysis_axis_scores_select ON public.analysis_axis_scores
  FOR SELECT TO authenticated USING ((SELECT private.can_access_analysis(analysis_id)));

CREATE POLICY analysis_recommendations_select ON public.analysis_recommendations
  FOR SELECT TO authenticated USING ((SELECT private.can_access_analysis(analysis_id)));

CREATE POLICY post_metric_snapshots_select ON public.post_metric_snapshots
  FOR SELECT TO authenticated USING ((SELECT private.can_access_post(post_id)));

CREATE POLICY post_retention_curves_select ON public.post_retention_curves
  FOR SELECT TO authenticated USING ((SELECT private.can_access_post(post_id)));

CREATE POLICY post_labels_select ON public.post_labels
  FOR SELECT TO authenticated USING ((SELECT private.can_access_post(post_id)));

-- feature_artifacts hangs off an analysis OR a post; both columns are nullable.
CREATE POLICY feature_artifacts_select ON public.feature_artifacts
  FOR SELECT TO authenticated
  USING (
    (analysis_id IS NOT NULL AND (SELECT private.can_access_analysis(analysis_id)))
    OR (post_id IS NOT NULL AND (SELECT private.can_access_post(post_id)))
  );

-- Credits: readable by members, writable only by app_service. A user must never
-- be able to insert themselves a TRIAL_GRANT.
CREATE POLICY credit_balances_select ON public.credit_balances
  FOR SELECT TO authenticated USING ((SELECT private.is_workspace_member(workspace_id)));

CREATE POLICY credit_transactions_select ON public.credit_transactions
  FOR SELECT TO authenticated USING ((SELECT private.is_workspace_member(workspace_id)));

-- Shared registry: every authenticated user may read it, nobody may write it.
CREATE POLICY model_versions_select ON public.model_versions
  FOR SELECT TO authenticated USING (true);

-- Deletion requests: a user can file one for their own profile or a workspace
-- they belong to. Fulfilment is the worker's job, so there is no UPDATE policy.
CREATE POLICY data_deletion_requests_select ON public.data_deletion_requests
  FOR SELECT TO authenticated
  USING (
    (workspace_id IS NOT NULL AND (SELECT private.is_workspace_member(workspace_id)))
    OR (profile_id IS NOT NULL AND profile_id = (SELECT auth.uid()))
  );

CREATE POLICY data_deletion_requests_insert ON public.data_deletion_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    (workspace_id IS NOT NULL AND (SELECT private.is_workspace_member(workspace_id)))
    OR (profile_id IS NOT NULL AND profile_id = (SELECT auth.uid()))
  );

-- ─── 7. Storage ──────────────────────────────────────────────────────────────
-- Private bucket. Object paths are `{workspace_id}/{media_asset_id}`, so the
-- first path segment is the tenancy key. INSERT + SELECT + UPDATE are all
-- granted together because an upsert that lacks any one of them fails silently.

INSERT INTO storage.buckets (id, name, public)
VALUES ('media', 'media', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS media_workspace_read ON storage.objects;
CREATE POLICY media_workspace_read ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'media'
    AND (SELECT private.is_workspace_member(((storage.foldername(name))[1])::uuid))
  );

DROP POLICY IF EXISTS media_workspace_insert ON storage.objects;
CREATE POLICY media_workspace_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'media'
    AND (SELECT private.is_workspace_member(((storage.foldername(name))[1])::uuid))
  );

DROP POLICY IF EXISTS media_workspace_update ON storage.objects;
CREATE POLICY media_workspace_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'media'
    AND (SELECT private.is_workspace_member(((storage.foldername(name))[1])::uuid))
  )
  WITH CHECK (
    bucket_id = 'media'
    AND (SELECT private.is_workspace_member(((storage.foldername(name))[1])::uuid))
  );

DROP POLICY IF EXISTS media_workspace_delete ON storage.objects;
CREATE POLICY media_workspace_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'media'
    AND (SELECT private.is_workspace_member(((storage.foldername(name))[1])::uuid))
  );

GRANT EXECUTE ON FUNCTION private.is_workspace_member(uuid) TO authenticated;

-- ─── 8. Integrity constraints Prisma cannot express ──────────────────────────
-- The attention timeline is stored as parallel arrays for compactness (it is
-- always read whole). This keeps them from drifting out of sync.

ALTER TABLE public.analysis_results
  ADD CONSTRAINT analysis_results_timeline_len_chk CHECK (
    array_length(timeline_start_sec, 1) IS NOT DISTINCT FROM array_length(timeline_attention, 1)
    AND array_length(timeline_start_sec, 1) IS NOT DISTINCT FROM array_length(timeline_visual, 1)
    AND array_length(timeline_start_sec, 1) IS NOT DISTINCT FROM array_length(timeline_audio, 1)
    AND array_length(timeline_start_sec, 1) IS NOT DISTINCT FROM array_length(timeline_language, 1)
  );

ALTER TABLE public.post_retention_curves
  ADD CONSTRAINT post_retention_curves_len_chk CHECK (
    array_length(elapsed_ratio, 1) IS NOT DISTINCT FROM array_length(audience_watch_ratio, 1)
    AND array_length(elapsed_ratio, 1) IS NOT DISTINCT FROM array_length(relative_retention_performance, 1)
  );

ALTER TABLE public.analysis_results
  ADD CONSTRAINT analysis_results_score_range_chk
  CHECK (resonance_score IS NULL OR (resonance_score BETWEEN 0 AND 100));

ALTER TABLE public.credit_balances
  ADD CONSTRAINT credit_balances_non_negative_chk CHECK (balance >= 0);
