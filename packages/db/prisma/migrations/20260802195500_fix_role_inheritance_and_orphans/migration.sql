-- ─────────────────────────────────────────────────────────────────────────────
-- Two fixes found by scripts/test-isolation.ts.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Make `TO authenticated` policies actually bind to app_user ───────────
-- Every policy is written `TO authenticated`, and app_user was granted
-- membership in that role so they would apply. They did not: RLS role matching
-- uses has_privs_of_role() (the USAGE sense), not bare membership, and app_user
-- was created NOINHERIT — so it was a member of `authenticated` without holding
-- its privileges. Result: no policy matched, everything default-denied, and a
-- user could not even read their own workspace.
--
-- Postgres 16+ stores an inherit_option on the membership itself, fixed at GRANT
-- time from the member's rolinherit. So flipping the role attribute alone is not
-- enough — the grant has to be reissued.
--
-- Inheriting `authenticated` grants no extra table access: the security
-- migration revoked all of its privileges in `public` to keep the Data API
-- closed. What it does grant is `storage`, which is correct — app_user acts on
-- behalf of an authenticated end user.

ALTER ROLE app_user INHERIT;
GRANT authenticated TO app_user WITH INHERIT TRUE;

DO $$
BEGIN
  IF NOT pg_has_role('app_user', 'authenticated', 'USAGE') THEN
    RAISE EXCEPTION
      'app_user does not hold the privileges of `authenticated`; TO authenticated policies will not match';
  END IF;
END $$;

-- ─── 2. Do not orphan workspaces when a user is deleted ──────────────────────
-- `workspaces` has no FK to `profiles` (membership is the join), so deleting a
-- profile cascaded away the workspace_members rows but left the workspace itself
-- behind — unreachable by anyone, and invisible to RLS since nobody is a member.

CREATE OR REPLACE FUNCTION private.handle_deleted_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_workspace_ids uuid[];
BEGIN
  SELECT array_agg(workspace_id) INTO v_workspace_ids
  FROM public.workspace_members
  WHERE profile_id = OLD.id;

  -- Cascades to workspace_members, media_assets, analyses, connected_accounts…
  DELETE FROM public.profiles WHERE id = OLD.id;

  -- …then drop any of those workspaces that no longer has a member. A shared
  -- TEAM workspace with other members survives; a personal one does not.
  IF v_workspace_ids IS NOT NULL THEN
    DELETE FROM public.workspaces w
    WHERE w.id = ANY(v_workspace_ids)
      AND NOT EXISTS (
        SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = w.id
      );
  END IF;

  RETURN OLD;
END $$;

-- Sweep up any orphans already created (e.g. by an earlier test run).
DELETE FROM public.workspaces w
WHERE NOT EXISTS (
  SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = w.id
);
