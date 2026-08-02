# packages/db

**Prisma 7 schema + generated client** — the single source of truth for the app data model.

Owns `schema.prisma`, the migrations, the RLS policies, and the exported typed client. Consumed by
[`apps/api`](../../apps/api).

**Rule:** only this package defines the app schema. The Python ML service ([`apps/ml`](../../apps/ml))
never writes these tables with a second ORM (avoids schema drift).

> Adding or changing a model? Use the **`add-db-model`** skill (`.claude/skills/`).

---

## The security model

The database holds personal data and platform OAuth tokens, so isolation is enforced by Postgres
rather than by application code. Three connections, three postures:

| Connection      | Role          | RLS                    | Used by                            |
| --------------- | ------------- | ---------------------- | ---------------------------------- |
| `withUser(id)`  | `app_user`    | **enforced**           | every `apps/api` request path      |
| `prismaService` | `app_service` | bypassed (`BYPASSRLS`) | the queue worker and the purge job |
| migrations      | `postgres`    | bypassed (owner)       | `prisma migrate` only              |

`app_user` does not own the tables and has no `BYPASSRLS`, so policies genuinely bind to it. A route
that forgets a `where` clause returns that user's own rows — not everyone's.

```ts
import { withUser, prismaService } from '@repo/db';

// request path — Postgres filters the rows
const analyses = await withUser(userId, (tx) =>
  tx.analysis.findMany({ where: { workspaceId } }),
);

// worker path — legitimately crosses users
await prismaService.analysisResult.create({ data: { ... } });
```

`withUser` opens a transaction and sets `request.jwt.claims` with `set_config(..., true)`, which is
transaction-local — so a claim can never leak onto the next request that reuses the same pooled
connection. That is why it is a transaction and not a bare `$executeRaw`.

**Tenancy is the workspace,** not the profile. Every profile gets an auto-created `PERSONAL`
workspace at signup, so solo creators never see the concept; brand/agency teams are the same shape
with more members. Policies reduce to one predicate: `private.is_workspace_member(workspace_id)`.

**Writes a user must not make** have no INSERT/UPDATE policy at all — analysis results, metric
snapshots, retention curves, post labels, feature artifacts, model versions and the credit ledger
are readable by members and writable only through `app_service`. A user cannot mint themselves
credits or fabricate their own analytics.

**The Data API is closed for app tables.** Clients use supabase-js for auth and Storage uploads
only; all table I/O goes through the Hono API. `anon` and `authenticated` hold no grants in
`public`, so PostgREST cannot reach these tables regardless of policies.

### Verifying it

```bash
bun run db:check-rls        # every table enabled+forced, policies exist, no Data API grants,
                            # app_user has no BYPASSRLS, predicate columns indexed
bun run db:test-isolation   # creates two throwaway users and proves B cannot read, update,
                            # delete or insert into A's workspace
```

Run both after every migration. `db:test-isolation` is the one that actually proves the design —
it drives the same `withUser()` helper the API uses.

---

## Naming conventions

TypeScript stays PascalCase/camelCase, Postgres stays snake_case, and the mapping is always explicit:

| Prisma                 | Postgres                                        | Attribute  |
| ---------------------- | ----------------------------------------------- | ---------- |
| model `AnalysisResult` | table `analysis_results` (plural)               | `@@map`    |
| field `resonanceScore` | column `resonance_score`                        | `@map`     |
| enum `WorkspaceKind`   | type `workspace_kind_enum` (singular + `_enum`) | `@@map`    |
| anything               | schema `public`                                 | `@@schema` |

The `_enum` suffix keeps a type name from colliding with a table of the same concept
(`platform_enum` vs. a future `platforms` table) and makes casts in hand-written SQL unambiguous.

Also standard here: `@db.Timestamptz(6)` for every timestamp, `@db.Uuid` for ids, `Bytes` for
encrypted values, UUIDv7 defaults for client-facing primary keys, `bigserial` for high-volume child
rows.

---

## Notable schema decisions

- **UUIDv7 via `public.uuid_generate_v7()`.** Postgres 17 has no native `uuidv7()` (PG 18) and
  `pg_uuidv7` is not on Supabase, so the first migration defines it: a v4 with the high 48 bits
  overlaid by the current millisecond. Time-ordered, so inserts append to one region of the btree
  instead of scattering it the way random v4 keys do.
- **Curves are parallel `Float[]` arrays.** The attention timeline and the YouTube retention curve
  are always read whole, so arrays cost one heap fetch instead of ~40 rows per analysis across
  thousands of backfilled posts. Check constraints keep the arrays the same length.
- **No raw platform payloads.** All three platforms restrict persistence and require deletion on
  disconnect, so we store derived metrics and labels only, each with a `purge_after` timestamp,
  plus `data_deletion_requests` as the audit trail.
- **`post_labels.split_tag`** lives with the label so the train/test leakage rule from the
  validation spec is checkable in SQL instead of enforced by convention.
- **`profiles.id` mirrors `auth.users.id` through triggers, not a foreign key.** A cross-schema FK
  forces `auth` into the datasource's `schemas` list, and then Prisma treats every GoTrue table it
  doesn't model as drift to be reset. `on_auth_user_created` builds the profile + personal
  workspace; `on_auth_user_deleted` removes it and cascades.

---

## Commands

```bash
bun run build             # prisma generate (Turbo runs it before dependents typecheck)
bun run db:migrate        # prisma migrate dev
bun run db:deploy         # prisma migrate deploy (CI / production)
bun run db:status         # prisma migrate status
bun run db:studio         # prisma studio
bun run db:check-rls      # RLS posture assertions
bun run db:test-isolation # cross-user isolation proof
bun run scripts/set-role-passwords.ts   # after rotating a password in .env
```

`src/generated/` is gitignored — a fresh clone needs `bun run build` once.

## Environment

Copy `.env.example` to `.env`. Four URLs: `DIRECT_DATABASE_URL` (migrations), `DATABASE_URL`
(owner, admin scripts), `APP_USER_DATABASE_URL` (request path), `APP_SERVICE_DATABASE_URL` (worker).

Both clients **connect on first use, not on import**, so a consumer only configures the URL it
actually uses — `apps/api` sets `APP_USER_DATABASE_URL` alone and never holds the BYPASSRLS
password. Constructing them eagerly would hand the request path the exact credential the role split
exists to withhold.

Two things that bite on Supabase:

- **The direct host `db.<ref>.supabase.co` is IPv6-only.** With no IPv6 route, point
  `DIRECT_DATABASE_URL` at the **session** pooler (`:5432`). The transaction pooler (`:6543`)
  cannot run migrations.
- **TLS defaults to `sslmode=no-verify`** because Supabase signs Postgres certs with its own CA,
  which is not in the system trust store. That is encrypted but not MITM-proof. Before production,
  download the project CA (Dashboard → Project Settings → Database → SSL Configuration) into
  `certs/` and switch to `sslmode=verify-full&sslrootcert=./certs/prod-ca-2021.crt`.

The `app_user` / `app_service` passwords are **not** in any migration — the security migration
creates the roles, and `scripts/set-role-passwords.ts` applies passwords read from `.env`.
