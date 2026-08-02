---
name: add-db-model
description: Add or change a table, column, enum or RLS policy in the Resonance app schema (packages/db, Prisma 7 + Supabase Postgres). Use when modifying the data model so naming stays consistent and no table ships without row-level security.
---

# Add or change a DB model

`packages/db` is the **single owner** of the app schema. Nothing else defines app tables — the
Python ML service never writes them with a second ORM.

## 0. Check what already exists (codebase index)

```
search_graph(project: "Users-emre-Desktop-files-resonance-monorepo", query: "<the thing you're modelling>")
```

Then **read `packages/db/prisma/schema.prisma`**. The index finds code; it does not replace seeing
the current bytes.

## 1. Naming — non-negotiable

TypeScript stays PascalCase/camelCase, Postgres stays snake_case. Every model, field and enum
carries an explicit mapping:

| Prisma                 | Postgres                                        | Attribute  |
| ---------------------- | ----------------------------------------------- | ---------- |
| model `AnalysisResult` | table `analysis_results` (plural)               | `@@map`    |
| field `resonanceScore` | column `resonance_score`                        | `@map`     |
| enum `WorkspaceKind`   | type `workspace_kind_enum` (singular + `_enum`) | `@@map`    |
| anything               | schema `public`                                 | `@@schema` |

The `_enum` suffix keeps a type name from colliding with a table of the same concept, and makes a
cast like `::platform_enum` in hand-written SQL unambiguous.

```prisma
enum WorkspaceKind {
  PERSONAL
  TEAM

  @@map("workspace_kind_enum")
  @@schema("public")
}
```

## 2. Every new table needs a tenancy root

Give it a `workspaceId` (preferred) or a `profileId`, or you will have nothing to write a policy
against. Index it — it is an RLS predicate column, evaluated on every query.

Types: `@db.Timestamptz(6)` for time, `@db.Uuid` for ids, `Bytes` for anything encrypted.
PKs: `String @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid` for client-facing rows
(time-ordered, no index fragmentation); `BigInt @id @default(autoincrement())` for high-volume
child rows nobody links to externally.

## 3. Generate the migration, then hand-write the security half

```bash
cd packages/db
bunx prisma migrate dev --create-only --name <change>   # DDL only
```

Prisma cannot express RLS. Append to the generated `migration.sql`, or add a second migration:

```sql
ALTER TABLE public.<t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.<t> FORCE ROW LEVEL SECURITY;

CREATE POLICY <t>_select ON public.<t>
  FOR SELECT TO authenticated
  USING ((SELECT private.is_workspace_member(workspace_id)));

CREATE POLICY <t>_insert ON public.<t>
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.is_workspace_member(workspace_id)));

CREATE POLICY <t>_update ON public.<t>
  FOR UPDATE TO authenticated
  USING ((SELECT private.is_workspace_member(workspace_id)))
  WITH CHECK ((SELECT private.is_workspace_member(workspace_id)));
```

Helpers available in the `private` schema: `is_workspace_member(uuid)`,
`has_workspace_role(uuid, text[])`, `shares_workspace_with(uuid)`, `can_access_analysis(uuid)`,
`can_access_post(uuid)`, `can_access_comparison(uuid)`.

For a child table with no `workspace_id`, reach through the parent with `can_access_*`.
For a table only the worker writes (results, metrics, labels, features, the credit ledger), give it
a **SELECT policy only** — `app_service` bypasses RLS, and a user must never be able to mint their
own credits or fabricate their own analytics.

Then apply and verify:

```bash
bunx prisma migrate dev
bun run db:check-rls        # coverage: enabled+forced, policies exist, no Data API grants
bun run db:test-isolation   # proves user B cannot reach user A's rows
```

## Rules

- **Wrap every function call in `(SELECT …)`** — `USING (auth.uid() = x)` re-evaluates per row;
  `USING ((SELECT auth.uid()) = x)` evaluates once.
- **UPDATE policies need both `USING` and `WITH CHECK`.** Without `WITH CHECK`, a user can move a
  row into someone else's workspace.
- **Never `TO authenticated` alone** — that is authentication without authorization. Always pair it
  with an ownership predicate.
- **An UPDATE needs a SELECT policy too**, or it silently affects zero rows.
- **`SECURITY DEFINER` helpers live in `private`**, check `auth.uid()` internally, and have EXECUTE
  revoked from `PUBLIC`/`anon`/`authenticated`.
- **Never edit an applied migration** — Prisma checksums them. Write a new one.
- Re-index after structural changes:
  `index_repository(repo_path: "/Users/emre/Desktop/files/resonance-monorepo")`.

## Traps this repo has already hit

- **Do not add `auth` (or any Supabase-owned schema) to `datasource.schemas`.** The moment Prisma
  can see it, every GoTrue table it doesn't model — `sessions`, `identities`, `sso_*`,
  `webauthn_*` — reads as drift to be reset. That also rules out a cross-schema FK to `auth.users`,
  since one forces the schema back into the list; use triggers instead.
- **`@updatedAt` is application-side only.** The column gets no DB default, so any INSERT from SQL
  (a trigger, a `SECURITY DEFINER` function) fails the NOT NULL check. Always pair it:
  `@default(now()) @updatedAt`.
- **A role granted `authenticated` while `NOINHERIT` does not match `TO authenticated` policies.**
  RLS matches on `has_privs_of_role()`, not bare membership, and PG16+ freezes an `inherit_option`
  onto the membership at GRANT time. Everything default-denies, which looks like a policy bug.
- **`ALTER ROLE … NOSUPERUSER` is blocked on Supabase** (its `postgres` is not a superuser). Assert
  role attributes in a `DO` block instead of trying to set them.
- **Prisma 7 removed `url`/`directUrl` from the datasource block.** They live in `prisma.config.ts`;
  the runtime client takes a driver adapter.
