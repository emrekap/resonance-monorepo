/**
 * Asserts that the RLS posture is intact. Run after every migration.
 *
 *   bun run db:check-rls
 *
 * Catches the failure modes that are silent until they are a breach:
 *   1. a table in `public` with RLS not enabled (or not forced)
 *   2. a table with RLS enabled but no policies at all — reads return nothing,
 *      which looks like a bug and gets "fixed" by disabling RLS
 *   3. `anon` / `authenticated` holding direct grants, which would expose the
 *      table through the Data API regardless of policies
 *   4. app_user having acquired BYPASSRLS
 *   5. a policy predicate column that is not indexed
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

  if (failures.length > 0) {
    console.error(`\n✗ RLS check failed (${failures.length} issue group(s))\n`);
    for (const f of failures) console.error(`${f}\n`);
    process.exit(1);
  }

  const { rows } = await client.query(`
    select
      (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname='public' and c.relkind='r' and c.relname <> '_prisma_migrations') as tables,
      (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
        join pg_namespace n on n.oid = c.relnamespace where n.nspname='public') as policies
  `);
  const { tables, policies } = rows[0];
  console.log(`✓ RLS check passed — ${tables} tables, all enabled+forced, ${policies} policies`);
} finally {
  await client.end();
}
