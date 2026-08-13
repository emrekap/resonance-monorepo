/**
 * Asserts that the RLS posture is intact. Run after every migration.
 *
 *   bun run db:check-rls
 *
 * Catches the failure modes that are silent until they are a breach:
 *   1. a table in `public` with RLS not enabled (or not forced)
 *   2. a table with RLS enabled but no policies at all — reads return nothing,
 *      which looks like a bug and gets "fixed" by disabling RLS
 *   3. `anon` / `authenticated` holding direct grants — table-level, or the
 *      column-level ones `role_table_grants` does not show — which would expose
 *      the table through the Data API regardless of policies
 *   4. app_user having acquired BYPASSRLS
 *   5. a policy predicate column that is not indexed
 *   6. the `corpus` schema drifting off deny-all — a table without forced RLS,
 *      a policy appearing on one (which can only widen zero), or any grant of
 *      any kind reaching `anon` / `authenticated`
 */
import 'dotenv/config';
import { Client } from 'pg';

const client = new Client({ connectionString: process.env.DIRECT_DATABASE_URL });
await client.connect();

const failures: string[] = [];
const note = (label: string, rows: unknown[]) => {
  if (rows.length > 0)
    failures.push(`${label}:\n  ${rows.map((r) => JSON.stringify(r)).join('\n  ')}`);
};

