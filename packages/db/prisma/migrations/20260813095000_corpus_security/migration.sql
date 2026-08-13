-- ─────────────────────────────────────────────────────────────────────────────
-- Security for the `corpus` schema. Hand-written — never regenerate.
--
-- `CLAUDE.md` requires every new table to carry a policy rooted at
-- workspace_id or profile_id. Corpus tables have no tenant, so that rule cannot
-- be followed literally. It is followed in INTENT: RLS enabled AND forced, with
-- ZERO policies. Forced RLS plus no policy denies every role — only the
-- BYPASSRLS service credential passes. That is strictly stricter than a
-- workspace policy, and it fails closed: a future accidental GRANT still
-- reaches nothing.
--
-- The reason the convention exists in the first place is that `public` is
-- reachable by client roles through PostgREST. `corpus` grants nothing to anon
-- or authenticated at all, which removes the exposure the convention was
-- written to prevent. (Supabase also exposes only the schemas listed in its
-- PostgREST `db-schemas` setting, and `corpus` is not among them — but that is
-- a config file, so the grants below do not rely on it.)
--
-- See spec §3c, and `packages/db/scripts/check-rls.ts` for the assertions that
-- keep this true.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. app_service only ─────────────────────────────────────────────────────
-- apps/poller is the only process that touches these tables, and it connects as
-- app_service for the same reason apps/worker does: writing rows for no tenant
-- cannot go through withUser()/RLS. app_user is deliberately absent — the API
-- has no business reading a research corpus.

GRANT USAGE ON SCHEMA corpus TO app_service;
GRANT ALL ON ALL TABLES IN SCHEMA corpus TO app_service;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA corpus TO app_service;

-- Tables added by future migrations inherit the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA corpus GRANT ALL ON TABLES TO app_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA corpus GRANT USAGE, SELECT ON SEQUENCES TO app_service;

-- ─── 2. Nothing for the client roles, now or later ───────────────────────────
-- PUBLIC is revoked too: a role that inherits from PUBLIC would otherwise pick
-- up schema USAGE without anyone granting it.

REVOKE ALL ON SCHEMA corpus FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA corpus FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA corpus FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA corpus REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA corpus REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;

-- ─── 3. RLS enabled + forced, zero policies ──────────────────────────────────
-- FORCE matters: without it the table owner (postgres, which created them)
-- bypasses RLS silently, and the posture would be a comment rather than a rule.

DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'corpus' LOOP
    EXECUTE format('ALTER TABLE corpus.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('ALTER TABLE corpus.%I FORCE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;

-- Assert the posture rather than assume it: a table added to `corpus` by a
-- later migration that forgets §3 must fail HERE, on deploy, not in a breach.
DO $$
DECLARE unprotected text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO unprotected
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'corpus' AND c.relkind = 'r'
    AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);
  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION 'corpus tables without RLS enabled+forced: %', unprotected;
  END IF;
END $$;