try {
  const unprotected = await client.query(`
    select c.relname as table_name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname <> '_prisma_migrations'
      and (not c.relrowsecurity or not c.relforcerowsecurity)
    order by 1
  `);
  note('Tables without RLS enabled+forced', unprotected.rows);

  const noPolicies = await client.query(`
    select c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname <> '_prisma_migrations'
      and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
    order by 1
  `);
  note('Tables with RLS but zero policies (everything is denied)', noPolicies.rows);

  const dataApiGrants = await client.query(`
    select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
    from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon', 'authenticated')
    group by table_name, grantee
    order by 1, 2
  `);
  note('Tables reachable by anon/authenticated through the Data API', dataApiGrants.rows);

  // `role_table_grants` only lists table-level grants, so a column-level one is
  // invisible to the check above — which is the whole failure mode #3 exists to
  // catch. `20260805140000_realtime_analyses` makes column grants real here:
  // Supabase Realtime cannot deliver a row to a role without column privileges
  // on it. That one exception is allowlisted; anything else fails.
  const REALTIME_GRANT = [
    'analyses.completed_at',
    'analyses.created_at',
    'analyses.id',
    'analyses.media_asset_id',
    'analyses.started_at',
    'analyses.status',
    'analyses.workspace_id',
  ];
  const columnGrants = await client.query<{
    column_ref: string;
    grantee: string;
    privilege_type: string;
  }>(`
    select cp.table_name || '.' || cp.column_name as column_ref, cp.grantee, cp.privilege_type
    from information_schema.column_privileges cp
    where cp.table_schema = 'public'
      and cp.grantee in ('anon', 'authenticated')
      -- a column-level row is only news when the table itself is not granted;
      -- otherwise the query above already reported it, once, per table
      and not exists (
        select 1 from information_schema.role_table_grants rtg
        where rtg.table_schema = cp.table_schema
          and rtg.table_name = cp.table_name
          and rtg.grantee = cp.grantee
      )
    order by 1, 2
  `);
  note(
    'Unexpected column-level grants to anon/authenticated',
    columnGrants.rows.filter(
      (r) => !(r.grantee === 'authenticated' && REALTIME_GRANT.includes(r.column_ref)),
    ),
  );

  const escalated = await client.query(`
    select rolname, rolbypassrls, rolsuper
    from pg_roles
    where rolname = 'app_user' and (rolbypassrls or rolsuper)
  `);
  note('app_user can bypass RLS — the API connection is unprotected', escalated.rows);

  const unindexed = await client.query(`
    select c.relname as table_name, a.attname as predicate_column
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public' and c.relkind = 'r'
      and a.attname in ('workspace_id', 'profile_id', 'analysis_id', 'post_id', 'comparison_id')
      and a.attnum > 0 and not a.attisdropped
      and not exists (
        select 1 from pg_index i
        where i.indrelid = c.oid and a.attnum = i.indkey[0]
      )
    order by 1, 2
  `);
  note('RLS predicate columns without a leading index', unindexed.rows);

  // ─── corpus (spec §3c) ─────────────────────────────────────────────────────
  // A deliberate, documented departure from the workspace-policy convention:
  // these tables have no tenant, so they carry RLS enabled+forced with ZERO
  // policies, which denies every role but the BYPASSRLS credential. The
  // assertions below are what keep that from decaying — note that the second is
  // the *inverse* of the `public` check above, which is exactly why it needs its
  // own query rather than a widened schema filter.

  const corpusUnprotected = await client.query(`
    select c.relname as table_name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'corpus' and c.relkind = 'r'
      and (not c.relrowsecurity or not c.relforcerowsecurity)
    order by 1
  `);
  note('Corpus tables without RLS enabled+forced', corpusUnprotected.rows);

  const corpusPolicies = await client.query(`
    select c.relname as table_name, p.polname as policy
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'corpus'
    order by 1, 2
  `);
  note(
    'Corpus tables with a policy — corpus is deny-all by design, a policy can only widen it',
    corpusPolicies.rows,
  );

  // Any grant of any kind: schema USAGE, table privileges, column privileges,
  // sequence privileges. `corpus` is not in Supabase's PostgREST schema list,
  // but that is a config file — this is the assertion that does not depend on it.
  const corpusGrants = await client.query(`
    select 'schema' as kind, 'corpus' as object, grantee, 'USAGE' as privilege
    from (values ('anon'), ('authenticated')) as r(grantee)
    where has_schema_privilege(r.grantee, 'corpus', 'USAGE')
    union all
    select 'table', table_name, grantee, string_agg(privilege_type, ',' order by privilege_type)
    from information_schema.role_table_grants
    where table_schema = 'corpus' and grantee in ('anon', 'authenticated')
    group by 2, 3
    union all
    select 'column', table_name || '.' || column_name, grantee, privilege_type
    from information_schema.column_privileges
    where table_schema = 'corpus' and grantee in ('anon', 'authenticated')
    union all
    select 'sequence', object_name, grantee, privilege_type
    from information_schema.usage_privileges
    where object_schema = 'corpus' and grantee in ('anon', 'authenticated')
    order by 1, 2, 3
  `);
  note(
    'Client-role grants on corpus — it must be unreachable to anon/authenticated',
    corpusGrants.rows,
  );

  if (failures.length > 0) {
    console.error(`\n✗ RLS check failed (${failures.length} issue group(s))\n`);
    for (const f of failures) console.error(`${f}\n`);
    process.exit(1);
  }

  // `pg` types rows as `any` unless the query is given a shape. Counts come
  // back as strings — `count(*)` is a bigint, which pg does not coerce.
  const { rows } = await client.query<{
    tables: string;
    policies: string;
    corpus_tables: string;
  }>(`
    select
      (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname='public' and c.relkind='r' and c.relname <> '_prisma_migrations') as tables,
      (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
        join pg_namespace n on n.oid = c.relnamespace where n.nspname='public') as policies,
      (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname='corpus' and c.relkind='r') as corpus_tables
  `);
  const counts = rows[0];
  if (!counts) throw new Error('RLS count query returned no rows');
  const { tables, policies, corpus_tables: corpusTables } = counts;
  console.log(
    `✓ RLS check passed — ${tables} public tables, all enabled+forced, ${policies} policies; ` +
      `${corpusTables} corpus tables, deny-all, unreachable by anon/authenticated`,
  );
} finally {
  await client.end();
}
