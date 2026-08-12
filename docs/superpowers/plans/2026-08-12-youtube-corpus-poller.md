# YouTube Shorts Corpus Poller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `apps/poller`, an isolated `corpus` Postgres schema, and a `research/` extract so the shipped resonance composite can be ranked against the realised reach of ~1,600 public YouTube Shorts.

**Architecture:** A new Bun app writes a `corpus` Postgres schema through `prismaService` (BYPASSRLS) on BullMQ repeatable jobs — daily poll, nightly text sweep, weekly readiness report — traversing YouTube Data API v3 channel-first. Corpus rows never share a table with customer rows, and `corpus` grants nothing to `anon`/`authenticated`. A symmetric `[corpus]` / `[corpus-results]` queue pair mirrors the analysis path into the _same_ `engine.py`, so the backtest cannot silently stop describing the product; it stays inert until §7's `SourceResolver` resolves anything. `research/eval/extract.py` becomes the second producer of the existing snapshot format, so every downstream stage runs unmodified.

**Tech Stack:** Bun + BullMQ + Prisma 7 (multi-schema) + Postgres/Supabase · YouTube Data API v3 · Python 3.11 (pydantic, psycopg, pandas, numpy, scikit-learn)

**Spec:** [`docs/superpowers/specs/2026-08-12-youtube-corpus-poller-design.md`](../specs/2026-08-12-youtube-corpus-poller-design.md). Section references below (§3d, §5b, …) point there.

## Global Constraints

Every task's requirements implicitly include this section.

- **Inclusion is `contentDetails.duration <= 30s`** — an official field, stricter than the Shorts boundary. No `youtube.com/shorts/{id}` probing (§5b).
- **`N` (maturation) fallback is `14` days**, used in phase 1 (corpus age days 1–28) and whenever phase 2's query has insufficient data. One parameter serves as both the measurement age and the inclusion floor — never two knobs (§5c).
- **Primary outcome: `views_at_Nd`, within creator, detrended against publish order within creator. Secondary: `engagement_rate = (likes + comments) / views_at_Nd`.** The primary is fixed and does not move (§1b).
- **The primary snapshot carries NO view-based exclusion** — not a view floor, not a hidden-likes drop. Those belong to the secondary only (§5b).
- **`view_count` must never reach a feature matrix.** Under the primary outcome it is the label's identity, and B1 scoring well is the only symptom (§8).
- **`format` is constant here and must be excluded from the B1 feature matrix** — zero variance is degenerate in a fitted model, not merely useless (§8).
- **Retention: 36 months for metrics and derived metrics, 30 days for text** (`title` / `description` / `tags` / channel titles), refreshed or nulled (§6).
- **RLS: enabled AND forced on every `corpus` table, with ZERO policies.** No grant of any kind to `anon` / `authenticated` on any object in `corpus` (§3c).
- **No changes to `apps/api`, to `apps/worker`'s behaviour, or to any `public` table.** The one deliberate exception is Task 4, a mechanical extraction of pure functions out of `apps/worker/src/scoring.ts` into `@repo/scoring` with the file re-exporting them — no behaviour change, no test change. Any _other_ edit to those means §3's isolation has been breached and the design needs revisiting first (§11).
- **Queue payload shapes live in `packages/queue/src/contract.ts` and are mirrored by hand in `apps/ml/queue_contract.py` — change one, change the other.** Use `.nullish()`, never `.optional()`: Pydantic serialises an unset field as `null`.
- **`QUEUE_PREFIX` stays `resonance`** for every queue.
- **Corpus jobs skip the Anthropic insights step.** `apps/poller` never imports `insights.ts` (§4b).
- **Tests are hermetic — no live YouTube calls in any suite** (§9). `fetch` is injected everywhere it is used.
- **Every commit message ends with the trailer** `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Target frame: ≈40 channels × 40 Shorts ≈ 1,600 posts**, above the prereg floor of ≥30 creators × ≥20 posts.
- **Nothing here may produce a pre-registration verdict.** Corpus output goes to its own directory and its report is titled a secondary exploratory analysis (§1a).

## File Structure

**`packages/db`** — schema ownership stays here, unchanged in principle.

- `prisma/schema.prisma` — `schemas = ["public", "corpus"]` plus six `@@schema("corpus")` models.
- `prisma/migrations/*_corpus_schema/migration.sql` — Prisma-generated DDL.
- `prisma/migrations/*_corpus_security/migration.sql` — hand-written: grants to `app_service` only, RLS forced with no policies.
- `scripts/check-rls.ts` — grows three corpus assertions.

**`packages/scoring` (new)** — the pure composite primitives, so `apps/worker` and `apps/poller` compute one number.

**`packages/queue`** — corpus queue names, payload schemas, and a Pydantic-produced fixture.

**`apps/poller` (new)** — one file per responsibility, pure logic separated from persistence so the suite needs no database:

| File                     | Responsibility                                               |
| ------------------------ | ------------------------------------------------------------ |
| `src/index.ts`           | scheduler: repeatable jobs, two workers, drain               |
| `src/seeds.ts`           | load + validate `seeds/channels.yaml`                        |
| `src/youtube.ts`         | Data API v3 client (`channels` / `playlistItems` / `videos`) |
| `src/duration.ts`        | ISO-8601 duration → seconds                                  |
| `src/ingest.ts`          | `planIngest` — videos → rows + exclusion tallies, pure       |
| `src/poll.ts`            | one channel's cycle: traverse, plan, persist                 |
| `src/store.ts`           | `CorpusStore` port + its Prisma implementation               |
| `src/jobs.ts`            | what each scheduled job does                                 |
| `src/cadence.ts`         | which posts are due this run                                 |
| `src/maturation.ts`      | the two-phase `N`                                            |
| `src/sweep.ts`           | 30-day text sweep                                            |
| `src/readiness.ts`       | weekly corpus-readiness report                               |
| `src/source-resolver.ts` | §7's seam; the null implementation                           |
| `src/scores.ts`          | `[corpus-results]` consumer → `corpus.scores`                |

**`apps/ml`** — `worker.py` grows a `CorpusProcessor` beside `AnalysisProcessor`, both behind one GPU semaphore, both routed to the same `engine.py`.

**`research/eval`** — `extract.py` (new, second producer), plus small openings in `snapshot.py`, `ladder.py`, `report.py`, `cli.py`, and `zeroshot.py` for §8a's un-fitted headline.

---

## Task 1: The `corpus` schema

**Files:**

- Modify: `packages/db/prisma/schema.prisma:28-31` (datasource) and append models at end of file
- Create: `packages/db/prisma/migrations/<timestamp>_corpus_schema/migration.sql` (generated)

**Interfaces:**

- Consumes: nothing.
- Produces: Prisma models `CorpusChannel`, `CorpusPost`, `CorpusMetricSnapshot`, `CorpusPollRun`, `CorpusClip`, `CorpusScore`, reachable as `prismaService.corpusChannel`, `.corpusPost`, `.corpusMetricSnapshot`, `.corpusPollRun`, `.corpusClip`, `.corpusScore`.

`corpus.poll_runs` is a **sixth** table, one more than §3d lists. The reason is §12.2: the readiness report must show "exclusion tallies by reason", and a video excluded on duration is never stored as a post — so a tally computed at read time can only ever count the exclusions that survive as rows. Storing the run's own counts is the only way the duration tally exists at all. It carries no text and no per-video identity, so it inherits the 36-month statistical tier.

- [ ] **Step 1: Add `corpus` to the datasource**

In `packages/db/prisma/schema.prisma`, change:

```prisma
datasource db {
  provider = "postgresql"
  schemas  = ["public", "corpus"]
}
```

- [ ] **Step 2: Append the six models**

At the end of `packages/db/prisma/schema.prisma`, after the last enum:

```prisma
// ─── Corpus (research) ───────────────────────────────────────────────────────
// A SEPARATE SCHEMA, not a system workspace. Two reasons, and the second is the
// stronger one (spec §3a/§3b):
//
//   * fitting crawled channels into `public.channels` required making
//     `connectedAccountId` nullable and widening a unique key on a live table —
//     relaxing customer-table invariants to accommodate a research pipeline.
//   * the two datasets are governed by different regimes (YouTube API ToS vs
//     user consent) with different retention clocks and different deletion
//     triggers. Sharing a table means every sweep must discriminate correctly,
//     forever; a wrong predicate is either a bug or a compliance incident.
//
// These tables carry NO policies. RLS is enabled and forced with zero policies,
// which denies every role except the BYPASSRLS service credential — strictly
// stricter than a workspace policy, and it fails closed. See the
// `corpus_security` migration.

/// A publicly observed channel. Seeded by hand from `apps/poller/seeds/channels.yaml`
/// — never discovered, because `search.list` costs 100 quota units against
/// `playlistItems.list`'s 1, and a hand-curated frame is the answer that survives
/// diligence (spec §5d).
model CorpusChannel {
  id                String    @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid
  platformChannelId String    @unique @map("platform_channel_id")
  /// 30-day text tier — nulled by the sweep unless the poller refreshed it.
  title             String?
  niche             String?
  /// Why this channel is in the frame. Copied from the seed file so the frame's
  /// composition is auditable from the database alone.
  rationale         String?
  uploadsPlaylistId String?   @map("uploads_playlist_id")
  subscriberCount   BigInt?   @map("subscriber_count")
  lastPolledAt      DateTime? @map("last_polled_at") @db.Timestamptz(6)
  textRefreshedAt   DateTime? @map("text_refreshed_at") @db.Timestamptz(6)
  createdAt         DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)

  posts    CorpusPost[]
  pollRuns CorpusPollRun[]

  @@index([textRefreshedAt])
  @@map("channels")
  @@schema("corpus")
}

/// One Short. Only `duration_sec <= 30` rows are stored — the frame's definition,
/// applied at ingest. Every OTHER exclusion (age below N, hidden likes, the
/// secondary's denominator floor) is applied at extract time, per-outcome, and
/// must NOT be applied here: a post below the maturation floor today is the
/// post whose label matures next week.
model CorpusPost {
  id              String    @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid
  channelId       String    @map("channel_id") @db.Uuid
  platformVideoId String    @unique @map("platform_video_id")
  publishedAt     DateTime  @map("published_at") @db.Timestamptz(6)
  durationSec     Float     @map("duration_sec")
  /// 30-day text tier.
  title           String?
  description     String?
  tags            String[]
  /// `status.license` — `creativeCommon` or `youtube`. Captured on the
  /// `videos.list` call already being made, at no extra quota, so §7's
  /// "do enough channels have ≥20 CC-BY Shorts?" is a SQL query rather than a
  /// separate research exercise.
  license         String?
  firstSeenAt     DateTime  @default(now()) @map("first_seen_at") @db.Timestamptz(6)
  textRefreshedAt DateTime? @map("text_refreshed_at") @db.Timestamptz(6)

  channel   CorpusChannel          @relation(fields: [channelId], references: [id], onDelete: Cascade)
  snapshots CorpusMetricSnapshot[]
  clip      CorpusClip?
  scores    CorpusScore[]

  @@index([channelId, publishedAt(sort: Desc)])
  @@index([textRefreshedAt])
  @@index([license])
  @@map("posts")
  @@schema("corpus")
}

/// The time series. One row per poll, NEVER an update — a single-shot crawl
/// forces you to assume when engagement matured; this lets you measure it, and
/// it is what makes fixed-age measurement possible at all (spec §1b/§5c).
///
/// `capturedAt` is the poll RUN's timestamp, not `now()`, so a retried job
/// collides with its own earlier write on `@@unique([postId, capturedAt])`
/// instead of appending a duplicate. That is what makes the append idempotent
/// under at-least-once delivery.
model CorpusMetricSnapshot {
  id         BigInt   @id @default(autoincrement())
  postId     String   @map("post_id") @db.Uuid
  capturedAt DateTime @map("captured_at") @db.Timestamptz(6)
  views      BigInt?
  /// Null when the creator has hidden like counts. Drops the post from the
  /// SECONDARY outcome only, counted and reported — hiding likes is not
  /// independent of how a post performed.
  likes      BigInt?
  comments   BigInt?

  post CorpusPost @relation(fields: [postId], references: [id], onDelete: Cascade)

  @@unique([postId, capturedAt])
  @@index([postId, capturedAt(sort: Desc)])
  @@map("metric_snapshots")
  @@schema("corpus")
}

/// Per-channel tallies for one poll run. Exists so the weekly readiness report
/// can state exclusions BY REASON (spec §12.2): a video excluded on duration is
/// never stored as a post, so a tally computed at read time could not see it.
/// Carries no text and no per-video identity.
model CorpusPollRun {
  id             BigInt   @id @default(autoincrement())
  channelId      String   @map("channel_id") @db.Uuid
  runAt          DateTime @map("run_at") @db.Timestamptz(6)
  videosSeen     Int      @map("videos_seen")
  postsIncluded  Int      @map("posts_included")
  /// `{ duration_over_30s: 12, missing_published_at: 0, not_public: 3 }`
  excluded       Json

  channel CorpusChannel @relation(fields: [channelId], references: [id], onDelete: Cascade)

  @@unique([channelId, runAt])
  @@index([runAt(sort: Desc)])
  @@map("poll_runs")
  @@schema("corpus")
}

/// The source file, once acquired. EMPTY until spec §7 is decided deliberately —
/// `SourceResolver` has one implementation and it resolves nothing. The pipeline
/// is complete and testable without it.
model CorpusClip {
  id               String   @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid
  postId           String   @unique @map("post_id") @db.Uuid
  storageKey       String   @map("storage_key")
  checksumSha256   String   @map("checksum_sha256")
  durationSec      Float?   @map("duration_sec")
  /// How it was obtained — `creator_upload`, `capture_at_post_time`, … Recorded
  /// per clip because the routes carry different licence and ToS positions.
  acquisitionRoute String   @map("acquisition_route")
  acquiredAt       DateTime @default(now()) @map("acquired_at") @db.Timestamptz(6)

  post   CorpusPost    @relation(fields: [postId], references: [id], onDelete: Cascade)
  scores CorpusScore[]

  @@map("clips")
  @@schema("corpus")
}

/// Raw ML output per clip. NO PERCENTILE, deliberately (spec §4c):
/// `percentileInChannel` and `resonanceScore` rank against a WORKSPACE's prior
/// analyses, and a crawled channel has no workspace and no tenant — the number
/// would be undefined at best. The within-creator ranking is applied at extract
/// time in `research/`, where the comparison set is the creator's own posts,
/// which is also the statistically correct scope.
model CorpusScore {
  id                String   @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid
  postId            String   @map("post_id") @db.Uuid
  clipId            String   @map("clip_id") @db.Uuid
  attempt           Int
  timelineStartSec  Float[]  @map("timeline_start_sec")
  timelineAttention Float[]  @map("timeline_attention")
  timelineVisual    Float[]  @map("timeline_visual")
  timelineAudio     Float[]  @map("timeline_audio")
  timelineLanguage  Float[]  @map("timeline_language")
  /// The five axes × {mean, std, peak}, exactly as `axisBandsSchema` sends them.
  axisBands         Json     @map("axis_bands")
  transcript        Json?
  /// `@repo/scoring`'s `composite()` — the SAME function `apps/worker` scores
  /// customer analyses with. If this were computed by different code the
  /// backtest would silently stop describing the product.
  composite         Float
  device            String?
  durationMs        Int      @map("duration_ms")
  createdAt         DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  post CorpusPost @relation(fields: [postId], references: [id], onDelete: Cascade)
  clip CorpusClip @relation(fields: [clipId], references: [id], onDelete: Cascade)

  @@unique([postId, attempt])
  @@index([clipId])
  @@map("scores")
  @@schema("corpus")
}
```

- [ ] **Step 3: Generate the migration**

Needs `DIRECT_DATABASE_URL` in `packages/db/.env` (the Supabase direct connection — see `packages/db/README.md`).

Run: `bun run --cwd=packages/db db:migrate --name corpus_schema`
Expected: a new `prisma/migrations/<timestamp>_corpus_schema/migration.sql` containing `CREATE SCHEMA "corpus"` and six `CREATE TABLE "corpus".…` statements, applied cleanly.

- [ ] **Step 4: Verify the client exposes the models**

Run:

```bash
bun run --cwd=packages/db build
bun -e 'import {prismaService} from "@repo/db"; console.log(typeof prismaService.corpusPost.findMany)'
```

Expected: `function`

- [ ] **Step 5: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations
git commit -m "feat(corpus): isolated corpus schema with six tables"
```

---

## Task 2: Corpus security migration

**Files:**

- Create: `packages/db/prisma/migrations/20260812120000_corpus_security/migration.sql`

**Interfaces:**

- Consumes: Task 1's tables.
- Produces: `corpus` reachable only by `app_service`; every corpus table RLS-enabled, RLS-forced, zero policies.

Hand-written, like `20260802191500_security_rls` — Prisma cannot express any of it. Create the directory and file by hand; Prisma applies any migration directory it finds.

- [ ] **Step 1: Write the migration**

```sql
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
```

- [ ] **Step 2: Apply it**

Run: `bun run --cwd=packages/db db:deploy`
Expected: `corpus_security` applied, no error.

- [ ] **Step 3: Verify by hand that a client role sees nothing**

```bash
bun -e '
import { Client } from "pg";
const c = new Client({ connectionString: process.env.DIRECT_DATABASE_URL });
await c.connect();
const { rows } = await c.query(`
  select has_schema_privilege('"'"'anon'"'"', '"'"'corpus'"'"', '"'"'USAGE'"'"') as anon_usage,
         has_schema_privilege('"'"'authenticated'"'"', '"'"'corpus'"'"', '"'"'USAGE'"'"') as auth_usage,
         (select count(*) from pg_policy p join pg_class c2 on c2.oid = p.polrelid
          join pg_namespace n on n.oid = c2.relnamespace where n.nspname = '"'"'corpus'"'"') as policies
`);
console.log(rows[0]);
await c.end();
'
```

Expected: `{ anon_usage: false, auth_usage: false, policies: '0' }`

- [ ] **Step 4: Commit**

```bash
git add packages/db/prisma/migrations
git commit -m "feat(corpus): RLS forced with zero policies, app_service-only grants"
```

---

## Task 3: `db:check-rls` learns about `corpus`

**Files:**

- Modify: `packages/db/scripts/check-rls.ts:107-141`
- Test: manual run (this script is the test; it exits non-zero on failure)

**Interfaces:**

- Consumes: Task 2's posture.
- Produces: `bun run --cwd=packages/db db:check-rls` fails on any client-role grant on `corpus`, on a corpus table without forced RLS, and on a corpus table that has acquired a policy.

The existing checks are all scoped `nspname = 'public'`, so `corpus` is currently invisible to them — including check #2, whose _whole point_ ("RLS but zero policies") is the state corpus is supposed to be in. The corpus assertions are therefore separate, and one of them is the inverse of a public one.

- [ ] **Step 1: Add the three corpus checks**

In `packages/db/scripts/check-rls.ts`, insert after the `unindexed` block (before `if (failures.length > 0)`):

```ts
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
```

- [ ] **Step 2: Extend the success summary**

Replace the final count query and log in the same file:

```ts
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
```

- [ ] **Step 3: Run it and confirm it passes**

Run: `bun run --cwd=packages/db db:check-rls`
Expected: `✓ RLS check passed — … 6 corpus tables, deny-all, unreachable by anon/authenticated`

- [ ] **Step 4: Prove the grant check actually fires**

This is the assertion most likely to be decorative — a query that returns nothing because it is wrong looks identical to one that returns nothing because the posture is right.

```bash
bun -e '
import { Client } from "pg";
const c = new Client({ connectionString: process.env.DIRECT_DATABASE_URL });
await c.connect();
await c.query("grant usage on schema corpus to anon");
await c.end();
'
bun run --cwd=packages/db db:check-rls   # must FAIL, listing the schema grant
bun -e '
import { Client } from "pg";
const c = new Client({ connectionString: process.env.DIRECT_DATABASE_URL });
await c.connect();
await c.query("revoke all on schema corpus from anon");
await c.end();
'
bun run --cwd=packages/db db:check-rls   # must PASS again
```

Expected: exit 1 then exit 0, with `Client-role grants on corpus` naming `{"kind":"schema","object":"corpus","grantee":"anon","privilege":"USAGE"}` in between.

- [ ] **Step 5: Commit**

```bash
git add packages/db/scripts/check-rls.ts
git commit -m "test(db): fail db:check-rls on any client-role grant reaching corpus"
```

---

## Task 4: `@repo/scoring` — one composite, two callers

**Files:**

- Create: `packages/scoring/package.json`, `packages/scoring/tsconfig.json`, `packages/scoring/eslint.config.js`, `packages/scoring/src/index.ts`, `packages/scoring/src/composite.ts`, `packages/scoring/src/composite.test.ts`
- Modify: `apps/worker/src/scoring.ts:1-110`, `apps/worker/package.json`

**Interfaces:**

- Consumes: `AxisBands`, `AxisSummary` from `@repo/queue`.
- Produces: `BAND_SUMMARY: keyof AxisSummary`, `COMPOSITE_WEIGHTS: { visual: number; audio: number; language: number }`, `band(bands: AxisBands, axis: keyof AxisBands): number`, `composite(bands: AxisBands): number` — all from `@repo/scoring`. `apps/worker/src/scoring.ts` re-exports `BAND_SUMMARY`, `band` and `composite` so its own imports and tests are unchanged.

This is the one deliberate exception to §11's "no changes to `apps/worker`". §11 exists to protect §3's data isolation, and a pure-function extraction touches no data path — but §4b's rule ("a separate queue is not a separate inference path") is the reason it is worth doing at all: if the corpus composite were computed by a second copy of these constants, the backtest would stop describing the product and no test would catch it. `apps/worker`'s behaviour and tests do not change.

- [ ] **Step 1: Scaffold the package**

`packages/scoring/package.json`:

```json
{
  "name": "@repo/scoring",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "dependencies": {
    "@repo/queue": "*"
  },
  "devDependencies": {
    "@repo/eslint-config": "*",
    "@repo/tsconfig": "*",
    "@types/bun": "^1.3.14",
    "eslint": "^9.39.5",
    "typescript": "^5.6.0"
  }
}
```

`packages/scoring/tsconfig.json`:

```json
{
  "extends": "@repo/tsconfig/bun.json",
  "include": ["src/**/*.ts"]
}
```

`packages/scoring/eslint.config.js`:

```js
import config from '@repo/eslint-config/bun';

export default config;
```

- [ ] **Step 2: Write the failing test**

`packages/scoring/src/composite.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { AxisBands } from '@repo/queue';

import { BAND_SUMMARY, COMPOSITE_WEIGHTS, band, composite } from './composite.ts';

const bands = (visual: number, audio: number, language: number): AxisBands => ({
  visual: { mean: 0, std: 0, peak: visual },
  audio: { mean: 0, std: 0, peak: audio },
  language: { mean: 0, std: 0, peak: language },
  emotional: { mean: 0, std: 0, peak: 9 },
  memorability: { mean: 0, std: 0, peak: 9 },
});

describe('composite', () => {
  test('reads the chosen statistic, not the mean', () => {
    expect(BAND_SUMMARY).toBe('peak');
    expect(band(bands(0.5, 0, 0), 'visual')).toBe(0.5);
  });

  test('weights visual/audio/language and ignores the BETA axes', () => {
    // EMOTIONAL_PULL and MEMORABILITY are cortical shadows of subcortical
    // structures fsaverage5 does not contain — a BETA axis must not move the
    // number on the front of the screen. Both are 9 above, so a composite that
    // included them could not land on this value.
    expect(composite(bands(1, 1, 1))).toBeCloseTo(1, 10);
    expect(composite(bands(1, 0, 0))).toBeCloseTo(0.4, 10);
    expect(composite(bands(0, 1, 0))).toBeCloseTo(0.35, 10);
    expect(composite(bands(0, 0, 1))).toBeCloseTo(0.25, 10);
  });

  test('the weights sum to one, so the composite stays in band units', () => {
    const total = Object.values(COMPOSITE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test packages/scoring/src/composite.test.ts`
Expected: FAIL — `Cannot find module './composite.ts'`

- [ ] **Step 4: Move the primitives**

`packages/scoring/src/composite.ts` — the four declarations lifted verbatim out of `apps/worker/src/scoring.ts` (`BAND_SUMMARY` at :57, `COMPOSITE_WEIGHTS` at :69, `band` at :99, `composite` at :104), with their comments intact:

```ts
import type { AxisBands, AxisSummary } from '@repo/queue';

/**
 * The pure primitives that turn TRIBE's raw band activations into one number.
 *
 * Extracted out of `apps/worker/src/scoring.ts` so `apps/poller` scores the
 * research corpus with the SAME function that scores a customer's analysis. A
 * separate queue is not a separate inference path (corpus spec §4b): if corpus
 * features were reduced by a second copy of these constants, the backtest would
 * silently stop describing the product and no test would catch it.
 *
 * Everything here is pure and deterministic. The percentile is NOT here — it
 * ranks against a workspace's prior analyses, which the corpus does not have
 * (§4c), so it stays in `apps/worker`.
 */

/**
 * Which of the three per-axis statistics becomes the score.
 *
 * **This is the most consequential line in the file, and it is a guess.** All
 * three cross the queue (see `axisSummarySchema`) precisely so that settling it
 * against real data is a one-word edit here rather than a change to `apps/ml`,
 * the contract and a GPU deploy.
 *
 * - `peak` — mean of the top quartile of segments. Chosen as the default: it is
 *   the closest of the three to the question the product asks ("did this hold
 *   attention at its best moments"), and unlike `mean` it does not average the
 *   signal away.
 * - `std` — how much the network's response varied. `docs/resonance-model-design.md`
 *   §0 offers this as a "dynamism" proxy. Blind to direction: a clip that swings
 *   downward scores like one that swings up.
 * - `mean` — the original choice, kept for comparison and **not recommended**.
 *   TRIBE predicts z-scored BOLD, so a time-average sits near zero by
 *   construction.
 *
 * How to settle it: run a batch of real clips, rank each way, and check which
 * ordering a human would defend. Until then this is a documented guess, not a
 * finding. The corpus is the batch that can settle it.
 */
export const BAND_SUMMARY: keyof AxisSummary = 'peak';

/**
 * How much each axis moves the headline number.
 *
 * Weighted by the defensibility tiers in docs/resonance-model-design.md §1a —
 * visual and audio are the best-predicted cortex and match their input modality
 * one-to-one, language is solid only for speech. EMOTIONAL_PULL and MEMORABILITY
 * are deliberately **absent**: both are cortical shadows of subcortical
 * structures that fsaverage5 does not contain, and a BETA axis has no business
 * moving the number on the front of the screen.
 */
export const COMPOSITE_WEIGHTS = { visual: 0.4, audio: 0.35, language: 0.25 } as const;

/** The chosen statistic for one axis. See {@link BAND_SUMMARY}. */
export function band(bands: AxisBands, axis: keyof AxisBands): number {
  return bands[axis][BAND_SUMMARY];
}

/** The single number the percentile ranks. See {@link COMPOSITE_WEIGHTS}. */
export function composite(bands: AxisBands): number {
  return (
    band(bands, 'visual') * COMPOSITE_WEIGHTS.visual +
    band(bands, 'audio') * COMPOSITE_WEIGHTS.audio +
    band(bands, 'language') * COMPOSITE_WEIGHTS.language
  );
}
```

`packages/scoring/src/index.ts`:

```ts
/**
 * `@repo/scoring` — the pure band → composite reduction, shared by the process
 * that scores customer analyses (`apps/worker`) and the one that scores the
 * research corpus (`apps/poller`).
 *
 * Holds no Prisma and no queue client: it is a reduction over `AxisBands`, and
 * that is all.
 */
export { BAND_SUMMARY, COMPOSITE_WEIGHTS, band, composite } from './composite.ts';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun install && bun test packages/scoring/src/composite.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 6: Re-point `apps/worker` at it**

In `apps/worker/package.json`, add `"@repo/scoring": "*"` to `dependencies`.

In `apps/worker/src/scoring.ts`, delete the `BAND_SUMMARY` declaration (:36-57), the `COMPOSITE_WEIGHTS` declaration (:60-69), the `band` function (:98-101) and the `composite` function (:103-110), and add near the top, after the existing imports:

```ts
/**
 * The band → composite reduction now lives in `@repo/scoring`, because
 * `apps/poller` must score the research corpus with the identical function —
 * see that package's docstring. Re-exported here so this module stays the one
 * place `apps/worker` reads scoring from.
 */
export { BAND_SUMMARY, band, composite } from '@repo/scoring';
```

Also change the first line to drop the now-unused `AxisSummary` import:

```ts
import type { AxisBands } from '@repo/queue';
```

- [ ] **Step 7: Verify `apps/worker` is unchanged in behaviour**

Run: `bun install && bun test apps/worker && bun run typecheck`
Expected: `apps/worker`'s existing suite (`scoring.test.ts`, `insights.test.ts`) passes with no edits to either test file, and the monorepo typechecks.

- [ ] **Step 8: Commit**

```bash
git add packages/scoring apps/worker/src/scoring.ts apps/worker/package.json bun.lock
git commit -m "refactor(scoring): extract the composite into @repo/scoring for the corpus to share"
```

---

## Task 5: Scaffold `apps/poller` and the sampling frame

**Files:**

- Create: `apps/poller/package.json`, `apps/poller/tsconfig.json`, `apps/poller/eslint.config.js`, `apps/poller/.env.example`, `apps/poller/seeds/channels.yaml`, `apps/poller/src/seeds.ts`, `apps/poller/src/seeds.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `SeedChannel = { id: string; handle: string | null; niche: string; tier: 'nano'|'micro'|'mid'|'large'; rationale: string }`, `parseSeeds(source: string): SeedChannel[]`, `loadSeeds(path?: string): Promise<SeedChannel[]>`, `SEEDS_PATH: string`.

- [ ] **Step 1: Scaffold the app**

`apps/poller/package.json`:

```json
{
  "name": "@repo/poller",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun run --hot src/index.ts",
    "start": "bun run src/index.ts",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "dependencies": {
    "@repo/db": "*",
    "@repo/queue": "*",
    "@repo/scoring": "*",
    "bullmq": "^6.0.5",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@repo/eslint-config": "*",
    "@repo/tsconfig": "*",
    "@types/bun": "^1.3.14",
    "eslint": "^9.39.5",
    "typescript": "^5.6.0"
  }
}
```

`apps/poller/tsconfig.json`:

```json
{
  "extends": "@repo/tsconfig/bun.json",
  "include": ["src/**/*.ts", "scripts/**/*.ts"]
}
```

`apps/poller/eslint.config.js`:

```js
import config from '@repo/eslint-config/bun';

export default config;
```

`apps/poller/.env.example`:

```bash
# Resonance corpus poller (Bun + BullMQ)
#
# Builds a corpus of public YouTube Shorts and their engagement over time, in
# the isolated `corpus` Postgres schema. Run it with:
#   cd apps/poller && bun run dev
#
# See docs/superpowers/specs/2026-08-12-youtube-corpus-poller-design.md

# --- YouTube Data API v3 ---------------------------------------------------
# A plain API key, NOT the OAuth client in apps/api: this reads public data
# only and never acts on behalf of a user. Create one in a Google Cloud project
# with the YouTube Data API v3 enabled, and restrict it to that API.
#
# Quota is a non-issue by design (spec §5a): playlistItems.list and videos.list
# cost 1 unit each and search.list costs 100, so channel-first traversal of ~40
# channels is low hundreds of units against the 10,000/day default. This poller
# performs NO discovery.
YOUTUBE_API_KEY=

# --- Queue -----------------------------------------------------------------
# Same Redis as apps/api, apps/ml and apps/worker. Local: infra/docker/
REDIS_URL=redis://127.0.0.1:6379

# --- Database --------------------------------------------------------------
# The BYPASSRLS role. `corpus` tables carry RLS forced with zero policies, so
# this is the ONLY credential that can read or write them at all — which is
# also why this is a separate process from apps/api, exactly as apps/worker is.
APP_SERVICE_DATABASE_URL="postgresql://app_service.<ref>:<app-service-password>@aws-0-<region>.pooler.supabase.com:6543/postgres?sslmode=require&pgbouncer=true"

# --- Reports ---------------------------------------------------------------
# Where the weekly corpus-readiness report is written (spec §12.2). Gitignored.
CORPUS_REPORT_DIR=./out
```

Add `apps/poller/out/` to the repo's `.gitignore`.

- [ ] **Step 2: Write the failing test**

`apps/poller/src/seeds.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { parseSeeds } from './seeds.ts';

const RATIONALE = 'Posts 3-5 Shorts a week with visibly variable reach; not a repost account.';

const yaml = (channels: string) => `version: 1\nchannels:\n${channels}`;

const entry = (overrides: Record<string, string> = {}) => {
  const fields = {
    id: 'UCabcdefghijklmnopqrstuv',
    handle: '"@example"',
    niche: 'cooking',
    tier: 'mid',
    rationale: `"${RATIONALE}"`,
    ...overrides,
  };
  const [first, ...rest] = Object.entries(fields);
  return (
    `  - ${first![0]}: ${first![1]}\n` + rest.map(([k, v]) => `    ${k}: ${v}`).join('\n') + '\n'
  );
};

describe('parseSeeds', () => {
  test('reads a curated frame', () => {
    const seeds = parseSeeds(yaml(entry()));
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.id).toBe('UCabcdefghijklmnopqrstuv');
    expect(seeds[0]!.tier).toBe('mid');
  });

  test('rejects something that is not a channelId', () => {
    // A handle (`@example`) or a video id here would traverse the wrong
    // playlist and quietly build a frame nobody curated.
    expect(() => parseSeeds(yaml(entry({ id: '"@example"' })))).toThrow();
  });

  test('rejects a duplicated channel', () => {
    // The same creator twice is the same creator's variance counted twice,
    // which inflates every within-creator statistic downstream.
    expect(() => parseSeeds(yaml(entry() + entry()))).toThrow(/duplicate/i);
  });

  test('rejects a rationale too short to be a rationale', () => {
    // Spec §5d requires a one-line reason per channel, and the reason the frame
    // is defensible at all is that each line is real. "good channel" is not.
    expect(() => parseSeeds(yaml(entry({ rationale: '"good channel"' })))).toThrow();
  });

  test('rejects an empty frame with an actionable message', () => {
    expect(() => parseSeeds('version: 1\nchannels: []\n')).toThrow(/curate/i);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test apps/poller/src/seeds.test.ts`
Expected: FAIL — `Cannot find module './seeds.ts'`

- [ ] **Step 4: Implement the loader**

`apps/poller/src/seeds.ts`:

```ts
import { z } from 'zod';

/**
 * The sampling frame — hand-curated and committed, never discovered.
 *
 * Two reasons (spec §5d). Reproducibility and zero discovery quota are the
 * cheap ones; the real one is that curation checks a property no automated
 * discovery can: **a channel whose Shorts all perform identically contributes
 * nothing**, because there is no variance to rank. "Here is our frame and why
 * each channel is in it" is also a materially stronger answer under diligence
 * than "search returned these".
 */

/** `UC` + 22 base64url characters. A handle or a video id is not one. */
export const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;

const seedChannelSchema = z.object({
  id: z.string().regex(CHANNEL_ID_PATTERN, 'not a YouTube channelId (UC + 22 characters)'),
  handle: z.string().nullish().default(null),
  niche: z.string().min(1),
  /** Subscriber tier, so the frame's spread across audience size is auditable. */
  tier: z.enum(['nano', 'micro', 'mid', 'large']),
  /**
   * Why this channel is in the frame. The 40-character floor is not style: the
   * frame is only defensible if each line is a real reason, and a schema that
   * accepts "good channel" makes §5d's requirement decorative.
   */
  rationale: z.string().min(40, 'give a real one-line reason — see spec §5d'),
});

export type SeedChannel = z.infer<typeof seedChannelSchema>;

const seedFileSchema = z.object({
  version: z.literal(1),
  channels: z
    .array(seedChannelSchema)
    .min(1, 'the sampling frame is empty — curate apps/poller/seeds/channels.yaml (spec §5d)'),
});

/** Parse and validate a frame. Throws rather than returning a partial frame. */
export function parseSeeds(source: string): SeedChannel[] {
  const parsed = seedFileSchema.parse(Bun.YAML.parse(source));

  const seen = new Set<string>();
  for (const channel of parsed.channels) {
    if (seen.has(channel.id)) {
      throw new Error(`duplicate channel in the frame: ${channel.id}`);
    }
    seen.add(channel.id);
  }
  return parsed.channels;
}

export const SEEDS_PATH = new URL('../seeds/channels.yaml', import.meta.url).pathname;

export async function loadSeeds(path: string = SEEDS_PATH): Promise<SeedChannel[]> {
  return parseSeeds(await Bun.file(path).text());
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun install && bun test apps/poller/src/seeds.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 6: Commit the frame file, uncurated and loud**

`apps/poller/seeds/channels.yaml`:

```yaml
# The corpus sampling frame (spec §5d).
#
# Hand-curated, committed, and deliberately NOT discovered: search.list costs
# 100 quota units against playlistItems.list's 1, and "here is our frame and
# why each channel is in it" survives diligence in a way "search returned
# these" does not.
#
# Target: ~40 channels x ~40 Shorts ~= 1,600 posts, spanning niche, format and
# subscriber tier — comfortably above the prereg floor of >=30 creators with
# >=20 posts each.
#
# Curation criteria, in order of how easy they are to get wrong:
#
#   1. VARIANCE. A channel whose Shorts all perform within a narrow band
#      contributes nothing — there is no ordering to rank. Check the channel's
#      recent Shorts view counts actually spread before adding it. No automated
#      discovery can check this, which is why the frame is curated at all.
#   2. VOLUME. >=20 Shorts under 30 seconds already published.
#   3. CADENCE. Still posting, so the daily poll has new posts to mature.
#   4. NOT A REPOST ACCOUNT. Compilations and reuploads attribute someone
#      else's content to this creator.
#   5. SPREAD. Vary niche and subscriber tier across the frame. Record the
#      frame's remaining biases in the report rather than leaving them implicit.
#
# `id` is the channelId (UC + 22 characters) from youtube.com/channel/<id> —
# NOT the @handle, which resolves to a different traversal.
#
# THIS FILE IS INTENTIONALLY EMPTY AND WILL FAIL VALIDATION UNTIL CURATED.
# `loadSeeds()` throws "the sampling frame is empty" rather than polling
# nothing quietly, so the poller cannot start against a frame nobody chose.
#
#   - id: UCxxxxxxxxxxxxxxxxxxxxxx
#     handle: "@example"
#     niche: cooking
#     tier: mid
#     rationale: "Posts 3-5 Shorts a week with visibly variable reach; not a repost account."

version: 1
channels: []
```

- [ ] **Step 7: Commit**

```bash
git add apps/poller .gitignore bun.lock
git commit -m "feat(poller): scaffold apps/poller and the curated sampling frame"
```

---

## Task 6: YouTube Data API v3 client

**Files:**

- Create: `apps/poller/src/youtube.ts`, `apps/poller/src/youtube.test.ts`, `apps/poller/src/__fixtures__/youtube/channels.json`, `apps/poller/src/__fixtures__/youtube/playlist-items.json`, `apps/poller/src/__fixtures__/youtube/videos.json`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `YouTubeChannel = { id: string; title: string | null; uploadsPlaylistId: string | null; subscriberCount: number | null }`
  - `YouTubeVideo = { id: string; channelId: string; publishedAt: string | null; title: string | null; description: string | null; tags: string[]; duration: string | null; license: string | null; privacyStatus: string | null; views: number | null; likes: number | null; comments: number | null }`
  - `YouTubeClient = { channels(ids: string[]): Promise<YouTubeChannel[]>; uploads(playlistId: string, limit: number): Promise<string[]>; videos(ids: string[]): Promise<YouTubeVideo[]> }`
  - `createYouTubeClient(options?: { apiKey?: string; fetch?: typeof fetch }): YouTubeClient`
  - `VIDEOS_BATCH = 50`

`duration` crosses this boundary as the **raw ISO-8601 string**, not seconds: parsing is Task 7's job and belongs with the inclusion rule it feeds, so a video whose duration this client cannot understand is still reportable as an exclusion rather than silently dropped here.

- [ ] **Step 1: Record the fixtures**

`apps/poller/src/__fixtures__/youtube/channels.json` — the shape `channels.list?part=snippet,statistics,contentDetails` returns:

```json
{
  "kind": "youtube#channelListResponse",
  "items": [
    {
      "id": "UCabcdefghijklmnopqrstuv",
      "snippet": { "title": "Example Kitchen" },
      "contentDetails": { "relatedPlaylists": { "uploads": "UUabcdefghijklmnopqrstuv" } },
      "statistics": { "subscriberCount": "184000", "hiddenSubscriberCount": false }
    },
    {
      "id": "UChiddensubscribersxxxxx",
      "snippet": { "title": "Quiet Channel" },
      "contentDetails": { "relatedPlaylists": { "uploads": "UUhiddensubscribersxxxxx" } },
      "statistics": { "hiddenSubscriberCount": true }
    }
  ]
}
```

`apps/poller/src/__fixtures__/youtube/playlist-items.json`:

```json
{
  "kind": "youtube#playlistItemListResponse",
  "nextPageToken": "CDIQAA",
  "items": [
    { "contentDetails": { "videoId": "vid00000001" } },
    { "contentDetails": { "videoId": "vid00000002" } },
    { "contentDetails": { "videoId": "vid00000003" } }
  ]
}
```

`apps/poller/src/__fixtures__/youtube/videos.json` — one ordinary Short, one with likes hidden, one long, one private, one livestream:

```json
{
  "kind": "youtube#videoListResponse",
  "items": [
    {
      "id": "vid00000001",
      "snippet": {
        "channelId": "UCabcdefghijklmnopqrstuv",
        "publishedAt": "2026-07-01T12:00:00Z",
        "title": "one pan dinner",
        "description": "#quick #dinner",
        "tags": ["quick", "dinner"]
      },
      "contentDetails": { "duration": "PT29S" },
      "status": { "license": "creativeCommon", "privacyStatus": "public" },
      "statistics": { "viewCount": "184203", "likeCount": "9120", "commentCount": "311" }
    },
    {
      "id": "vid00000002",
      "snippet": {
        "channelId": "UCabcdefghijklmnopqrstuv",
        "publishedAt": "2026-07-02T12:00:00Z",
        "title": "likes are hidden here",
        "description": "",
        "tags": []
      },
      "contentDetails": { "duration": "PT18S" },
      "status": { "license": "youtube", "privacyStatus": "public" },
      "statistics": { "viewCount": "5120", "commentCount": "8" }
    },
    {
      "id": "vid00000003",
      "snippet": {
        "channelId": "UCabcdefghijklmnopqrstuv",
        "publishedAt": "2026-07-03T12:00:00Z",
        "title": "the long version",
        "description": "",
        "tags": []
      },
      "contentDetails": { "duration": "PT8M12S" },
      "status": { "license": "youtube", "privacyStatus": "public" },
      "statistics": { "viewCount": "22000", "likeCount": "400", "commentCount": "12" }
    },
    {
      "id": "vid00000004",
      "snippet": {
        "channelId": "UCabcdefghijklmnopqrstuv",
        "publishedAt": "2026-07-04T12:00:00Z",
        "title": "unlisted draft",
        "description": "",
        "tags": []
      },
      "contentDetails": { "duration": "PT12S" },
      "status": { "license": "youtube", "privacyStatus": "private" },
      "statistics": { "viewCount": "3" }
    },
    {
      "id": "vid00000005",
      "snippet": {
        "channelId": "UCabcdefghijklmnopqrstuv",
        "publishedAt": "2026-07-05T12:00:00Z",
        "title": "live right now",
        "description": "",
        "tags": []
      },
      "contentDetails": { "duration": "P0D" },
      "status": { "license": "youtube", "privacyStatus": "public" },
      "statistics": { "viewCount": "88" }
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

`apps/poller/src/youtube.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import channelsFixture from './__fixtures__/youtube/channels.json';
import playlistItemsFixture from './__fixtures__/youtube/playlist-items.json';
import videosFixture from './__fixtures__/youtube/videos.json';
import { VIDEOS_BATCH, createYouTubeClient } from './youtube.ts';

/** Records every URL asked for and answers from the fixtures. No network. */
function fakeFetch(calls: URL[] = []) {
  const impl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const body = url.pathname.endsWith('/channels')
      ? channelsFixture
      : url.pathname.endsWith('/playlistItems')
        ? { ...playlistItemsFixture, nextPageToken: undefined }
        : videosFixture;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const client = (calls: URL[] = []) =>
  createYouTubeClient({ apiKey: 'test-key', fetch: fakeFetch(calls).impl });

describe('channels', () => {
  test('returns the uploads playlist and subscriber count', async () => {
    const [first] = await client().channels(['UCabcdefghijklmnopqrstuv']);
    expect(first!.uploadsPlaylistId).toBe('UUabcdefghijklmnopqrstuv');
    expect(first!.subscriberCount).toBe(184000);
    expect(first!.title).toBe('Example Kitchen');
  });

  test('reports a hidden subscriber count as null, not zero', async () => {
    // Zero would enter the B1 rung as a real follower count of zero and make a
    // mid-tier channel look like a brand new one.
    const [, second] = await client().channels(['UChiddensubscribersxxxxx']);
    expect(second!.subscriberCount).toBeNull();
  });
});

describe('uploads', () => {
  test('walks the uploads playlist and returns video ids', async () => {
    const calls: URL[] = [];
    const ids = await client(calls).uploads('UUabcdefghijklmnopqrstuv', 40);
    expect(ids).toEqual(['vid00000001', 'vid00000002', 'vid00000003']);
    expect(calls[0]!.pathname).toEndWith('/playlistItems');
    // 1 quota unit per call, versus 100 for search.list — see spec §5a.
    expect(calls[0]!.searchParams.get('part')).toBe('contentDetails');
  });

  test('stops at the requested limit', async () => {
    const ids = await client().uploads('UUabcdefghijklmnopqrstuv', 2);
    expect(ids).toHaveLength(2);
  });
});

describe('videos', () => {
  test('carries the raw duration, the licence and the counts', async () => {
    const [first] = await client().videos(['vid00000001']);
    expect(first!.duration).toBe('PT29S');
    // status.license rides along on a call already being made, at no extra
    // quota — which is what makes §7's deferral nearly free.
    expect(first!.license).toBe('creativeCommon');
    expect(first!.views).toBe(184203);
    expect(first!.likes).toBe(9120);
  });

  test('reports a hidden like count as null, not zero', async () => {
    // Zero would enter the SECONDARY outcome's numerator as a real zero.
    const [, second] = await client().videos(['vid00000002']);
    expect(second!.likes).toBeNull();
    expect(second!.views).toBe(5120);
  });

  test('asks for every part the corpus needs, in one call', async () => {
    const calls: URL[] = [];
    await client(calls).videos(['vid00000001']);
    expect(calls[0]!.searchParams.get('part')).toBe('snippet,contentDetails,statistics,status');
  });

  test('batches ids 50 at a time', async () => {
    const calls: URL[] = [];
    const ids = Array.from({ length: VIDEOS_BATCH + 1 }, (_, i) => `vid${i}`);
    await client(calls).videos(ids);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.searchParams.get('id')!.split(',')).toHaveLength(VIDEOS_BATCH);
    expect(calls[1]!.searchParams.get('id')!.split(',')).toHaveLength(1);
  });

  test('never sends the api key in a header, and never in the log', async () => {
    const calls: URL[] = [];
    await client(calls).videos(['vid00000001']);
    expect(calls[0]!.searchParams.get('key')).toBe('test-key');
  });
});

describe('errors', () => {
  test('raises with the status so a 403 quota error is legible', async () => {
    const failing = createYouTubeClient({
      apiKey: 'test-key',
      fetch: (async () =>
        new Response('{"error":{"message":"quotaExceeded"}}', {
          status: 403,
        })) as unknown as typeof fetch,
    });
    await expect(failing.videos(['vid00000001'])).rejects.toThrow(/403/);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test apps/poller/src/youtube.test.ts`
Expected: FAIL — `Cannot find module './youtube.ts'`

- [ ] **Step 4: Implement the client**

`apps/poller/src/youtube.ts`:

```ts
/**
 * YouTube Data API v3, read-only and public.
 *
 * Channel-first traversal, never discovery: `playlistItems.list` and
 * `videos.list` cost **1 quota unit each** while `search.list` costs **100**,
 * so walking ~40 seeded channels costs low hundreds of units against the
 * 10,000/day default. The statistically correct shape and the quota-cheap shape
 * are the same shape (spec §5a) — discovery is what is expensive, and this
 * client does none.
 *
 * Authenticated with a plain API key, not the OAuth client in `apps/api`: every
 * field here is public, and nothing acts on behalf of a user.
 */

const API_BASE = 'https://www.googleapis.com/youtube/v3';

/** `videos.list` accepts 50 ids per call, for the same 1 unit as one id. */
export const VIDEOS_BATCH = 50;

/** `playlistItems.list` page size. */
const PLAYLIST_PAGE = 50;

export interface YouTubeChannel {
  id: string;
  title: string | null;
  uploadsPlaylistId: string | null;
  /** Null when the channel hides it — NOT zero, which would read as a real count. */
  subscriberCount: number | null;
}

export interface YouTubeVideo {
  id: string;
  channelId: string;
  publishedAt: string | null;
  title: string | null;
  description: string | null;
  tags: string[];
  /**
   * The raw ISO-8601 string (`PT29S`). Parsing belongs with the inclusion rule
   * it feeds (`duration.ts`), so a duration this client cannot understand stays
   * reportable as an exclusion instead of being dropped here.
   */
  duration: string | null;
  /** `creativeCommon` or `youtube` — free on this call, and §7 depends on it. */
  license: string | null;
  privacyStatus: string | null;
  views: number | null;
  /** Null when the creator hides like counts. */
  likes: number | null;
  comments: number | null;
}

export interface YouTubeClient {
  channels(ids: string[]): Promise<YouTubeChannel[]>;
  /** Video ids from a uploads playlist, newest first, capped at `limit`. */
  uploads(playlistId: string, limit: number): Promise<string[]>;
  videos(ids: string[]): Promise<YouTubeVideo[]>;
}

interface ChannelsResponse {
  items?: {
    id: string;
    snippet?: { title?: string };
    contentDetails?: { relatedPlaylists?: { uploads?: string } };
    statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean };
  }[];
}

interface PlaylistItemsResponse {
  nextPageToken?: string;
  items?: { contentDetails?: { videoId?: string } }[];
}

interface VideosResponse {
  items?: {
    id: string;
    snippet?: {
      channelId?: string;
      publishedAt?: string;
      title?: string;
      description?: string;
      tags?: string[];
    };
    contentDetails?: { duration?: string };
    status?: { license?: string; privacyStatus?: string };
    statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  }[];
}

/**
 * A count the API omits is genuinely absent, not zero.
 *
 * `likeCount` is missing when the creator hid likes and `subscriberCount` when
 * the channel hid subscribers — both of which are real, common states. Reading
 * either as `0` would put a fabricated number into the secondary outcome's
 * numerator or the B1 rung's follower covariate.
 */
function count(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see apps/poller/.env.example`);
  return value;
}

export function createYouTubeClient(
  options: { apiKey?: string; fetch?: typeof fetch } = {},
): YouTubeClient {
  const fetchImpl = options.fetch ?? fetch;
  const apiKey = options.apiKey ?? required('YOUTUBE_API_KEY');

  async function get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${API_BASE}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('key', apiKey);

    const response = await fetchImpl(url);
    if (!response.ok) {
      // The status is the whole diagnosis here: 403 is almost always quota or a
      // key restriction, 404 a deleted channel. The URL is deliberately NOT in
      // the message — it carries the key.
      throw new Error(`youtube ${path} failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  }

  return {
    async channels(ids) {
      const out: YouTubeChannel[] = [];
      for (const batch of chunk(ids, VIDEOS_BATCH)) {
        const body = await get<ChannelsResponse>('channels', {
          part: 'snippet,contentDetails,statistics',
          id: batch.join(','),
          maxResults: String(VIDEOS_BATCH),
        });
        for (const item of body.items ?? []) {
          out.push({
            id: item.id,
            title: item.snippet?.title ?? null,
            uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? null,
            subscriberCount: item.statistics?.hiddenSubscriberCount
              ? null
              : count(item.statistics?.subscriberCount),
          });
        }
      }
      return out;
    },

    async uploads(playlistId, limit) {
      const ids: string[] = [];
      let pageToken: string | undefined;

      do {
        const body = await get<PlaylistItemsResponse>('playlistItems', {
          part: 'contentDetails',
          playlistId,
          maxResults: String(Math.min(PLAYLIST_PAGE, limit - ids.length)),
          ...(pageToken ? { pageToken } : {}),
        });
        for (const item of body.items ?? []) {
          const videoId = item.contentDetails?.videoId;
          if (videoId) ids.push(videoId);
          if (ids.length >= limit) return ids;
        }
        pageToken = body.nextPageToken;
      } while (pageToken);

      return ids;
    },

    async videos(ids) {
      const out: YouTubeVideo[] = [];
      for (const batch of chunk(ids, VIDEOS_BATCH)) {
        const body = await get<VideosResponse>('videos', {
          // `status` is what carries `license`, and it is free on this call —
          // which is what lets §7 be deferred without a later re-crawl.
          part: 'snippet,contentDetails,statistics,status',
          id: batch.join(','),
          maxResults: String(VIDEOS_BATCH),
        });
        for (const item of body.items ?? []) {
          out.push({
            id: item.id,
            channelId: item.snippet?.channelId ?? '',
            publishedAt: item.snippet?.publishedAt ?? null,
            title: item.snippet?.title ?? null,
            description: item.snippet?.description ?? null,
            tags: item.snippet?.tags ?? [],
            duration: item.contentDetails?.duration ?? null,
            license: item.status?.license ?? null,
            privacyStatus: item.status?.privacyStatus ?? null,
            views: count(item.statistics?.viewCount),
            likes: count(item.statistics?.likeCount),
            comments: count(item.statistics?.commentCount),
          });
        }
      }
      return out;
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test apps/poller/src/youtube.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 6: Commit**

```bash
git add apps/poller/src/youtube.ts apps/poller/src/youtube.test.ts apps/poller/src/__fixtures__
git commit -m "feat(poller): YouTube Data API v3 client, channel-first and hermetically tested"
```

---

## Task 7: Duration parsing and the ingest plan

**Files:**

- Create: `apps/poller/src/duration.ts`, `apps/poller/src/duration.test.ts`, `apps/poller/src/ingest.ts`, `apps/poller/src/ingest.test.ts`

**Interfaces:**

- Consumes: `YouTubeVideo` from `./youtube.ts`.
- Produces:
  - `parseIsoDuration(value: string | null): number | null`
  - `MAX_DURATION_SEC = 30`
  - `ExclusionReason = 'duration_over_30s' | 'not_a_clip' | 'not_public' | 'missing_published_at'`
  - `PlannedPost = { platformVideoId: string; publishedAt: Date; durationSec: number; title: string | null; description: string | null; tags: string[]; license: string | null }`
  - `PlannedSnapshot = { platformVideoId: string; capturedAt: Date; views: number | null; likes: number | null; comments: number | null }`
  - `IngestPlan = { posts: PlannedPost[]; snapshots: PlannedSnapshot[]; videosSeen: number; excluded: Record<ExclusionReason, number> }`
  - `planIngest(input: { videos: YouTubeVideo[]; runAt: Date }): IngestPlan`

- [ ] **Step 1: Write the failing duration test**

`apps/poller/src/duration.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { parseIsoDuration } from './duration.ts';

describe('parseIsoDuration', () => {
  test('reads the shapes YouTube actually returns', () => {
    expect(parseIsoDuration('PT29S')).toBe(29);
    expect(parseIsoDuration('PT1M')).toBe(60);
    expect(parseIsoDuration('PT1M2S')).toBe(62);
    expect(parseIsoDuration('PT1H1M1S')).toBe(3661);
    expect(parseIsoDuration('PT8M12S')).toBe(492);
  });

  test('returns 0 for the P0D a live broadcast reports', () => {
    // Not null: the string parsed fine and genuinely says "no duration". The
    // caller excludes it as `not_a_clip`, which is a different fact from
    // "we could not read this".
    expect(parseIsoDuration('P0D')).toBe(0);
  });

  test('returns null for anything it cannot read', () => {
    expect(parseIsoDuration(null)).toBeNull();
    expect(parseIsoDuration('')).toBeNull();
    expect(parseIsoDuration('29 seconds')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test apps/poller/src/duration.test.ts`
Expected: FAIL — `Cannot find module './duration.ts'`

- [ ] **Step 3: Implement the parser**

`apps/poller/src/duration.ts`:

```ts
/**
 * ISO-8601 durations, as `contentDetails.duration` returns them.
 *
 * There is no `isShort` field on the Data API, and the common workaround —
 * probing whether `youtube.com/shorts/{id}` resolves without redirecting — is
 * unofficial and unnecessary, because the **<=30 s rule is stricter than the
 * Shorts boundary anyway** (spec §5b). Filtering on this official field yields a
 * homogeneous format and satisfies the validation spec's requirement not to mix
 * short-form with long-form.
 */

const PATTERN = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** Seconds, or null when the string is not a duration this understands. */
export function parseIsoDuration(value: string | null): number | null {
  if (!value) return null;
  const match = PATTERN.exec(value);
  if (!match) return null;

  const [, days, hours, minutes, seconds] = match;
  // `P` alone, or `PT`, carries no components — not a duration of zero.
  if (!days && !hours && !minutes && !seconds) return null;

  return (
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0)
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/poller/src/duration.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Write the failing ingest test**

`apps/poller/src/ingest.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import videosFixture from './__fixtures__/youtube/videos.json';
import { MAX_DURATION_SEC, planIngest } from './ingest.ts';
import type { YouTubeVideo } from './youtube.ts';

const RUN_AT = new Date('2026-08-12T03:00:00.000Z');

const video = (overrides: Partial<YouTubeVideo> = {}): YouTubeVideo => ({
  id: 'vid00000001',
  channelId: 'UCabcdefghijklmnopqrstuv',
  publishedAt: '2026-08-11T12:00:00Z',
  title: 'a short',
  description: '#tag',
  tags: ['tag'],
  duration: 'PT20S',
  license: 'youtube',
  privacyStatus: 'public',
  views: 1000,
  likes: 50,
  comments: 5,
  ...overrides,
});

const fixtureVideos = videosFixture.items.map((item) => ({
  id: item.id,
  channelId: item.snippet.channelId,
  publishedAt: item.snippet.publishedAt,
  title: item.snippet.title,
  description: item.snippet.description,
  tags: item.snippet.tags,
  duration: item.contentDetails.duration,
  license: item.status.license,
  privacyStatus: item.status.privacyStatus,
  views: item.statistics.viewCount ? Number(item.statistics.viewCount) : null,
  likes: item.statistics.likeCount ? Number(item.statistics.likeCount) : null,
  comments: item.statistics.commentCount ? Number(item.statistics.commentCount) : null,
})) as YouTubeVideo[];

describe('the frame', () => {
  test('includes a clip exactly at the boundary and excludes one past it', () => {
    const plan = planIngest({
      videos: [
        video({ id: 'at', duration: `PT${MAX_DURATION_SEC}S` }),
        video({ id: 'over', duration: `PT${MAX_DURATION_SEC + 1}S` }),
      ],
      runAt: RUN_AT,
    });
    expect(plan.posts.map((p) => p.platformVideoId)).toEqual(['at']);
    expect(plan.excluded.duration_over_30s).toBe(1);
  });

  test('excludes a live broadcast and a non-public video, each by its own reason', () => {
    const plan = planIngest({
      videos: [
        video({ id: 'live', duration: 'P0D' }),
        video({ id: 'unreadable', duration: 'sometime' }),
        video({ id: 'private', privacyStatus: 'private' }),
        video({ id: 'undated', publishedAt: null }),
      ],
      runAt: RUN_AT,
    });
    expect(plan.posts).toHaveLength(0);
    expect(plan.excluded).toEqual({
      not_a_clip: 2,
      not_public: 1,
      missing_published_at: 1,
      duration_over_30s: 0,
    });
  });

  test('every video is either included or counted, never neither', () => {
    // The readiness report states exclusions BY REASON (spec §12.2). A video
    // that falls out of the plan without landing in a tally is a corpus whose
    // own denominator cannot be reconstructed.
    const plan = planIngest({ videos: fixtureVideos, runAt: RUN_AT });
    const tallied = Object.values(plan.excluded).reduce((a, b) => a + b, 0);
    expect(plan.posts.length + tallied).toBe(plan.videosSeen);
    expect(plan.videosSeen).toBe(fixtureVideos.length);
  });
});

describe('what is NOT excluded here', () => {
  test('keeps a post younger than the maturation floor', () => {
    // Applying the age floor at ingest would mean never collecting the post
    // whose label matures next week. Age is an EXTRACT-time exclusion.
    const plan = planIngest({
      videos: [video({ publishedAt: RUN_AT.toISOString() })],
      runAt: RUN_AT,
    });
    expect(plan.posts).toHaveLength(1);
  });

  test('keeps a post whose likes are hidden', () => {
    // Hidden likes drop a post from the SECONDARY outcome only. Dropping it
    // here would shrink the PRIMARY's N for a reason the primary does not have.
    const plan = planIngest({ videos: [video({ likes: null })], runAt: RUN_AT });
    expect(plan.posts).toHaveLength(1);
    expect(plan.snapshots[0]!.likes).toBeNull();
  });

  test('keeps a post with very few views', () => {
    // A view-count floor applied to a views label is selection on the outcome
    // variable — the exact flaw that disqualifies Instagram's top_media (§2).
    const plan = planIngest({ videos: [video({ views: 3 })], runAt: RUN_AT });
    expect(plan.posts).toHaveLength(1);
    expect(plan.snapshots[0]!.views).toBe(3);
  });
});

describe('snapshots', () => {
  test('stamps every snapshot with the run timestamp, not the wall clock', () => {
    // `@@unique([postId, capturedAt])` is what makes an at-least-once retry a
    // no-op rather than a duplicate row. That only holds if a re-run of the
    // SAME job produces the SAME capturedAt — so it comes from the job, never
    // from `new Date()`.
    const plan = planIngest({ videos: [video()], runAt: RUN_AT });
    expect(plan.snapshots).toHaveLength(1);
    expect(plan.snapshots[0]!.capturedAt.toISOString()).toBe(RUN_AT.toISOString());
  });

  test('emits one snapshot per included post and none for excluded ones', () => {
    const plan = planIngest({ videos: fixtureVideos, runAt: RUN_AT });
    expect(plan.snapshots.map((s) => s.platformVideoId)).toEqual(
      plan.posts.map((p) => p.platformVideoId),
    );
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test apps/poller/src/ingest.test.ts`
Expected: FAIL — `Cannot find module './ingest.ts'`

- [ ] **Step 7: Implement `planIngest`**

`apps/poller/src/ingest.ts`:

```ts
import { parseIsoDuration } from './duration.ts';
import type { YouTubeVideo } from './youtube.ts';

/**
 * Turning one channel's `videos.list` response into rows — the pure half.
 *
 * Separated from the writes so the frame's rules are testable without a
 * database, which is the same posture `apps/api` takes with `app.request()`.
 *
 * **What this excludes, and what it deliberately does not.** The only rule
 * applied here is the frame's own definition: a public, dated clip of at most
 * 30 seconds. Every OTHER exclusion in spec §5b — age below the maturation
 * floor, hidden likes, the secondary outcome's denominator floor — is applied
 * at EXTRACT time, per-outcome, and applying any of them here would be a
 * different and much worse thing:
 *
 *   * an age floor at ingest never collects the post whose label matures next
 *     week, and the corpus would consist only of posts old enough on the day
 *     they were first seen;
 *   * a view floor at ingest is selection on the outcome variable — the exact
 *     flaw that disqualifies Instagram's `top_media` (§2), imported into our own
 *     method section;
 *   * a hidden-likes drop at ingest shrinks the PRIMARY outcome's N for a
 *     reason that belongs only to the secondary.
 */

/** The frame's upper bound. Stricter than the Shorts boundary, by design (§5b). */
export const MAX_DURATION_SEC = 30;

export type ExclusionReason =
  'duration_over_30s' | 'not_a_clip' | 'not_public' | 'missing_published_at';

const REASONS: ExclusionReason[] = [
  'duration_over_30s',
  'not_a_clip',
  'not_public',
  'missing_published_at',
];

export interface PlannedPost {
  platformVideoId: string;
  publishedAt: Date;
  durationSec: number;
  title: string | null;
  description: string | null;
  tags: string[];
  license: string | null;
}

export interface PlannedSnapshot {
  platformVideoId: string;
  capturedAt: Date;
  views: number | null;
  likes: number | null;
  comments: number | null;
}

export interface IngestPlan {
  posts: PlannedPost[];
  snapshots: PlannedSnapshot[];
  videosSeen: number;
  excluded: Record<ExclusionReason, number>;
}

export function planIngest(input: { videos: YouTubeVideo[]; runAt: Date }): IngestPlan {
  const posts: PlannedPost[] = [];
  const snapshots: PlannedSnapshot[] = [];
  const excluded = Object.fromEntries(REASONS.map((r) => [r, 0])) as Record<
    ExclusionReason,
    number
  >;

  for (const video of input.videos) {
    if (video.privacyStatus !== 'public') {
      excluded.not_public += 1;
      continue;
    }
    if (!video.publishedAt) {
      excluded.missing_published_at += 1;
      continue;
    }

    const durationSec = parseIsoDuration(video.duration);
    // `null` is "unreadable", `0` is a live broadcast reporting `P0D`. Neither
    // is a clip, and neither needs its own tally to be actionable.
    if (durationSec === null || durationSec <= 0) {
      excluded.not_a_clip += 1;
      continue;
    }
    if (durationSec > MAX_DURATION_SEC) {
      excluded.duration_over_30s += 1;
      continue;
    }

    posts.push({
      platformVideoId: video.id,
      publishedAt: new Date(video.publishedAt),
      durationSec,
      title: video.title,
      description: video.description,
      tags: video.tags,
      license: video.license,
    });

    snapshots.push({
      platformVideoId: video.id,
      // The RUN's timestamp, never `new Date()`: `@@unique([postId,
      // capturedAt])` is what makes a retried job collide with its own earlier
      // write instead of appending a second row for the same observation.
      capturedAt: input.runAt,
      views: video.views,
      likes: video.likes,
      comments: video.comments,
    });
  }

  return { posts, snapshots, videosSeen: input.videos.length, excluded };
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `bun test apps/poller/src/ingest.test.ts apps/poller/src/duration.test.ts`
Expected: PASS, 11 tests

- [ ] **Step 9: Commit**

```bash
git add apps/poller/src/duration.ts apps/poller/src/duration.test.ts apps/poller/src/ingest.ts apps/poller/src/ingest.test.ts
git commit -m "feat(poller): the frame's inclusion rule and the ingest plan"
```

---

## Task 8: Poll cadence

**Files:**

- Create: `apps/poller/src/cadence.ts`, `apps/poller/src/cadence.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `DAILY_WINDOW_DAYS = 14`, `WEEKLY_INTERVAL_DAYS = 7`, `utcDaysBetween(from: Date, to: Date): number`, `isDue(post: { firstSeenAt: Date; lastSnapshotAt: Date | null }, runAt: Date): boolean`, `pollIntervalDays(firstSeenAt: Date, runAt: Date): number`.

- [ ] **Step 1: Write the failing test**

`apps/poller/src/cadence.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { DAILY_WINDOW_DAYS, isDue, pollIntervalDays, utcDaysBetween } from './cadence.ts';

const at = (iso: string) => new Date(iso);
const RUN = at('2026-08-12T03:00:00Z');
const days = (n: number) => new Date(RUN.getTime() - n * 86_400_000);

describe('utcDaysBetween', () => {
  test('counts whole UTC days', () => {
    expect(utcDaysBetween(at('2026-08-11T23:00:00Z'), at('2026-08-12T03:00:00Z'))).toBe(0);
    expect(utcDaysBetween(at('2026-08-11T01:00:00Z'), at('2026-08-12T03:00:00Z'))).toBe(1);
    expect(utcDaysBetween(at('2026-07-13T03:00:00Z'), at('2026-08-12T03:00:00Z'))).toBe(30);
  });
});

describe('pollIntervalDays', () => {
  test('is daily inside the first 14 days and weekly after', () => {
    expect(pollIntervalDays(days(0), RUN)).toBe(1);
    expect(pollIntervalDays(days(13), RUN)).toBe(1);
    // Exactly at the boundary the post is 14 days old — the daily window has
    // closed. Stated as a test because "the first 14 days" is ambiguous prose.
    expect(pollIntervalDays(days(DAILY_WINDOW_DAYS), RUN)).toBe(7);
    expect(pollIntervalDays(days(40), RUN)).toBe(7);
  });
});

describe('isDue', () => {
  test('a post never snapshotted is always due', () => {
    expect(isDue({ firstSeenAt: days(0), lastSnapshotAt: null }, RUN)).toBe(true);
    expect(isDue({ firstSeenAt: days(200), lastSnapshotAt: null }, RUN)).toBe(true);
  });

  test('a post snapshotted today is not due again', () => {
    // The daily job runs at a fixed hour, but a retry or a manual run must not
    // append a second observation for the same day.
    expect(isDue({ firstSeenAt: days(3), lastSnapshotAt: days(0) }, RUN)).toBe(false);
  });

  test('inside the daily window, yesterday is due', () => {
    expect(isDue({ firstSeenAt: days(3), lastSnapshotAt: days(1) }, RUN)).toBe(true);
  });

  test('outside it, three days old is not due but seven is', () => {
    expect(isDue({ firstSeenAt: days(40), lastSnapshotAt: days(3) }, RUN)).toBe(false);
    expect(isDue({ firstSeenAt: days(40), lastSnapshotAt: days(7) }, RUN)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test apps/poller/src/cadence.test.ts`
Expected: FAIL — `Cannot find module './cadence.ts'`

- [ ] **Step 3: Implement it**

`apps/poller/src/cadence.ts`:

```ts
/**
 * When a post is polled again — daily for two weeks, then weekly (spec §5c).
 *
 * This is the design's least obvious payoff. A single-shot crawl forces you to
 * *assume* when engagement has matured; a time series lets you **measure** it
 * (see `maturation.ts`). It also enables the fixed-age measurement the primary
 * label depends on — every post's views can be read at the same AGE rather than
 * the same calendar moment, which removes the dominant confound in any crawled
 * corpus by construction rather than by normalising it away. And it satisfies
 * YouTube's "keep stored data consistent with live YouTube" obligation as a
 * side effect of doing what the statistics already required.
 *
 * The window is measured from `firstSeenAt`, not `publishedAt`, per §5c: a
 * newly seeded channel's back catalogue gets its own two weeks of dense
 * observation, which is what makes a fixed-age read possible for a post that
 * was already old when the frame was curated.
 */

export const DAILY_WINDOW_DAYS = 14;
export const WEEKLY_INTERVAL_DAYS = 7;

/** Whole UTC days from `from` to `to`, floored. Never negative in practice. */
export function utcDaysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

export function pollIntervalDays(firstSeenAt: Date, runAt: Date): number {
  return utcDaysBetween(firstSeenAt, runAt) < DAILY_WINDOW_DAYS ? 1 : WEEKLY_INTERVAL_DAYS;
}

/**
 * Whether this run should append a snapshot for the post.
 *
 * A post with no snapshot is always due — that is the first observation, and
 * withholding it would leave a post with a label that can never be read.
 */
export function isDue(
  post: { firstSeenAt: Date; lastSnapshotAt: Date | null },
  runAt: Date,
): boolean {
  if (post.lastSnapshotAt === null) return true;
  return utcDaysBetween(post.lastSnapshotAt, runAt) >= pollIntervalDays(post.firstSeenAt, runAt);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/poller/src/cadence.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add apps/poller/src/cadence.ts apps/poller/src/cadence.test.ts
git commit -m "feat(poller): daily-then-weekly poll cadence"
```

---

## Task 9: The two-phase maturation parameter `N`

**Files:**

- Create: `apps/poller/src/maturation.ts`, `apps/poller/src/maturation.test.ts`

**Interfaces:**

- Consumes: `prismaService` from `@repo/db` (only in `readMaturation`).
- Produces: `FALLBACK_N_DAYS = 14`, `PHASE2_MIN_CORPUS_AGE_DAYS = 29`, `PHASE2_MIN_OBSERVATIONS = 30`, `PHASE2_GAIN_THRESHOLD = 0.02`, `PHASE2_AGE_RANGE = { min: 7, max: 28 }`, `GainByAge = { ageDays: number; medianGain: number; observations: number }`, `Maturation = { nDays: number; phase: 1 | 2 }`, `chooseMaturation(input: { corpusAgeDays: number; gains: GainByAge[] }): Maturation`, `MEDIAN_GAIN_BY_AGE_SQL: string`, `readMaturation(now: Date): Promise<Maturation>`.

- [ ] **Step 1: Write the failing test**

`apps/poller/src/maturation.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import {
  FALLBACK_N_DAYS,
  PHASE2_MIN_OBSERVATIONS,
  chooseMaturation,
  type GainByAge,
} from './maturation.ts';

const gain = (ageDays: number, medianGain: number, observations = 500): GainByAge => ({
  ageDays,
  medianGain,
  observations,
});

/** Growth that flattens below the threshold from day 11 onward. */
const FLATTENS_AT_11: GainByAge[] = [
  gain(7, 0.4),
  gain(8, 0.22),
  gain(9, 0.1),
  gain(10, 0.05),
  gain(11, 0.015),
  gain(12, 0.01),
];

describe('phase 1', () => {
  test('uses the fallback while the corpus is younger than 29 days', () => {
    // The fallback is not a placeholder to be deleted — it is the value used
    // whenever the query cannot answer, so a fresh environment is never blocked
    // on four weeks of history.
    expect(chooseMaturation({ corpusAgeDays: 3, gains: FLATTENS_AT_11 })).toEqual({
      nDays: FALLBACK_N_DAYS,
      phase: 1,
    });
    expect(chooseMaturation({ corpusAgeDays: 28, gains: FLATTENS_AT_11 })).toEqual({
      nDays: FALLBACK_N_DAYS,
      phase: 1,
    });
  });
});

describe('phase 2', () => {
  test('takes the smallest age at which growth has flattened', () => {
    expect(chooseMaturation({ corpusAgeDays: 60, gains: FLATTENS_AT_11 })).toEqual({
      nDays: 11,
      phase: 2,
    });
  });

  test('ignores an age with too few observations to have a median', () => {
    const thin = [gain(8, 0.001, PHASE2_MIN_OBSERVATIONS - 1), ...FLATTENS_AT_11];
    expect(chooseMaturation({ corpusAgeDays: 60, gains: thin }).nDays).toBe(11);
  });

  test('ignores ages outside the searched range', () => {
    const early = [gain(2, 0.0), ...FLATTENS_AT_11];
    expect(chooseMaturation({ corpusAgeDays: 60, gains: early }).nDays).toBe(11);
  });

  test('falls back, and says PHASE 1, when nothing has flattened', () => {
    // The phase is reported honestly: a run using the fallback must never claim
    // phase 2, or the manifest would say the parameter was measured when it was
    // assumed.
    const stillGrowing = [gain(7, 0.5), gain(14, 0.3), gain(28, 0.2)];
    expect(chooseMaturation({ corpusAgeDays: 60, gains: stillGrowing })).toEqual({
      nDays: FALLBACK_N_DAYS,
      phase: 1,
    });
  });

  test('falls back on an empty result set', () => {
    expect(chooseMaturation({ corpusAgeDays: 60, gains: [] })).toEqual({
      nDays: FALLBACK_N_DAYS,
      phase: 1,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test apps/poller/src/maturation.test.ts`
Expected: FAIL — `Cannot find module './maturation.ts'`

- [ ] **Step 3: Implement it**

`apps/poller/src/maturation.ts`:

```ts
import { prismaService } from '@repo/db';

/**
 * `N` — the age at which the label is read AND the age below which a post is
 * excluded (spec §5c).
 *
 * **One parameter serving two jobs, deliberately not two knobs.** If the
 * measurement age and the inclusion floor could drift apart, the corpus would
 * contain posts whose label was read before they qualified, and nothing would
 * flag it.
 *
 * Two phases:
 *
 *   1. days 1-28, before enough series exist — the hard-coded fallback, 14.
 *   2. day 29+, computed by SQL over `corpus.metric_snapshots`: the smallest
 *      age at which the median post's day-over-day view growth has flattened.
 *
 * The fallback is not a placeholder awaiting deletion. It stays as the value
 * used whenever the phase-2 query has insufficient data, so a fresh environment
 * is never blocked on four weeks of history.
 *
 * **The snapshot manifest records both the value and the phase.** Without that,
 * two runs at different floors are silently incomparable — the label itself
 * changed meaning between them — and a shifted parameter would show up as an
 * unexplainable movement in rho rather than a visible difference in the
 * artifact. Which is why `chooseMaturation` reports phase 1 whenever it returns
 * the fallback, even at a corpus age where phase 2 was eligible: the phase
 * describes where the NUMBER came from, not what the calendar allowed.
 */

export const FALLBACK_N_DAYS = 14;

/** Phase 2 becomes eligible once the corpus is old enough to have series. */
export const PHASE2_MIN_CORPUS_AGE_DAYS = 29;

/** Below this many post-days at an age, its median is noise. */
export const PHASE2_MIN_OBSERVATIONS = 30;

/** Day-over-day relative view gain under which growth counts as flattened. */
export const PHASE2_GAIN_THRESHOLD = 0.02;

/**
 * Ages searched. The floor of 7 keeps `N` from landing inside the first-week
 * surge even if a quiet cohort flattens early; the ceiling of 28 keeps the
 * inclusion floor from swallowing most of the corpus.
 */
export const PHASE2_AGE_RANGE = { min: 7, max: 28 } as const;

export interface GainByAge {
  ageDays: number;
  medianGain: number;
  observations: number;
}

export interface Maturation {
  nDays: number;
  phase: 1 | 2;
}

export function chooseMaturation(input: { corpusAgeDays: number; gains: GainByAge[] }): Maturation {
  if (input.corpusAgeDays < PHASE2_MIN_CORPUS_AGE_DAYS) {
    return { nDays: FALLBACK_N_DAYS, phase: 1 };
  }

  const flattened = input.gains
    .filter(
      (g) =>
        g.observations >= PHASE2_MIN_OBSERVATIONS &&
        g.ageDays >= PHASE2_AGE_RANGE.min &&
        g.ageDays <= PHASE2_AGE_RANGE.max &&
        g.medianGain < PHASE2_GAIN_THRESHOLD,
    )
    .map((g) => g.ageDays)
    .sort((a, b) => a - b);

  const smallest = flattened[0];
  if (smallest === undefined) return { nDays: FALLBACK_N_DAYS, phase: 1 };
  return { nDays: smallest, phase: 2 };
}

/**
 * Median day-over-day relative view gain, by post age.
 *
 * One row per post-day rather than per snapshot: two polls on the same UTC day
 * (a retry, a manual run) would otherwise contribute a spurious zero-gain step.
 */
export const MEDIAN_GAIN_BY_AGE_SQL = `
  with daily as (
    select s.post_id,
           floor(extract(epoch from (s.captured_at - p.published_at)) / 86400)::int as age_days,
           max(s.views) as views
    from corpus.metric_snapshots s
    join corpus.posts p on p.id = s.post_id
    where s.views is not null
    group by 1, 2
  ),
  stepped as (
    select age_days,
           views,
           lag(views) over (partition by post_id order by age_days) as previous
    from daily
  )
  select age_days,
         percentile_cont(0.5) within group (
           order by (views - previous)::float8 / previous
         ) as median_gain,
         count(*) as observations
  from stepped
  where previous is not null and previous > 0
  group by age_days
  order by age_days
`;

/** Corpus age is the age of its oldest observation, not of its oldest post. */
const CORPUS_AGE_SQL = `
  select coalesce(
    floor(extract(epoch from (now() - min(captured_at))) / 86400)::int, 0
  ) as age_days
  from corpus.metric_snapshots
`;

export async function readMaturation(): Promise<Maturation> {
  const [[age], gains] = await Promise.all([
    prismaService.$queryRawUnsafe<{ age_days: number }[]>(CORPUS_AGE_SQL),
    prismaService.$queryRawUnsafe<
      { age_days: number; median_gain: number | null; observations: bigint }[]
    >(MEDIAN_GAIN_BY_AGE_SQL),
  ]);

  return chooseMaturation({
    corpusAgeDays: age?.age_days ?? 0,
    gains: gains
      .filter((row) => row.median_gain !== null)
      .map((row) => ({
        ageDays: row.age_days,
        medianGain: row.median_gain!,
        // `count(*)` is a bigint, which the driver hands back as BigInt.
        observations: Number(row.observations),
      })),
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/poller/src/maturation.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add apps/poller/src/maturation.ts apps/poller/src/maturation.test.ts
git commit -m "feat(poller): two-phase maturation parameter with an honest phase label"
```

---

## Task 10: The poll cycle — orchestration and persistence

**Files:**

- Create: `apps/poller/src/store.ts`, `apps/poller/src/poll.ts`, `apps/poller/src/poll.test.ts`

**Interfaces:**

- Consumes: `SeedChannel` (`./seeds.ts`), `YouTubeClient` (`./youtube.ts`), `planIngest`/`IngestPlan`/`PlannedPost`/`PlannedSnapshot` (`./ingest.ts`), `isDue` (`./cadence.ts`).
- Produces:
  - `StoredPost = { id: string; platformVideoId: string; firstSeenAt: Date; lastSnapshotAt: Date | null }`
  - `CorpusStore = { upsertChannel(...): Promise<{ id: string }>; upsertPosts(...): Promise<StoredPost[]>; appendSnapshots(...): Promise<number>; recordPollRun(...): Promise<void> }`
  - `prismaStore(db?): CorpusStore`
  - `PollOutcome = { channelId: string | null; plan: IngestPlan | null; snapshotsWritten: number; skipped: 'no_uploads_playlist' | 'channel_not_found' | null }`
  - `pollChannel(input: { seed: SeedChannel; youtube: YouTubeClient; store: CorpusStore; runAt: Date; postsPerChannel: number }): Promise<PollOutcome>`
  - `POSTS_PER_CHANNEL = 40`

The split is deliberate: `pollChannel` is pure orchestration over a narrow `CorpusStore` port and is fully tested; `prismaStore` is the thin Prisma layer, typechecked but only exercised against a real database. That is the same posture `apps/worker` already states about its own writes.

- [ ] **Step 1: Write the failing test**

`apps/poller/src/poll.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import type { SeedChannel } from './seeds.ts';
import type { CorpusStore, StoredPost } from './store.ts';
import { POSTS_PER_CHANNEL, pollChannel } from './poll.ts';
import type { YouTubeChannel, YouTubeClient, YouTubeVideo } from './youtube.ts';

const RUN_AT = new Date('2026-08-12T03:00:00.000Z');
const daysBefore = (n: number) => new Date(RUN_AT.getTime() - n * 86_400_000);

const SEED: SeedChannel = {
  id: 'UCabcdefghijklmnopqrstuv',
  handle: '@example',
  niche: 'cooking',
  tier: 'mid',
  rationale: 'Posts 3-5 Shorts a week with visibly variable reach; not a repost account.',
};

const video = (id: string, overrides: Partial<YouTubeVideo> = {}): YouTubeVideo => ({
  id,
  channelId: SEED.id,
  publishedAt: '2026-08-01T12:00:00Z',
  title: `title ${id}`,
  description: '',
  tags: [],
  duration: 'PT20S',
  license: 'youtube',
  privacyStatus: 'public',
  views: 100,
  likes: 10,
  comments: 1,
  ...overrides,
});

function fakeYouTube(videos: YouTubeVideo[], channel: Partial<YouTubeChannel> = {}): YouTubeClient {
  return {
    async channels() {
      return [
        {
          id: SEED.id,
          title: 'Example Kitchen',
          uploadsPlaylistId: 'UUabcdefghijklmnopqrstuv',
          subscriberCount: 184000,
          ...channel,
        },
      ];
    },
    async uploads(_playlistId, limit) {
      return videos.slice(0, limit).map((v) => v.id);
    },
    async videos(ids) {
      return videos.filter((v) => ids.includes(v.id));
    },
  };
}

function fakeStore(stored: StoredPost[] = []) {
  const appended: { postId: string; capturedAt: Date }[] = [];
  const runs: { videosSeen: number; postsIncluded: number; excluded: Record<string, number> }[] =
    [];
  const store: CorpusStore = {
    async upsertChannel() {
      return { id: 'channel-uuid' };
    },
    async upsertPosts(_channelId, posts) {
      return posts.map(
        (post) =>
          stored.find((s) => s.platformVideoId === post.platformVideoId) ?? {
            id: `post-${post.platformVideoId}`,
            platformVideoId: post.platformVideoId,
            firstSeenAt: RUN_AT,
            lastSnapshotAt: null,
          },
      );
    },
    async appendSnapshots(rows) {
      appended.push(...rows.map((r) => ({ postId: r.postId, capturedAt: r.capturedAt })));
      return rows.length;
    },
    async recordPollRun(input) {
      runs.push({
        videosSeen: input.videosSeen,
        postsIncluded: input.postsIncluded,
        excluded: input.excluded,
      });
    },
  };
  return { store, appended, runs };
}

describe('pollChannel', () => {
  test('appends one snapshot per due post, stamped with the run timestamp', async () => {
    const { store, appended } = fakeStore();
    const outcome = await pollChannel({
      seed: SEED,
      youtube: fakeYouTube([video('a'), video('b')]),
      store,
      runAt: RUN_AT,
      postsPerChannel: POSTS_PER_CHANNEL,
    });

    expect(outcome.snapshotsWritten).toBe(2);
    expect(appended.map((a) => a.capturedAt.toISOString())).toEqual([
      RUN_AT.toISOString(),
      RUN_AT.toISOString(),
    ]);
  });

  test('skips a post that is not due yet but keeps its row fresh', async () => {
    // Cadence controls WRITES, not fetches: `videos.list` costs one quota unit
    // for the whole batch, so there is nothing to save by fetching less — and
    // the text refresh on the post row is what keeps the 30-day clock reset.
    const { store, appended } = fakeStore([
      {
        id: 'post-a',
        platformVideoId: 'a',
        firstSeenAt: daysBefore(40),
        lastSnapshotAt: daysBefore(2),
      },
      {
        id: 'post-b',
        platformVideoId: 'b',
        firstSeenAt: daysBefore(2),
        lastSnapshotAt: daysBefore(1),
      },
    ]);
    const outcome = await pollChannel({
      seed: SEED,
      youtube: fakeYouTube([video('a'), video('b')]),
      store,
      runAt: RUN_AT,
      postsPerChannel: POSTS_PER_CHANNEL,
    });

    // `a` is 40 days old on a weekly cadence, snapshotted 2 days ago: not due.
    // `b` is inside the daily window, snapshotted yesterday: due.
    expect(appended.map((a) => a.postId)).toEqual(['post-b']);
    expect(outcome.plan!.posts).toHaveLength(2);
  });

  test('records the run tallies, including exclusions that leave no row behind', async () => {
    const { store, runs } = fakeStore();
    await pollChannel({
      seed: SEED,
      youtube: fakeYouTube([video('a'), video('long', { duration: 'PT4M' })]),
      store,
      runAt: RUN_AT,
      postsPerChannel: POSTS_PER_CHANNEL,
    });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      videosSeen: 2,
      postsIncluded: 1,
      excluded: { duration_over_30s: 1 },
    });
  });

  test('caps the traversal at the configured posts per channel', async () => {
    const many = Array.from({ length: 100 }, (_, i) => video(`v${i}`));
    const { store } = fakeStore();
    const outcome = await pollChannel({
      seed: SEED,
      youtube: fakeYouTube(many),
      store,
      runAt: RUN_AT,
      postsPerChannel: 40,
    });
    expect(outcome.plan!.videosSeen).toBe(40);
  });

  test('reports a channel with no uploads playlist instead of throwing', async () => {
    // A deleted or terminated channel must not take the whole run down — the
    // other 39 channels still have observations to append today, and a missed
    // day is a hole in a time series that cannot be backfilled.
    const { store } = fakeStore();
    const outcome = await pollChannel({
      seed: SEED,
      youtube: fakeYouTube([], { uploadsPlaylistId: null }),
      store,
      runAt: RUN_AT,
      postsPerChannel: POSTS_PER_CHANNEL,
    });
    expect(outcome.skipped).toBe('no_uploads_playlist');
    expect(outcome.snapshotsWritten).toBe(0);
  });

  test('reports a channel the API does not return', async () => {
    const { store } = fakeStore();
    const youtube: YouTubeClient = {
      ...fakeYouTube([]),
      async channels() {
        return [];
      },
    };
    const outcome = await pollChannel({
      seed: SEED,
      youtube,
      store,
      runAt: RUN_AT,
      postsPerChannel: POSTS_PER_CHANNEL,
    });
    expect(outcome.skipped).toBe('channel_not_found');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test apps/poller/src/poll.test.ts`
Expected: FAIL — `Cannot find module './store.ts'`

- [ ] **Step 3: Define the store port and its Prisma implementation**

`apps/poller/src/store.ts`:

```ts
import { prismaService, type PrismaClient } from '@repo/db';

import type { ExclusionReason, PlannedPost } from './ingest.ts';

/**
 * The narrow write surface `pollChannel` needs.
 *
 * A port rather than `PrismaClient` directly, so the poll cycle's rules — which
 * post is due, which exclusion is counted, which timestamp a snapshot carries —
 * are testable without a database, and so the Prisma calls stay in one file
 * that can be read against the schema.
 *
 * Every method here writes through `prismaService`, the BYPASSRLS credential.
 * Corpus tables carry RLS forced with zero policies (spec §3c), so there is no
 * other credential that can reach them at all — which is precisely why this is
 * a separate process from `apps/api`.
 */

export interface StoredPost {
  id: string;
  platformVideoId: string;
  firstSeenAt: Date;
  lastSnapshotAt: Date | null;
}

export interface SnapshotRow {
  postId: string;
  capturedAt: Date;
  views: number | null;
  likes: number | null;
  comments: number | null;
}

export interface CorpusStore {
  upsertChannel(input: {
    platformChannelId: string;
    title: string | null;
    niche: string;
    rationale: string;
    uploadsPlaylistId: string | null;
    subscriberCount: number | null;
    runAt: Date;
  }): Promise<{ id: string }>;

  /** Upserts the posts and returns them with what cadence needs to decide. */
  upsertPosts(channelId: string, posts: PlannedPost[], runAt: Date): Promise<StoredPost[]>;

  /** Appends snapshots, skipping any that already exist. Returns rows written. */
  appendSnapshots(rows: SnapshotRow[]): Promise<number>;

  recordPollRun(input: {
    channelId: string;
    runAt: Date;
    videosSeen: number;
    postsIncluded: number;
    excluded: Record<ExclusionReason, number>;
  }): Promise<void>;
}

export function prismaStore(db: PrismaClient = prismaService): CorpusStore {
  return {
    async upsertChannel(input) {
      return db.corpusChannel.upsert({
        where: { platformChannelId: input.platformChannelId },
        create: {
          platformChannelId: input.platformChannelId,
          title: input.title,
          niche: input.niche,
          rationale: input.rationale,
          uploadsPlaylistId: input.uploadsPlaylistId,
          subscriberCount: input.subscriberCount,
          lastPolledAt: input.runAt,
          textRefreshedAt: input.runAt,
        },
        update: {
          title: input.title,
          niche: input.niche,
          rationale: input.rationale,
          uploadsPlaylistId: input.uploadsPlaylistId,
          subscriberCount: input.subscriberCount,
          lastPolledAt: input.runAt,
          // Refreshing the text resets the 30-day clock. The nightly sweep is a
          // backstop for rows the poller has stopped reaching, not the primary
          // mechanism (spec §6).
          textRefreshedAt: input.runAt,
        },
        select: { id: true },
      });
    },

    async upsertPosts(channelId, posts, runAt) {
      const out: StoredPost[] = [];
      for (const post of posts) {
        const row = await db.corpusPost.upsert({
          where: { platformVideoId: post.platformVideoId },
          create: {
            channelId,
            platformVideoId: post.platformVideoId,
            publishedAt: post.publishedAt,
            durationSec: post.durationSec,
            title: post.title,
            description: post.description,
            tags: post.tags,
            license: post.license,
            firstSeenAt: runAt,
            textRefreshedAt: runAt,
          },
          update: {
            // `publishedAt` and `durationSec` are re-read rather than left
            // alone: a re-uploaded video keeps its id, and a stale duration
            // would leave a >30 s clip inside a frame defined by <=30 s.
            publishedAt: post.publishedAt,
            durationSec: post.durationSec,
            title: post.title,
            description: post.description,
            tags: post.tags,
            license: post.license,
            textRefreshedAt: runAt,
          },
          select: {
            id: true,
            platformVideoId: true,
            firstSeenAt: true,
            snapshots: {
              select: { capturedAt: true },
              orderBy: { capturedAt: 'desc' },
              take: 1,
            },
          },
        });
        out.push({
          id: row.id,
          platformVideoId: row.platformVideoId,
          firstSeenAt: row.firstSeenAt,
          lastSnapshotAt: row.snapshots[0]?.capturedAt ?? null,
        });
      }
      return out;
    },

    async appendSnapshots(rows) {
      if (rows.length === 0) return 0;
      // `skipDuplicates` plus the deterministic `capturedAt` is what makes an
      // at-least-once retry a no-op: the second attempt collides with its own
      // earlier write on `@@unique([postId, capturedAt])` instead of appending
      // a second observation of the same moment. Nothing is ever updated.
      const { count } = await db.corpusMetricSnapshot.createMany({
        data: rows.map((row) => ({
          postId: row.postId,
          capturedAt: row.capturedAt,
          views: row.views === null ? null : BigInt(row.views),
          likes: row.likes === null ? null : BigInt(row.likes),
          comments: row.comments === null ? null : BigInt(row.comments),
        })),
        skipDuplicates: true,
      });
      return count;
    },

    async recordPollRun(input) {
      await db.corpusPollRun.upsert({
        where: { channelId_runAt: { channelId: input.channelId, runAt: input.runAt } },
        create: {
          channelId: input.channelId,
          runAt: input.runAt,
          videosSeen: input.videosSeen,
          postsIncluded: input.postsIncluded,
          excluded: input.excluded,
        },
        update: {
          videosSeen: input.videosSeen,
          postsIncluded: input.postsIncluded,
          excluded: input.excluded,
        },
      });
    },
  };
}
```

- [ ] **Step 4: Implement the orchestration**

`apps/poller/src/poll.ts`:

```ts
import { isDue } from './cadence.ts';
import { planIngest, type IngestPlan } from './ingest.ts';
import type { SeedChannel } from './seeds.ts';
import type { CorpusStore, SnapshotRow } from './store.ts';
import type { YouTubeClient } from './youtube.ts';

/**
 * One channel's poll: traverse, plan, persist.
 *
 * Traversal is channel-first and does no discovery (spec §5a) —
 * `channels.list` for the uploads playlist and subscriber count,
 * `playlistItems.list` to walk it, `videos.list` batched 50 at a time. Three
 * calls of 1 quota unit each per channel, against a 10,000/day default.
 */

/** ~40 x 40 ~= 1,600 posts, above the prereg floor of >=20 per creator (§5d). */
export const POSTS_PER_CHANNEL = 40;

export interface PollOutcome {
  channelId: string | null;
  plan: IngestPlan | null;
  snapshotsWritten: number;
  /** Set when the channel could not be traversed at all. */
  skipped: 'no_uploads_playlist' | 'channel_not_found' | null;
}

export async function pollChannel(input: {
  seed: SeedChannel;
  youtube: YouTubeClient;
  store: CorpusStore;
  runAt: Date;
  postsPerChannel: number;
}): Promise<PollOutcome> {
  const [channel] = await input.youtube.channels([input.seed.id]);
  if (!channel) {
    // A terminated or renamed channel. Reported, not thrown: the other 39
    // channels still have observations to append today, and a missed day is a
    // hole in a time series that cannot be backfilled later.
    return { channelId: null, plan: null, snapshotsWritten: 0, skipped: 'channel_not_found' };
  }

  const stored = await input.store.upsertChannel({
    platformChannelId: channel.id,
    title: channel.title,
    niche: input.seed.niche,
    rationale: input.seed.rationale,
    uploadsPlaylistId: channel.uploadsPlaylistId,
    subscriberCount: channel.subscriberCount,
    runAt: input.runAt,
  });

  if (!channel.uploadsPlaylistId) {
    return {
      channelId: stored.id,
      plan: null,
      snapshotsWritten: 0,
      skipped: 'no_uploads_playlist',
    };
  }

  const videoIds = await input.youtube.uploads(channel.uploadsPlaylistId, input.postsPerChannel);
  const videos = await input.youtube.videos(videoIds);
  const plan = planIngest({ videos, runAt: input.runAt });

  const posts = await input.store.upsertPosts(stored.id, plan.posts, input.runAt);
  const byVideoId = new Map(posts.map((post) => [post.platformVideoId, post]));

  // Cadence gates the WRITE, not the fetch: `videos.list` costs one unit for
  // the whole batch of 50, so fetching fewer saves nothing — while an unwritten
  // snapshot saves a row in the 36-month tier and keeps the series at the
  // density §5c asks for.
  const rows: SnapshotRow[] = [];
  for (const snapshot of plan.snapshots) {
    const post = byVideoId.get(snapshot.platformVideoId);
    if (!post || !isDue(post, input.runAt)) continue;
    rows.push({
      postId: post.id,
      capturedAt: snapshot.capturedAt,
      views: snapshot.views,
      likes: snapshot.likes,
      comments: snapshot.comments,
    });
  }

  const snapshotsWritten = await input.store.appendSnapshots(rows);

  await input.store.recordPollRun({
    channelId: stored.id,
    runAt: input.runAt,
    videosSeen: plan.videosSeen,
    postsIncluded: plan.posts.length,
    excluded: plan.excluded,
  });

  return { channelId: stored.id, plan, snapshotsWritten, skipped: null };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test apps/poller/src/poll.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 6: Typecheck the Prisma layer**

Run: `bun run typecheck`
Expected: clean — this is the only check `prismaStore` gets until a database is in front of it.

- [ ] **Step 7: Commit**

```bash
git add apps/poller/src/store.ts apps/poller/src/poll.ts apps/poller/src/poll.test.ts
git commit -m "feat(poller): the poll cycle, with idempotent snapshot appends"
```

---

## Task 11: The 30-day text sweep

**Files:**

- Create: `apps/poller/src/sweep.ts`, `apps/poller/src/sweep.test.ts`

**Interfaces:**

- Consumes: `prismaService` from `@repo/db`.
- Produces: `TEXT_RETENTION_DAYS = 30`, `textCutoff(now: Date): Date`, `isTextExpired(textRefreshedAt: Date | null, now: Date): boolean`, `SweepStore = { nullPostText(cutoff: Date): Promise<number>; nullChannelText(cutoff: Date): Promise<number> }`, `prismaSweepStore(db?): SweepStore`, `sweepText(input: { now: Date; store: SweepStore }): Promise<{ posts: number; channels: number }>`.

YouTube's derived-metrics policy splits retention three ways rather than applying a flat 30 days: statistical metrics and derived metrics are retainable for **36 months**, and only **text** — titles, descriptions, tags, channel names — is on the short clock (§6). So the corpus itself is fine for three years; this sweep touches the columns that are not.

- [ ] **Step 1: Write the failing test**

`apps/poller/src/sweep.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { TEXT_RETENTION_DAYS, isTextExpired, sweepText, textCutoff } from './sweep.ts';

const NOW = new Date('2026-08-12T04:00:00.000Z');
const daysBefore = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe('the clock', () => {
  test('the cutoff is 30 days back', () => {
    expect(textCutoff(NOW).toISOString()).toBe(daysBefore(TEXT_RETENTION_DAYS).toISOString());
  });

  test('a row the poller refreshed is not expired', () => {
    // The poller refreshes on its own cadence, so the sweep is a backstop for
    // abandoned rows rather than the primary mechanism (spec §6).
    expect(isTextExpired(daysBefore(1), NOW)).toBe(false);
    expect(isTextExpired(daysBefore(29), NOW)).toBe(false);
  });

  test('a row untouched for over 30 days is expired', () => {
    expect(isTextExpired(daysBefore(31), NOW)).toBe(true);
  });

  test('a row already swept is not swept again', () => {
    // The sweep nulls `textRefreshedAt` along with the text, so a nulled row
    // stops matching. Without that, every sweep rewrites every dead row forever.
    expect(isTextExpired(null, NOW)).toBe(false);
  });
});

describe('sweepText', () => {
  test('nulls posts and channel titles against the same cutoff', async () => {
    const seen: Date[] = [];
    const result = await sweepText({
      now: NOW,
      store: {
        async nullPostText(cutoff) {
          seen.push(cutoff);
          return 7;
        },
        async nullChannelText(cutoff) {
          seen.push(cutoff);
          return 2;
        },
      },
    });

    expect(result).toEqual({ posts: 7, channels: 2 });
    expect(seen.map((d) => d.toISOString())).toEqual([
      textCutoff(NOW).toISOString(),
      textCutoff(NOW).toISOString(),
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test apps/poller/src/sweep.test.ts`
Expected: FAIL — `Cannot find module './sweep.ts'`

- [ ] **Step 3: Implement it**

`apps/poller/src/sweep.ts`:

```ts
import { prismaService, type PrismaClient } from '@repo/db';

/**
 * The 30-day text sweep (spec §6).
 *
 * YouTube's derived-metrics policy splits retention three ways rather than
 * applying a flat 30 days:
 *
 *   * statistical metrics (views, likes, comments, subscriber counts) — 36 months
 *   * derived metrics (anything computed from them) — 36 months
 *   * everything else (titles, descriptions, channel names) — 30 days, refresh
 *     or delete
 *
 * So the training corpus — the numbers, and everything derived from them — is
 * retainable for three years, which is longer than this validation needs. Only
 * TEXT is on the short clock, and that is all this touches.
 *
 * The 36-month tier requires the use-case amendment to be accepted; until then
 * the corpus operates under the base 30-day policy. That is a form, not a
 * negotiation, and it gates nothing else — file it on day one.
 *
 * This is a BACKSTOP. The poller refreshes `textRefreshedAt` on every pass, so
 * in steady state nothing here matches; what it catches is rows the poller has
 * stopped reaching (a deleted video, a channel dropped from the frame).
 */

export const TEXT_RETENTION_DAYS = 30;

export function textCutoff(now: Date): Date {
  return new Date(now.getTime() - TEXT_RETENTION_DAYS * 86_400_000);
}

/**
 * A null `textRefreshedAt` is a row already swept, not a row overdue.
 *
 * The sweep nulls the timestamp along with the text, which is what stops it
 * rewriting every dead row on every run, forever.
 */
export function isTextExpired(textRefreshedAt: Date | null, now: Date): boolean {
  if (textRefreshedAt === null) return false;
  return textRefreshedAt < textCutoff(now);
}

export interface SweepStore {
  nullPostText(cutoff: Date): Promise<number>;
  nullChannelText(cutoff: Date): Promise<number>;
}

export function prismaSweepStore(db: PrismaClient = prismaService): SweepStore {
  return {
    async nullPostText(cutoff) {
      const { count } = await db.corpusPost.updateMany({
        where: { textRefreshedAt: { lt: cutoff } },
        data: { title: null, description: null, tags: [], textRefreshedAt: null },
      });
      return count;
    },
    async nullChannelText(cutoff) {
      const { count } = await db.corpusChannel.updateMany({
        where: { textRefreshedAt: { lt: cutoff } },
        data: { title: null, textRefreshedAt: null },
      });
      return count;
    },
  };
}

export async function sweepText(input: {
  now: Date;
  store: SweepStore;
}): Promise<{ posts: number; channels: number }> {
  const cutoff = textCutoff(input.now);
  return {
    posts: await input.store.nullPostText(cutoff),
    channels: await input.store.nullChannelText(cutoff),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/poller/src/sweep.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add apps/poller/src/sweep.ts apps/poller/src/sweep.test.ts
git commit -m "feat(poller): nightly 30-day text sweep as a retention backstop"
```

---

## Task 12: The weekly corpus-readiness report

**Files:**

- Create: `apps/poller/src/readiness.ts`, `apps/poller/src/readiness.test.ts`

**Interfaces:**

- Consumes: `Maturation` (`./maturation.ts`), `prismaService`.
- Produces:
  - `MIN_POSTS_PER_CHANNEL = 20`
  - `ChannelReadiness = { platformChannelId: string; title: string | null; niche: string | null; posts: number; ccbyUnder30s: number; matureposts: number }`
  - `Readiness = { generatedAt: Date; maturation: Maturation; channels: ChannelReadiness[]; exclusions: Record<string, number>; totals: { channels: number; posts: number; clearingFloor: number; ccbyClearingFloor: number } }`
  - `summarise(input: { generatedAt: Date; maturation: Maturation; channels: ChannelReadiness[]; exclusions: Record<string, number> }): Readiness`
  - `renderReadiness(readiness: Readiness): string`
  - `buildReadiness(input: { now: Date; maturation: Maturation; db?: PrismaClient }): Promise<Readiness>`

This is what makes §7's decision self-answering (§12.2). `status.license` is captured on a call already being made, so "do enough channels have ≥20 Creative-Commons clips under 30 s?" arrives as a standing number somebody is already looking at, rather than a question that has to be remembered.

- [ ] **Step 1: Write the failing test**

`apps/poller/src/readiness.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { MIN_POSTS_PER_CHANNEL, renderReadiness, summarise } from './readiness.ts';

const GENERATED_AT = new Date('2026-08-17T05:00:00.000Z');

const channel = (name: string, posts: number, ccbyUnder30s: number, maturePosts = posts) => ({
  platformChannelId: `UC${name.padEnd(22, 'x')}`,
  title: name,
  niche: 'cooking',
  posts,
  ccbyUnder30s,
  maturePosts,
});

const input = {
  generatedAt: GENERATED_AT,
  maturation: { nDays: 14, phase: 1 as const },
  channels: [channel('alpha', 42, 30), channel('beta', 41, 3), channel('gamma', 12, 12)],
  exclusions: { duration_over_30s: 118, not_public: 4, not_a_clip: 2, missing_published_at: 0 },
};

describe('summarise', () => {
  test('counts the channels clearing the >=20-post floor', () => {
    const readiness = summarise(input);
    expect(readiness.totals.channels).toBe(3);
    expect(readiness.totals.posts).toBe(95);
    expect(readiness.totals.clearingFloor).toBe(2);
  });

  test('counts the CC-BY floor separately — that is the §7 number', () => {
    // Whether the deferred source-file question has a licence-based answer is
    // exactly "how many channels have >=20 CC-BY Shorts under 30 s", and it is
    // NOT the same count as the overall floor: beta clears one and not the other.
    expect(summarise(input).totals.ccbyClearingFloor).toBe(1);
    expect(MIN_POSTS_PER_CHANNEL).toBe(20);
  });
});

describe('renderReadiness', () => {
  const report = renderReadiness(summarise(input));

  test('names the maturation value AND its phase', () => {
    // Two runs at different floors are silently incomparable unless the phase
    // is visible — the label itself changed meaning between them.
    expect(report).toContain('N = 14 days');
    expect(report).toContain('phase 1');
  });

  test('states exclusions by reason', () => {
    expect(report).toContain('duration_over_30s');
    expect(report).toContain('118');
  });

  test('states both floors, so the §7 decision is a standing number', () => {
    expect(report).toMatch(/2\s*\/\s*3 channels/);
    expect(report).toMatch(/1\s*\/\s*3 channels/);
  });

  test('is a plain Markdown document with a dated title', () => {
    expect(report.split('\n')[0]).toBe('# Corpus readiness — 2026-08-17');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test apps/poller/src/readiness.test.ts`
Expected: FAIL — `Cannot find module './readiness.ts'`

- [ ] **Step 3: Implement it**

`apps/poller/src/readiness.ts`:

```ts
import { prismaService, type PrismaClient } from '@repo/db';

import type { Maturation } from './maturation.ts';

/**
 * The weekly corpus-readiness report (spec §12.2).
 *
 * This exists so the deferred §7 decision — which source-file acquisition route
 * to take, if any — arrives as a **standing number somebody is already looking
 * at**, rather than a question that has to be remembered. `status.license` is
 * captured on the `videos.list` call already being made, at no extra quota, so
 * "do enough channels have >=20 Creative-Commons clips under 30 s?" is a SQL
 * query against the corpus rather than a separate research exercise. Whichever
 * route is eventually chosen, no re-crawl is needed.
 *
 * It also states the maturation parameter and its phase, the exclusion tallies
 * by reason, and how many channels clear the >=20-post floor — the four numbers
 * that say whether the corpus is worth extracting yet.
 */

/** The prereg's per-creator floor. */
export const MIN_POSTS_PER_CHANNEL = 20;

export interface ChannelReadiness {
  platformChannelId: string;
  title: string | null;
  niche: string | null;
  posts: number;
  /** Posts under 30 s whose `license` is `creativeCommon`. */
  ccbyUnder30s: number;
  /** Posts old enough for the current `N` — the ones that have a label today. */
  maturePosts: number;
}

export interface Readiness {
  generatedAt: Date;
  maturation: Maturation;
  channels: ChannelReadiness[];
  exclusions: Record<string, number>;
  totals: {
    channels: number;
    posts: number;
    clearingFloor: number;
    ccbyClearingFloor: number;
  };
}

export function summarise(input: {
  generatedAt: Date;
  maturation: Maturation;
  channels: ChannelReadiness[];
  exclusions: Record<string, number>;
}): Readiness {
  return {
    ...input,
    totals: {
      channels: input.channels.length,
      posts: input.channels.reduce((total, c) => total + c.posts, 0),
      clearingFloor: input.channels.filter((c) => c.posts >= MIN_POSTS_PER_CHANNEL).length,
      // Deliberately a separate count, not a filter of the previous one: a
      // channel can clear the post floor and hold almost no CC-BY clips, and
      // conflating the two would answer §7 with the wrong number.
      ccbyClearingFloor: input.channels.filter((c) => c.ccbyUnder30s >= MIN_POSTS_PER_CHANNEL)
        .length,
    },
  };
}

export function renderReadiness(readiness: Readiness): string {
  const day = readiness.generatedAt.toISOString().slice(0, 10);
  const { totals, maturation } = readiness;

  const lines = [
    `# Corpus readiness — ${day}`,
    '',
    `Maturation: **N = ${maturation.nDays} days** (phase ${maturation.phase}). ` +
      'Two runs at different floors are not comparable — the label changed meaning ' +
      'between them — so the phase is stated beside the value, always.',
    '',
    `Frame: **${totals.channels} channels · ${totals.posts} posts**.`,
    `Clearing the >=${MIN_POSTS_PER_CHANNEL}-post floor: ` +
      `**${totals.clearingFloor} / ${totals.channels} channels**.`,
    `Clearing it in Creative-Commons clips under 30 s: ` +
      `**${totals.ccbyClearingFloor} / ${totals.channels} channels** — this is the ` +
      'number the deferred source-file decision (spec §7) turns on.',
    '',
    '## Per channel',
    '',
    '| Channel | Niche | Posts | Mature | CC-BY <=30s |',
    '| ------- | ----- | ----- | ------ | ----------- |',
    ...readiness.channels.map(
      (c) =>
        `| ${c.title ?? c.platformChannelId} | ${c.niche ?? '—'} | ${c.posts} | ` +
        `${c.maturePosts} | ${c.ccbyUnder30s} |`,
    ),
    '',
    '## Exclusions, by reason',
    '',
    '| Reason | Count |',
    '| ------ | ----- |',
    ...Object.entries(readiness.exclusions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, count]) => `| ${reason} | ${count} |`),
    '',
    'Exclusions are counted at ingest and are the frame definition only ' +
      '(public, dated, <=30 s). Age, hidden likes and the secondary outcome’s ' +
      'denominator floor are applied per-outcome at extract time — see spec §5b.',
    '',
  ];

  return lines.join('\n');
}

export async function buildReadiness(input: {
  now: Date;
  maturation: Maturation;
  db?: PrismaClient;
}): Promise<Readiness> {
  const db = input.db ?? prismaService;
  const matureBefore = new Date(input.now.getTime() - input.maturation.nDays * 86_400_000);

  const channels = await db.corpusChannel.findMany({
    select: {
      platformChannelId: true,
      title: true,
      niche: true,
      posts: { select: { license: true, publishedAt: true } },
    },
    orderBy: { platformChannelId: 'asc' },
  });

  const runs = await db.corpusPollRun.findMany({
    where: { runAt: { gte: new Date(input.now.getTime() - 7 * 86_400_000) } },
    select: { excluded: true },
  });

  const exclusions: Record<string, number> = {};
  for (const run of runs) {
    for (const [reason, count] of Object.entries(run.excluded as Record<string, number>)) {
      exclusions[reason] = (exclusions[reason] ?? 0) + count;
    }
  }

  return summarise({
    generatedAt: input.now,
    maturation: input.maturation,
    channels: channels.map((channel) => ({
      platformChannelId: channel.platformChannelId,
      title: channel.title,
      niche: channel.niche,
      posts: channel.posts.length,
      // Every stored post is already <=30 s — that is the frame's definition,
      // applied at ingest — so the licence is the only extra predicate here.
      ccbyUnder30s: channel.posts.filter((post) => post.license === 'creativeCommon').length,
      maturePosts: channel.posts.filter((post) => post.publishedAt <= matureBefore).length,
    })),
    exclusions,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/poller/src/readiness.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add apps/poller/src/readiness.ts apps/poller/src/readiness.test.ts
git commit -m "feat(poller): weekly readiness report that answers the §7 question standing"
```

---

## Task 13: The scheduler entrypoint

**Files:**

- Create: `apps/poller/src/queues.ts`, `apps/poller/src/jobs.ts`, `apps/poller/src/jobs.test.ts`, `apps/poller/src/index.ts`, `apps/poller/README.md`
- Modify: `infra/docker/docker-compose.yml:78` (`BULL_QUEUES`), `CLAUDE.md` (layout + commands)

**Interfaces:**

- Consumes: `loadSeeds`, `createYouTubeClient`, `prismaStore`, `pollChannel`, `prismaSweepStore`, `sweepText`, `readMaturation`, `buildReadiness`, `renderReadiness`.
- Produces: `POLL_QUEUE = 'corpus-poll'`, `POLL_JOB = { poll: 'corpus.poll', sweep: 'corpus.sweep', readiness: 'corpus.readiness' }`, `SCHEDULES = { poll: '0 3 * * *', sweep: '0 4 * * *', readiness: '0 5 * * 1' }`, `utcDayStart(moment: Date): Date`, `pollJobDataSchema`, `resolveRunAt(data: unknown, now?: Date): Date`, `runPoll(data: unknown): Promise<void>`, `runSweep(data: unknown): Promise<void>`, `runReadiness(data: unknown): Promise<void>`, `handlePollJob(job: Job<unknown>): Promise<void>`.

**Where `runAt` comes from, and why not the job payload.** Every snapshot this run appends is stamped with `runAt`, and `@@unique([postId, capturedAt])` is what makes an at-least-once retry a no-op — so a retry must produce the _same_ `runAt` as the attempt it is retrying.

The obvious design is to put `runAt` on the repeatable job's payload. **It does not work**, and it fails silently: BullMQ's `upsertJobScheduler` uses the template's `data` verbatim for every occurrence it materialises (`job-scheduler.js` `getNextJobOpts` merges only `opts` — the scheduled slot lands in `opts.prevMillis` and in the generated job id, never in `data`). A template built at registration time would therefore stamp _every_ poll, forever, with one frozen timestamp — every snapshot after the very first would collide on the unique key and be skipped, and the poller would report success while writing nothing.

So `runAt` is **derived in the handler by quantising the wall clock to the UTC day**. Two calls on the same UTC day produce the same value, which gives the retry property directly; a retry runs within minutes of its original against a 24-hour bucket, so the boundary is never in play. It also matches the granularity `cadence.ts` already compares at. An explicit `runAt` on the payload is still honoured, for a manual backfill of a specific day.

- [ ] **Step 1: Write the failing test**

`apps/poller/src/jobs.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { pollJobDataSchema, resolveRunAt, utcDayStart } from './jobs.ts';
import { SCHEDULES } from './queues.ts';

describe('resolveRunAt', () => {
  test('quantises the wall clock to the UTC day', () => {
    const at = resolveRunAt({}, new Date('2026-08-12T03:00:00.000Z'));
    expect(at.toISOString()).toBe('2026-08-12T00:00:00.000Z');
  });

  test('a retry minutes later lands on the same capturedAt', () => {
    // This IS the idempotency property. `@@unique([postId, capturedAt])` only
    // absorbs a retry if the retry computes the same key — so the value must
    // not come from the instant the handler happens to run.
    const first = resolveRunAt({}, new Date('2026-08-12T03:00:00.000Z'));
    const retry = resolveRunAt({}, new Date('2026-08-12T03:04:12.000Z'));
    expect(retry.toISOString()).toBe(first.toISOString());
  });

  test('honours an explicit runAt, for a manual backfill of one day', () => {
    const at = resolveRunAt({ runAt: '2026-07-01T00:00:00.000Z' }, new Date());
    expect(at.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  test('rejects a malformed runAt rather than silently using today', () => {
    expect(() => resolveRunAt({ runAt: 'yesterday' }, new Date())).toThrow();
  });

  test('accepts an absent payload — the scheduler sends none', () => {
    expect(() => pollJobDataSchema.parse({})).not.toThrow();
    expect(resolveRunAt(undefined, new Date('2026-08-12T23:59:59Z')).toISOString()).toBe(
      '2026-08-12T00:00:00.000Z',
    );
  });
});

describe('utcDayStart', () => {
  test('is idempotent and ignores local time', () => {
    const at = new Date('2026-08-12T23:30:00.000Z');
    expect(utcDayStart(utcDayStart(at)).toISOString()).toBe('2026-08-12T00:00:00.000Z');
  });
});

describe('the schedules', () => {
  test('poll daily, sweep nightly, readiness weekly', () => {
    expect(SCHEDULES.poll).toBe('0 3 * * *');
    expect(SCHEDULES.sweep).toBe('0 4 * * *');
    // Monday. The readiness report is meant to be read at the start of a week,
    // not to arrive mid-Friday and wait until Monday to be looked at.
    expect(SCHEDULES.readiness).toBe('0 5 * * 1');
  });

  test('the sweep runs after the poll, so a refreshed row is never swept', () => {
    const hour = (cron: string) => Number(cron.split(' ')[1]);
    expect(hour(SCHEDULES.sweep)).toBeGreaterThan(hour(SCHEDULES.poll));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test apps/poller/src/jobs.test.ts`
Expected: FAIL — `Cannot find module './jobs.ts'`

- [ ] **Step 3: Define the queue names and schedules**

`apps/poller/src/queues.ts`:

```ts
/**
 * The poller's own scheduling queue.
 *
 * Deliberately NOT in `@repo/queue`: nothing outside this process produces to
 * it or consumes from it, so it is not a contract with anyone. The corpus
 * queues that DO cross a process boundary (`corpus` / `corpus-results`, to and
 * from `apps/ml`) live in `@repo/queue` with the analysis pair.
 *
 * BullMQ repeatable jobs rather than `setInterval` or an ECS scheduled task:
 * they survive restarts, deduplicate across replicas, and are visible in the
 * bull-board already running in `infra/docker/`. Redis is already a dependency,
 * so this adds no infrastructure (spec §4a).
 */

export const POLL_QUEUE = 'corpus-poll';

export const POLL_JOB = {
  poll: 'corpus.poll',
  sweep: 'corpus.sweep',
  readiness: 'corpus.readiness',
} as const;

export type PollJobName = (typeof POLL_JOB)[keyof typeof POLL_JOB];

/**
 * UTC cron expressions.
 *
 * The sweep runs an hour AFTER the poll so a row the poll just refreshed is
 * never swept in the same night — the two would otherwise race on
 * `textRefreshedAt` and null text the poller had just re-read.
 */
export const SCHEDULES = {
  poll: '0 3 * * *',
  sweep: '0 4 * * *',
  readiness: '0 5 * * 1',
} as const;
```

- [ ] **Step 4: Implement the job handlers**

`apps/poller/src/jobs.ts`:

```ts
import { UnrecoverableError, type Job } from 'bullmq';
import { z } from 'zod';

import { buildReadiness, renderReadiness } from './readiness.ts';
import { createYouTubeClient } from './youtube.ts';
import { pollChannel, POSTS_PER_CHANNEL } from './poll.ts';
import { prismaStore } from './store.ts';
import { prismaSweepStore, sweepText } from './sweep.ts';
import { readMaturation } from './maturation.ts';
import { loadSeeds } from './seeds.ts';
import { POLL_JOB } from './queues.ts';

/**
 * What each scheduled job does.
 *
 * **Where `runAt` comes from.** Every snapshot a run appends is stamped with
 * it, and `@@unique([postId, capturedAt])` is what makes an at-least-once retry
 * a no-op — so a retry has to compute the SAME `runAt` as the attempt it is
 * retrying.
 *
 * It is therefore quantised to the UTC day rather than read raw from the clock,
 * and deliberately NOT carried on the repeatable job's payload. BullMQ's
 * `upsertJobScheduler` uses the template's `data` verbatim for every occurrence
 * it materialises — the scheduled slot lands in `opts.prevMillis` and in the
 * generated job id, never in `data` — so a timestamp baked into the template at
 * registration would freeze, every snapshot after the first would collide on
 * the unique key and be skipped, and the poller would report success while
 * writing nothing.
 *
 * An explicit `runAt` is still honoured, for backfilling one specific day by
 * hand.
 */

export const pollJobDataSchema = z.object({ runAt: z.iso.datetime().nullish() });
export type PollJobData = z.infer<typeof pollJobDataSchema>;

/** Midnight UTC of `moment`'s day. Idempotent. */
export function utcDayStart(moment: Date): Date {
  return new Date(Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), moment.getUTCDate()));
}

/**
 * The run's timestamp: the payload's if it carries one, else today's UTC day.
 *
 * A retry runs within minutes of its original against a 24-hour bucket, so the
 * day boundary is never in play at the 03:00 UTC schedule.
 */
export function resolveRunAt(data: unknown, now: Date = new Date()): Date {
  const { runAt } = pollJobDataSchema.parse(data ?? {});
  return runAt ? new Date(runAt) : utcDayStart(now);
}

export async function runPoll(data: unknown): Promise<void> {
  const at = resolveRunAt(data);
  const seeds = await loadSeeds();
  const youtube = createYouTubeClient();
  const store = prismaStore();

  let snapshots = 0;
  for (const seed of seeds) {
    // One channel's failure must not cost the other 39 their observation for
    // the day — a hole in a time series cannot be backfilled.
    try {
      const outcome = await pollChannel({
        seed,
        youtube,
        store,
        runAt: at,
        postsPerChannel: POSTS_PER_CHANNEL,
      });
      snapshots += outcome.snapshotsWritten;
      if (outcome.skipped) console.warn(`[poll] ${seed.id} skipped: ${outcome.skipped}`);
    } catch (error) {
      console.error(`[poll] ${seed.id} failed:`, error);
    }
  }

  console.log(
    `[poll] ${at.toISOString()} — ${seeds.length} channels, ${snapshots} snapshots appended`,
  );
}

export async function runSweep(data: unknown): Promise<void> {
  // The sweep's cutoff is a 30-day window, so the day bucket is precise enough
  // and keeps a retry from nulling a different set than the attempt it retries.
  const result = await sweepText({ now: resolveRunAt(data), store: prismaSweepStore() });
  console.log(`[sweep] nulled text on ${result.posts} posts, ${result.channels} channels`);
}

export async function runReadiness(data: unknown): Promise<void> {
  const now = resolveRunAt(data);
  const maturation = await readMaturation();
  const readiness = await buildReadiness({ now, maturation });
  const markdown = renderReadiness(readiness);

  const dir = process.env.CORPUS_REPORT_DIR ?? './out';
  const path = `${dir}/readiness-${now.toISOString().slice(0, 10)}.md`;
  await Bun.write(path, markdown);

  console.log(
    `[readiness] N=${maturation.nDays} (phase ${maturation.phase}) · ` +
      `${readiness.totals.clearingFloor}/${readiness.totals.channels} channels clear the post floor · ` +
      `${readiness.totals.ccbyClearingFloor} clear it in CC-BY · wrote ${path}`,
  );
}

export async function handlePollJob(job: Job<unknown>): Promise<void> {
  switch (job.name) {
    case POLL_JOB.poll:
      return runPoll(job.data);
    case POLL_JOB.sweep:
      return runSweep(job.data);
    case POLL_JOB.readiness:
      return runReadiness(job.data);
    default:
      throw new UnrecoverableError(`unknown poller job "${job.name}"`);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test apps/poller/src/jobs.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 6: Write the entrypoint**

`apps/poller/src/index.ts`:

```ts
import { Queue, Worker } from 'bullmq';
import { prismaService } from '@repo/db';
import { QUEUE_PREFIX, createRedisConnection, redisUrl } from '@repo/queue';

import { handlePollJob } from './jobs.ts';
import { POLL_JOB, POLL_QUEUE, SCHEDULES } from './queues.ts';
import { loadSeeds } from './seeds.ts';

/**
 * `@repo/poller` — the corpus collector.
 *
 * Its own process for two reasons (spec §4a). It writes `corpus` tables through
 * `prismaService`, the BYPASSRLS credential `apps/api` must never hold — the
 * same reasoning that made `apps/worker` a separate process rather than a
 * second entrypoint. And it has a different lifecycle from both: cron-shaped
 * rather than request- or queue-shaped, and it must keep running on a schedule
 * whether or not anyone is using the product.
 */

const connection = createRedisConnection();

const queue = new Queue(POLL_QUEUE, { connection, prefix: QUEUE_PREFIX });

/**
 * Register the repeatable jobs.
 *
 * `jobId` is fixed per schedule so a restart re-registers rather than adding a
 * second scheduler — the failure mode that turns a daily poll into two daily
 * polls, each appending a snapshot the other's unique key then rejects.
 */
async function schedule(): Promise<void> {
  for (const [name, pattern] of [
    [POLL_JOB.poll, SCHEDULES.poll],
    [POLL_JOB.sweep, SCHEDULES.sweep],
    [POLL_JOB.readiness, SCHEDULES.readiness],
  ] as const) {
    await queue.upsertJobScheduler(
      name,
      { pattern, tz: 'UTC' },
      {
        name,
        // No `runAt` here, deliberately. BullMQ reuses this template's `data`
        // verbatim for every occurrence — the scheduled slot goes into
        // `opts.prevMillis` and the job id, never into `data` — so a timestamp
        // baked in at registration would freeze and every later snapshot would
        // collide on `@@unique([postId, capturedAt])` and be skipped silently.
        // `resolveRunAt` derives it per run instead. See `jobs.ts`.
        data: {},
        opts: { attempts: 3, backoff: { type: 'exponential', delay: 60_000 } },
      },
    );
  }
}

const worker = new Worker(POLL_QUEUE, handlePollJob, {
  connection,
  prefix: QUEUE_PREFIX,
  // One at a time. These jobs walk the whole frame and hold a YouTube quota
  // budget; two concurrent polls would double the request rate for no gain.
  concurrency: 1,
  // A full poll of ~40 channels is minutes of sequential HTTP.
  lockDuration: 30 * 60 * 1000,
  removeOnComplete: { age: 30 * 24 * 3_600, count: 200 },
  removeOnFail: { age: 30 * 24 * 3_600 },
});

worker.on('failed', (job, error) => {
  console.error(`[poller] ${job?.name ?? 'job'} ${job?.id ?? '?'} failed:`, error.message);
});

worker.on('error', (error) => {
  console.error('[poller] worker error:', error);
});

// Fail at boot, loudly, rather than polling an empty frame in silence. A poller
// that runs against `channels: []` looks healthy in every dashboard and
// collects nothing.
const seeds = await loadSeeds();
await schedule();

console.log(
  `📡 resonance-poller — ${seeds.length} seeded channels, ` +
    `consuming "${QUEUE_PREFIX}:${POLL_QUEUE}" on ${redisUrl()}`,
);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`\n[poller] ${signal} — draining…`);
  try {
    await worker.close();
    await queue.close();
    await prismaService.$disconnect();
    await connection.quit();
  } catch (error) {
    console.error('[poller] unclean shutdown:', error);
    process.exitCode = 1;
  }
  process.exit();
}

function onSignal(signal: NodeJS.Signals): void {
  shutdown(signal).catch((error: unknown) => {
    console.error('[poller] shutdown failed:', error);
    process.exit(1);
  });
}

process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
```

- [ ] **Step 7: Show the queues in bull-board**

In `infra/docker/docker-compose.yml`, change the `BULL_QUEUES` line to:

```yaml
BULL_QUEUES: analysis,analysis-results,corpus-poll,corpus,corpus-results
```

- [ ] **Step 8: Write the README**

`apps/poller/README.md`:

````markdown
# @repo/poller — the corpus collector

Builds a corpus of public YouTube Shorts (≤30 s) with their engagement metrics
over time, in the isolated `corpus` Postgres schema, so the shipped resonance
composite can be ranked against real outcomes.

Design: [`docs/superpowers/specs/2026-08-12-youtube-corpus-poller-design.md`](../../docs/superpowers/specs/2026-08-12-youtube-corpus-poller-design.md).

**This is not the pre-registered experiment.** The prereg locks
`averageViewPercentage`, which comes from the YouTube _Analytics_ API and is
available only to a channel owner — no public poller can obtain it. This corpus
runs a different analysis against a different label, writes to its own output
directory, and its report is titled a secondary exploratory analysis.

- Sayable: "we backtested the shipped ranking on N historical Shorts;
  within-creator ρ = X."
- Not sayable: "validated per our pre-registration."

## Run it

```bash
cp .env.example .env      # YOUTUBE_API_KEY + APP_SERVICE_DATABASE_URL
bun run docker:local      # Redis, from the repo root
bun run dev               # registers the repeatable jobs and consumes them
```

The poller **refuses to start** until `seeds/channels.yaml` has been curated —
see that file's header for the criteria. A poller running against an empty frame
looks healthy in every dashboard and collects nothing.

## What runs when (UTC)

| Job                | Schedule    | What it does                                    |
| ------------------ | ----------- | ----------------------------------------------- |
| `corpus.poll`      | `0 3 * * *` | traverse every seeded channel, append snapshots |
| `corpus.sweep`     | `0 4 * * *` | null text older than 30 days (a backstop)       |
| `corpus.readiness` | `0 5 * * 1` | write `$CORPUS_REPORT_DIR/readiness-<date>.md`  |

The sweep runs _after_ the poll so a row the poll just refreshed is never swept
the same night.

## The two things most likely to be got wrong

**Snapshots are appended, never updated, and `capturedAt` is the run's UTC day.**
`@@unique([postId, capturedAt])` is what makes an at-least-once retry a no-op,
and that only holds if the retry computes the same key — so `capturedAt` comes
from `resolveRunAt`, not from the instant a handler happens to run. It is
deliberately not carried on the repeatable job's payload either: BullMQ reuses a
scheduler template's `data` verbatim, so a timestamp baked in there would freeze
and every snapshot after the first would be silently skipped as a duplicate.

**Exclusions are per-outcome, and almost none of them happen here.** Ingest
applies the frame's definition only: public, dated, ≤30 s. The maturation floor,
hidden likes and the secondary outcome's denominator floor are applied at
_extract_ time in `research/`, because a view-count filter applied to a views
label is selection on the outcome variable.

## Tests

```bash
bun test          # hermetic; no live YouTube calls anywhere in the suite
```
````

- [ ] **Step 9: Update the repo map**

In `CLAUDE.md`, in the Layout block, change the `apps/` line to include the poller:

```
apps/    mobile (Expo RN) · web (Next.js, later) · api (Bun+Hono BFF) · ml (Python FastAPI + BullMQ worker) · worker (Bun, results → Postgres) · poller (Bun, YouTube corpus → corpus schema)
```

and add to the Commands block, under the analysis-path section:

```bash
cd apps/poller && bun run dev        # the corpus poller (needs a curated seeds/channels.yaml)
```

- [ ] **Step 10: Verify the whole app**

Run: `bun test apps/poller && bun run typecheck && bun run lint`
Expected: all poller tests pass, monorepo typechecks and lints clean.

- [ ] **Step 11: Commit**

```bash
git add apps/poller infra/docker/docker-compose.yml CLAUDE.md
git commit -m "feat(poller): scheduler entrypoint, repeatable jobs and docs"
```

---

> **Collection is live from here.** Tasks 1–13 are the half with a clock on it:
> the maturation parameter needs ~14 days of observations before any label
> exists, so deploy and curate the frame before starting Task 14. Everything
> below is inert until §7's source-file question is decided — it is built now so
> the seam stays honest, not because it produces a number today.

---

## Task 14: The `[corpus]` / `[corpus-results]` contract

**Files:**

- Modify: `packages/queue/src/contract.ts:196-235` (extract `statsSchema`, then append the corpus section), `packages/queue/src/index.ts`
- Create: `packages/queue/src/corpus-contract.test.ts`, `packages/queue/src/__fixtures__/corpus-succeeded.json`

**Interfaces:**

- Consumes: `modalitySchema`, `timelineSchema`, `axisBandsSchema`, `transcriptEntrySchema` (same file).
- Produces: `CORPUS_QUEUE = 'corpus'`, `CORPUS_RESULTS_QUEUE = 'corpus-results'`, `CORPUS_JOB = 'corpus.score'`, `CORPUS_RESULT_JOB = { succeeded: 'corpus.succeeded', failed: 'corpus.failed' }`, `statsSchema`, `corpusJobSchema` / `CorpusJob`, `corpusSucceededSchema` / `CorpusSucceeded`, `corpusFailedSchema` / `CorpusFailed`.

The corpus path **mirrors** the analysis path rather than borrowing from it: `[corpus]` in, `[corpus-results]` out, persisted by `apps/poller`. Because corpus results land in `corpus.scores` rather than `analysis_results`, `apps/worker` needs no changes at all (§4b).

Two deliberate asymmetries with the analysis contract, both of which would be bugs if copied blindly:

- **There is no `corpus.started`.** No creator is watching a status column, and there is no `analyses` row to walk from QUEUED to PROCESSING — a started event would write nothing.
- **`axisBands` is REQUIRED here, not `.nullish()`.** The whole purpose of a corpus row is its composite; a score with no bands is a row that can never be ranked, so it should fail at the boundary rather than land as a null the extract has to filter later.

- [ ] **Step 1: Write the failing test**

`packages/queue/src/corpus-contract.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import fixture from './__fixtures__/corpus-succeeded.json';
import { corpusJobSchema, corpusSucceededSchema } from './contract.ts';

/**
 * The poller↔ml boundary, checked from the TypeScript side.
 *
 * `__fixtures__/corpus-succeeded.json` is produced by **Pydantic**
 * (`apps/ml/tests/test_corpus_contract.py` regenerates and diffs it), so this
 * is a real cross-language round trip — the same posture as the analysis pair,
 * for the same reason: the two halves are mirrored by hand and nothing but a
 * test notices when one moves.
 */
describe('corpus.succeeded — the Pydantic payload', () => {
  test('parses as emitted by apps/ml', () => {
    const parsed = corpusSucceededSchema.parse(fixture);
    expect(parsed.corpusPostId).toBe(fixture.corpusPostId);
    expect(parsed.timeline.startSec).toHaveLength(3);
  });

  test('requires the axis bands', () => {
    // Unlike the analysis contract, where a worker deployed ahead of the ml
    // image must not reject every job. A corpus score exists ONLY to produce a
    // composite, so bands that never arrived make the row worthless — fail at
    // the boundary rather than write a null the extract has to filter.
    const { axisBands: _dropped, ...withoutBands } = fixture;
    expect(() => corpusSucceededSchema.parse(withoutBands)).toThrow();
    expect(() => corpusSucceededSchema.parse({ ...fixture, axisBands: null })).toThrow();
  });

  test('accepts null for the fields Pydantic leaves unset', () => {
    const parsed = corpusSucceededSchema.parse({
      ...fixture,
      durationSec: null,
      transcript: null,
      device: null,
    });
    expect(parsed.transcript).toBeNull();
  });

  test('carries no analysisId and no workspaceId', () => {
    // A corpus row has no tenant. If either of these ever appears here, the
    // isolation in §3 has been breached somewhere upstream.
    expect(Object.keys(fixture)).not.toContain('analysisId');
    expect(Object.keys(fixture)).not.toContain('workspaceId');
  });
});

describe('the corpus job', () => {
  test('carries the post, the clip and where to fetch the bytes', () => {
    const job = corpusJobSchema.parse({
      corpusPostId: '0199a1f2-3b4c-7d5e-8f90-1a2b3c4d5e6f',
      clipId: '0199a1f2-3b4c-7d5e-8f90-1a2b3c4d5e70',
      modality: 'video',
      media: { url: 'https://example.test/clip.mp4' },
    });
    expect(job.clipId).toBeString();
  });

  test('rejects a job with no clip — there is nothing to infer over', () => {
    expect(() =>
      corpusJobSchema.parse({
        corpusPostId: '0199a1f2-3b4c-7d5e-8f90-1a2b3c4d5e6f',
        modality: 'video',
        media: { url: 'https://example.test/clip.mp4' },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/queue/src/corpus-contract.test.ts`
Expected: FAIL — the fixture and the schemas do not exist.

- [ ] **Step 3: Extract `statsSchema`**

In `packages/queue/src/contract.ts`, replace the inline `stats` object inside `analysisSucceededSchema` with a named schema declared just above it:

```ts
/**
 * Dev telemetry only — lands in `analysis_results.raw_stats`, never rendered
 * to a creator. `globalMean` is near zero by construction (the model predicts
 * z-scored fMRI), so it measures nothing about the content.
 *
 * Named rather than inline because the corpus contract carries the identical
 * block: one definition means one place to change when the model reports
 * something new.
 */
export const statsSchema = z.object({
  globalMean: z.number(),
  globalStd: z.number(),
  globalMin: z.number(),
  globalMax: z.number(),
  nTimesteps: z.int().min(0),
  nVertices: z.int().min(0),
});
export type Stats = z.infer<typeof statsSchema>;
```

and in `analysisSucceededSchema`, replace the inline `stats: z.object({ … })` with `stats: statsSchema`.

- [ ] **Step 4: Append the corpus contract**

At the end of `packages/queue/src/contract.ts`:

````ts
// ─── poller → ml → poller (the research corpus) ──────────────────────────────

/**
 * A symmetric second pair, mirroring the analysis path rather than borrowing
 * from it: `[corpus]` in, `[corpus-results]` out, persisted by `apps/poller`.
 *
 * ```text
 *   apps/poller ──add──▶ [corpus] ──▶ apps/ml ──▶ [corpus-results] ──▶ apps/poller
 *                                    same engine.py                        │
 *                                                                          ▼
 *                                                                   corpus.scores
 * ```
 *
 * Two queues rather than reusing `analysis`, because corpus results land in
 * `corpus.scores` rather than `analysis_results` — so `apps/worker` needs no
 * changes at all, and a corpus backfill cannot starve or delay a customer job
 * in the queue.
 *
 * **The one thing that must stay shared is `engine.py`.** A separate queue is
 * not a separate inference path. If corpus features were computed by different
 * code than product features, the backtest would silently stop describing the
 * product, and no test would catch it. `apps/ml` consumes both queues and routes
 * both to the same engine; only the payload and result contracts differ.
 *
 * Corpus jobs skip the Anthropic insights step — recommendations are
 * creator-facing output, and 1,600 of them is spend on text nobody reads. That
 * is enforced by `apps/poller` simply never calling it; there is no field here
 * to turn it off, because there is no path that would turn it on.
 */

/** poller → ml. One job per acquired clip. */
export const CORPUS_QUEUE = 'corpus';

/** ml → poller. Outcome of the job above. */
export const CORPUS_RESULTS_QUEUE = 'corpus-results';

/** The only job name on {@link CORPUS_QUEUE}. */
export const CORPUS_JOB = 'corpus.score';

/**
 * Job names on {@link CORPUS_RESULTS_QUEUE}.
 *
 * There is no `started`, deliberately: no creator is watching a status column
 * and there is no row to walk from QUEUED to PROCESSING, so the event would
 * write nothing.
 */
export const CORPUS_RESULT_JOB = {
  succeeded: 'corpus.succeeded',
  failed: 'corpus.failed',
} as const;

export type CorpusResultJobName = (typeof CORPUS_RESULT_JOB)[keyof typeof CORPUS_RESULT_JOB];

export const corpusJobSchema = z.object({
  /** `corpus.posts.id`. */
  corpusPostId: z.uuid(),
  /** `corpus.clips.id` — a corpus job without an acquired clip has nothing to run. */
  clipId: z.uuid(),
  modality: modalitySchema,
  media: z.object({
    /** Short-lived signed URL to the clip in the private bucket. */
    url: z.url(),
  }),
});
export type CorpusJob = z.infer<typeof corpusJobSchema>;

/** Fields every corpus outcome carries. No workspace and no analysis — there is no tenant. */
const corpusRunIdentity = {
  corpusPostId: z.uuid(),
  clipId: z.uuid(),
  attempt: z.int().min(1),
  queueJobId: z.string(),
  device: z.string().nullish(),
};

export const corpusSucceededSchema = z.object({
  ...corpusRunIdentity,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  durationMs: z.int().min(0),
  timeline: timelineSchema,
  durationSec: z.number().min(0).nullish(),
  transcript: z.array(transcriptEntrySchema).nullish(),
  /**
   * REQUIRED here, unlike `analysisSucceededSchema`.
   *
   * A corpus row exists only to yield a composite, which is a reduction over
   * these bands — so a score without them is a row that can never be ranked.
   * Rejecting it at the boundary is better than writing a null the extract
   * would have to filter, silently shrinking N for a reason nobody recorded.
   */
  axisBands: axisBandsSchema,
  stats: statsSchema,
});
export type CorpusSucceeded = z.infer<typeof corpusSucceededSchema>;

export const corpusFailedSchema = z.object({
  ...corpusRunIdentity,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  error: z.string(),
  retryable: z.boolean(),
});
export type CorpusFailed = z.infer<typeof corpusFailedSchema>;
````

- [ ] **Step 5: Export them**

In `packages/queue/src/index.ts`, add to the value export block:

```ts
  statsSchema,
  CORPUS_QUEUE,
  CORPUS_RESULTS_QUEUE,
  CORPUS_JOB,
  CORPUS_RESULT_JOB,
  corpusJobSchema,
  corpusSucceededSchema,
  corpusFailedSchema,
```

and to the type export block:

```ts
  Stats,
  CorpusResultJobName,
  CorpusJob,
  CorpusSucceeded,
  CorpusFailed,
```

- [ ] **Step 6: Write the fixture**

`packages/queue/src/__fixtures__/corpus-succeeded.json` — hand-written now, and regenerated from Pydantic in Task 15 so it is genuinely a cross-language artifact:

```json
{
  "corpusPostId": "0199b2f3-4c5d-7e6f-8a01-2b3c4d5e6f70",
  "clipId": "0199b2f3-4c5d-7e6f-8a01-2b3c4d5e6f71",
  "attempt": 1,
  "queueJobId": "0199b2f3-4c5d-7e6f-8a01-2b3c4d5e6f70:1",
  "device": "cuda",
  "startedAt": "2026-09-01T10:00:00.000Z",
  "finishedAt": "2026-09-01T10:00:31.000Z",
  "durationMs": 31000,
  "timeline": {
    "startSec": [0.0, 1.49, 2.98],
    "attention": [0.014, -0.002, 0.028],
    "visual": [0.24, -0.06, 0.41],
    "audio": [0.04, 0.13, -0.03],
    "language": [-0.11, 0.03, 0.07]
  },
  "durationSec": 4.47,
  "transcript": [
    { "startSec": 0.0, "text": "watch what happens" },
    { "startSec": 1.49, "text": "" },
    { "startSec": 2.98, "text": "every time" }
  ],
  "axisBands": {
    "visual": { "mean": 0.02, "std": 0.19, "peak": 0.41 },
    "audio": { "mean": 0.01, "std": 0.08, "peak": 0.13 },
    "language": { "mean": -0.01, "std": 0.07, "peak": 0.07 },
    "emotional": { "mean": 0.0, "std": 0.05, "peak": 0.09 },
    "memorability": { "mean": 0.01, "std": 0.06, "peak": 0.12 }
  },
  "stats": {
    "globalMean": 0.001,
    "globalStd": 0.42,
    "globalMin": -1.8,
    "globalMax": 2.1,
    "nTimesteps": 3,
    "nVertices": 20484
  }
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test packages/queue`
Expected: PASS — the new corpus suite plus the existing `contract.test.ts`, which must be unaffected by the `statsSchema` extraction.

- [ ] **Step 8: Commit**

```bash
git add packages/queue/src
git commit -m "feat(queue): the [corpus]/[corpus-results] contract"
```

---

## Task 15: `apps/ml` consumes both queues, through one engine

**Files:**

- Modify: `apps/ml/queue_contract.py` (append the corpus mirror), `apps/ml/worker.py:244-431`
- Create: `apps/ml/tests/test_corpus_contract.py`, `apps/ml/tests/test_corpus_processor.py`
- Modify: `apps/ml/README.md`

**Interfaces:**

- Consumes: Task 14's TS contract (mirrored), `engine.run_inference` / `engine.predictions_to_dict`.
- Produces: `CORPUS_QUEUE`, `CORPUS_RESULTS_QUEUE`, `CORPUS_JOB`, `CORPUS_RESULT_JOB_SUCCEEDED`, `CORPUS_RESULT_JOB_FAILED`, `CorpusJob`, `CorpusSucceeded`, `CorpusFailed` in `queue_contract.py`; `CorpusProcessor`, `_infer(modality, url, gpu)` in `worker.py`; env `ML_QUEUES` (default `analysis,corpus`).

- [ ] **Step 1: Mirror the contract in Python**

Append to `apps/ml/queue_contract.py`:

```python
# ── poller → ml → poller (the research corpus) ───────────────────────────────
#
# A symmetric second pair. Mirrors the corpus section of
# `packages/queue/src/contract.ts` by hand — change one, change the other.
#
# Two asymmetries with the analysis pair above, both intentional:
#   * there is no `corpus.started` — nothing is watching a status column;
#   * `axisBands` is REQUIRED, because a corpus row exists only to yield a
#     composite and one without bands can never be ranked.

CORPUS_QUEUE = "corpus"
CORPUS_RESULTS_QUEUE = "corpus-results"

CORPUS_JOB = "corpus.score"

CORPUS_RESULT_JOB_SUCCEEDED = "corpus.succeeded"
CORPUS_RESULT_JOB_FAILED = "corpus.failed"


class CorpusMedia(BaseModel):
    model_config = ConfigDict(extra="ignore")

    url: str


class CorpusJob(BaseModel):
    """Payload of a `corpus.score` job on the `corpus` queue."""

    model_config = ConfigDict(extra="ignore")

    corpusPostId: str
    clipId: str
    modality: Literal["video", "audio"]
    media: CorpusMedia


class CorpusSucceeded(BaseModel):
    model_config = ConfigDict(extra="ignore")

    corpusPostId: str
    clipId: str
    attempt: int = Field(ge=1)
    queueJobId: str
    device: Optional[str] = None
    startedAt: str
    finishedAt: str
    durationMs: int = Field(ge=0)
    timeline: Timeline
    durationSec: Optional[float] = Field(default=None, ge=0)
    transcript: Optional[list[TranscriptEntry]] = None
    #: Required, not Optional — see the module note above.
    axisBands: AxisBands
    stats: Stats


class CorpusFailed(BaseModel):
    model_config = ConfigDict(extra="ignore")

    corpusPostId: str
    clipId: str
    attempt: int = Field(ge=1)
    queueJobId: str
    device: Optional[str] = None
    startedAt: str
    finishedAt: str
    error: str
    retryable: bool
```

- [ ] **Step 2: Write the failing contract test**

`apps/ml/tests/test_corpus_contract.py`:

```python
"""The poller↔ml boundary, checked from the Python side.

Same shape as `test_contract.py`, for the same reason: the corpus half of
`packages/queue/src/contract.ts` and of `queue_contract.py` are mirrored by
hand, so nothing but a test notices when one side moves.

Regenerate after an intentional contract change:

    pytest tests/test_corpus_contract.py --regenerate-fixture
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from queue_contract import CorpusSucceeded

FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "queue"
    / "src"
    / "__fixtures__"
    / "corpus-succeeded.json"
)


@pytest.fixture(scope="module")
def payload() -> dict:
    assert FIXTURE.exists(), f"corpus contract fixture missing at {FIXTURE}"
    return json.loads(FIXTURE.read_text())


class TestCorpusSucceeded:
    def test_reproduces_the_fixture_field_for_field(self, payload, request):
        rebuilt = CorpusSucceeded(**payload).model_dump(mode="json")

        if request.config.getoption("--regenerate-fixture", default=False):
            FIXTURE.write_text(json.dumps(rebuilt, indent=2) + "\n")
            pytest.skip("fixture regenerated")

        assert rebuilt == payload, (
            "queue_contract.py no longer reproduces the shared corpus fixture. If the "
            "contract changed on purpose, change packages/queue/src/contract.ts too and "
            "rerun with --regenerate-fixture."
        )

    def test_axis_bands_are_required(self, payload):
        # A corpus score exists only to yield a composite. One without bands is
        # a row that can never be ranked, so it must not serialise at all.
        without = {k: v for k, v in payload.items() if k != "axisBands"}
        with pytest.raises(Exception):
            CorpusSucceeded(**without)

    def test_carries_no_tenant(self, payload):
        # A corpus row has no workspace. If either key appears here the
        # isolation in spec §3 has been breached upstream.
        assert "workspaceId" not in payload
        assert "analysisId" not in payload

    def test_transcript_stays_row_aligned_with_the_curve(self, payload):
        parsed = CorpusSucceeded(**payload)
        assert parsed.transcript is not None
        assert [e.startSec for e in parsed.transcript] == parsed.timeline.startSec
```

- [ ] **Step 3: Run it to verify it passes against the hand-written fixture**

Run: `cd apps/ml && .venv/bin/python -m pytest tests/test_corpus_contract.py -v`
Expected: PASS. If `test_reproduces_the_fixture_field_for_field` fails, rerun with `--regenerate-fixture` and re-run `bun test packages/queue` — that round trip is the point of the fixture.

- [ ] **Step 4: Write the failing processor test**

`apps/ml/tests/test_corpus_processor.py`:

```python
"""The corpus processor routes to the SAME engine as the analysis one.

This is the test that keeps the backtest describing the product. A separate
queue is not a separate inference path (spec §4b): if corpus features were
computed by different code, nothing else here would notice.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

import worker
from queue_contract import CORPUS_RESULT_JOB_FAILED, CORPUS_RESULT_JOB_SUCCEEDED


class FakeQueue:
    def __init__(self):
        self.added = []

    async def add(self, name, payload, opts):
        self.added.append((name, payload, opts))


def fake_job(data, job_id="job-1", attempts=1):
    return SimpleNamespace(
        id=job_id, data=data, attemptsStarted=1, attemptsMade=0, opts={"attempts": attempts}
    )


JOB_DATA = {
    "corpusPostId": "0199b2f3-4c5d-7e6f-8a01-2b3c4d5e6f70",
    "clipId": "0199b2f3-4c5d-7e6f-8a01-2b3c4d5e6f71",
    "modality": "video",
    "media": {"url": "https://example.test/clip.mp4"},
}


@pytest.fixture
def stub_engine(monkeypatch, tmp_path):
    calls = []

    def run_inference(modality, path):
        calls.append((modality, path))
        return ("preds", "segments")

    monkeypatch.setattr(worker.engine, "run_inference", run_inference)
    monkeypatch.setattr(
        worker.engine,
        "predictions_to_dict",
        lambda preds, segments: {
            "mean_activation_per_timestep": [0.1, 0.2],
            "segments": [{"start": 0.0, "text": "a"}, {"start": 1.5, "text": ""}],
            "axis_timeline": {"visual": [0.1, 0.2], "audio": [0.0, 0.1], "language": [0.0, 0.0]},
            "axis_means": {
                axis: {"mean": 0.0, "std": 0.1, "peak": 0.2}
                for axis in ("visual", "audio", "language", "emotional", "memorability")
            },
            "stats": {"global_mean": 0.0, "global_std": 0.4, "global_min": -1.0, "global_max": 1.0},
            "n_timesteps": 2,
            "n_vertices": 20484,
            "duration_sec": 2.98,
            "shape": (2, 20484),
        },
    )
    monkeypatch.setattr(worker.engine, "device", lambda: "cpu")
    monkeypatch.setattr(
        worker, "_download", lambda url, directory, modality: tmp_path / "media.mp4"
    )
    return calls


def test_publishes_succeeded_with_bands(stub_engine):
    results = FakeQueue()
    processor = worker.CorpusProcessor(results, asyncio.Semaphore(1))

    asyncio.run(processor(fake_job(JOB_DATA), "token"))

    assert len(results.added) == 1
    name, payload, _ = results.added[0]
    assert name == CORPUS_RESULT_JOB_SUCCEEDED
    assert payload["corpusPostId"] == JOB_DATA["corpusPostId"]
    assert payload["clipId"] == JOB_DATA["clipId"]
    assert set(payload["axisBands"]) == {
        "visual",
        "audio",
        "language",
        "emotional",
        "memorability",
    }


def test_uses_the_same_engine_entry_point_as_an_analysis(stub_engine):
    results = FakeQueue()
    asyncio.run(worker.CorpusProcessor(results, asyncio.Semaphore(1))(fake_job(JOB_DATA), "t"))
    assert stub_engine == [("video", str(stub_engine[0][1]))] or stub_engine[0][0] == "video"


def test_publishes_no_started_event(stub_engine):
    results = FakeQueue()
    asyncio.run(worker.CorpusProcessor(results, asyncio.Semaphore(1))(fake_job(JOB_DATA), "t"))
    assert [name for name, _, _ in results.added] == [CORPUS_RESULT_JOB_SUCCEEDED]


def test_reports_failure_and_re_raises(monkeypatch, stub_engine):
    def boom(modality, path):
        raise RuntimeError("gpu fell over")

    monkeypatch.setattr(worker.engine, "run_inference", boom)
    results = FakeQueue()
    processor = worker.CorpusProcessor(results, asyncio.Semaphore(1))

    with pytest.raises(RuntimeError):
        asyncio.run(processor(fake_job(JOB_DATA, attempts=3), "t"))

    name, payload, _ = results.added[0]
    assert name == CORPUS_RESULT_JOB_FAILED
    # Attempt 1 of 3 — BullMQ will retry, so the poller must not mark it dead.
    assert payload["retryable"] is True
```

- [ ] **Step 5: Run it to verify it fails**

Run: `cd apps/ml && .venv/bin/python -m pytest tests/test_corpus_processor.py`
Expected: FAIL — `AttributeError: module 'worker' has no attribute 'CorpusProcessor'`

- [ ] **Step 6: Add the processor and the shared GPU semaphore**

In `apps/ml/worker.py`, add to the imports from `queue_contract`:

```python
    CORPUS_JOB,
    CORPUS_QUEUE,
    CORPUS_RESULTS_QUEUE,
    CORPUS_RESULT_JOB_FAILED,
    CORPUS_RESULT_JOB_SUCCEEDED,
    CorpusFailed,
    CorpusJob,
    CorpusSucceeded,
```

Add near the other env constants:

```python
# Which queues this instance serves. Both by default; a dedicated corpus
# backfill box runs with ML_QUEUES=corpus so 1,600 research clips never sit in
# front of a customer's upload on the same card. The queue split guarantees the
# two never share a RESULT table (spec §4b) — it cannot, on its own, stop them
# sharing a GPU, and pretending otherwise would be the kind of claim that is
# only discovered false under load.
QUEUES = [q.strip() for q in os.getenv("ML_QUEUES", "analysis,corpus").split(",") if q.strip()]
```

Add above `class AnalysisProcessor`:

```python
async def _infer(modality: str, url: str, gpu: asyncio.Semaphore) -> dict:
    """Download, run TRIBE, and reduce — the whole inference path, once.

    Shared verbatim by both processors. **This function is the reason a second
    queue is safe:** a separate queue is not a separate inference path, and if
    the corpus reduced its features through different code the backtest would
    stop describing the product with nothing to catch it.

    `gpu` is held across the model call only. Two Workers each at concurrency 1
    would otherwise put two TRIBE runs on one card, which is how you get an OOM
    halfway through both.
    """
    with tempfile.TemporaryDirectory(prefix="resonance-") as tmp_dir:
        media_path = await asyncio.to_thread(_download, url, Path(tmp_dir), modality)
        async with gpu:
            preds, segments = await asyncio.to_thread(
                engine.run_inference, modality, str(media_path)
            )
        return engine.predictions_to_dict(preds, segments)
```

Then add, after `AnalysisProcessor`:

```python
class CorpusProcessor:
    """`corpus` → `corpus-results`. Same engine, different contract.

    No `started` event: nothing is watching a status column, and there is no row
    to walk from QUEUED to PROCESSING. No insights step either — recommendations
    are creator-facing output, and 1,600 of them is spend on text nobody reads.
    """

    def __init__(self, results: Queue, gpu: asyncio.Semaphore):
        self.results = results
        self.gpu = gpu

    async def publish(self, name: str, payload, post_id: str, attempt: int) -> None:
        await self.results.add(
            name,
            payload.model_dump(exclude_none=True),
            {
                "jobId": f"{post_id}:{attempt}:{name}",
                "attempts": RESULT_ATTEMPTS,
                "backoff": {"type": "exponential", "delay": 1000},
            },
        )

    async def __call__(self, job, token: str):
        started_at = datetime.now(timezone.utc)
        attempt = job.attemptsStarted or (job.attemptsMade + 1)
        max_attempts = job.opts.get("attempts") or 1
        payload = CorpusJob(**job.data)

        logger.info(
            f"[corpus {payload.corpusPostId}] attempt {attempt}/{max_attempts} — "
            f"{payload.media.url}"
        )

        try:
            result = await _infer(payload.modality, payload.media.url, self.gpu)
        except Exception as exc:
            finished_at = datetime.now(timezone.utc)
            retryable = attempt < max_attempts and not isinstance(exc, UnrecoverableError)
            logger.error(
                f"[corpus {payload.corpusPostId}] attempt {attempt} failed: {exc}",
                exc_info=True,
            )
            await self.publish(
                CORPUS_RESULT_JOB_FAILED,
                CorpusFailed(
                    corpusPostId=payload.corpusPostId,
                    clipId=payload.clipId,
                    attempt=attempt,
                    queueJobId=str(job.id),
                    device=engine.device(),
                    startedAt=iso(started_at),
                    finishedAt=iso(finished_at),
                    error=f"{type(exc).__name__}: {exc}"[:2000],
                    retryable=retryable,
                ),
                payload.corpusPostId,
                attempt,
            )
            raise

        finished_at = datetime.now(timezone.utc)
        bands = _axis_bands(result)
        if bands is None:
            # The contract requires them, so producing the payload would fail
            # anyway — this raises with a message that says why instead.
            raise UnrecoverableError(
                f"[corpus {payload.corpusPostId}] parcellation produced no axis bands; "
                "a corpus score with no bands can never be ranked"
            )

        await self.publish(
            CORPUS_RESULT_JOB_SUCCEEDED,
            CorpusSucceeded(
                corpusPostId=payload.corpusPostId,
                clipId=payload.clipId,
                attempt=attempt,
                queueJobId=str(job.id),
                device=engine.device(),
                startedAt=iso(started_at),
                finishedAt=iso(finished_at),
                durationMs=int((finished_at - started_at).total_seconds() * 1000),
                timeline=_timeline(result),
                durationSec=float(result.get("duration_sec", 0.0)),
                transcript=_transcript(result),
                axisBands=bands,
                stats=_stats(result),
            ),
            payload.corpusPostId,
            attempt,
        )
        return {"corpusPostId": payload.corpusPostId, "attempt": attempt}
```

Refactor `AnalysisProcessor.__call__` to take the semaphore and call `_infer`: add `gpu: asyncio.Semaphore` to its `__init__`, store it, and replace the `try:` block's download/inference/reduce lines with:

```python
        try:
            result = await _infer(payload.modality, payload.media.url, self.gpu)
```

- [ ] **Step 7: Start both workers**

Replace the body of `main()` in `apps/ml/worker.py`:

```python
async def main() -> None:
    logger.info(f"Loading the model before consuming (device: {engine.device()})…")
    await asyncio.to_thread(engine.load_model)

    # One semaphore across BOTH workers. Concurrency here is GPU memory, not
    # I/O, and two Workers at concurrency 1 each is two TRIBE runs on one card.
    gpu = asyncio.Semaphore(CONCURRENCY)

    queues: list[Queue] = []
    workers: list[Worker] = []

    common = {"connection": REDIS_URL, "prefix": QUEUE_PREFIX, "lockDuration": LOCK_DURATION_MS}

    if "analysis" in QUEUES:
        results = Queue(ANALYSIS_RESULTS_QUEUE, {"connection": REDIS_URL, "prefix": QUEUE_PREFIX})
        queues.append(results)
        workers.append(
            Worker(ANALYSIS_QUEUE, AnalysisProcessor(results, gpu), {**common, "concurrency": CONCURRENCY})
        )

    if "corpus" in QUEUES:
        corpus_results = Queue(
            CORPUS_RESULTS_QUEUE, {"connection": REDIS_URL, "prefix": QUEUE_PREFIX}
        )
        queues.append(corpus_results)
        workers.append(
            Worker(CORPUS_QUEUE, CorpusProcessor(corpus_results, gpu), {**common, "concurrency": CONCURRENCY})
        )

    if not workers:
        raise SystemExit(f"ML_QUEUES={QUEUES!r} selects no queue to consume")

    logger.info(
        f"🧠 ml worker consuming {', '.join(f'{QUEUE_PREFIX}:{q}' for q in QUEUES)} on "
        f"{_redacted(REDIS_URL)} (gpu concurrency {CONCURRENCY})"
    )

    stop = asyncio.Future()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda: stop.done() or stop.set_result(None))

    await stop

    logger.info("Draining… (finishing the current job)")
    for w in workers:
        await w.close()
    for q in queues:
        await q.close()
```

- [ ] **Step 8: Run the whole ML suite**

Run: `cd apps/ml && .venv/bin/python -m pytest`
Expected: PASS — including the pre-existing `test_worker_processor.py`, which must still pass after `AnalysisProcessor` gained the semaphore argument. Update its construction call if it constructs the processor directly.

- [ ] **Step 9: Document it**

In `apps/ml/README.md`, add a short section under the worker docs:

````markdown
### Two queues, one engine

`worker.py` consumes `analysis` (from `apps/api`) and `corpus` (from
`apps/poller`), routing both through the same `engine.py`. That sharing is the
point: a separate queue is not a separate inference path, and if the research
corpus reduced its features through different code, the backtest would silently
stop describing the product.

```bash
python worker.py                    # both queues
ML_QUEUES=corpus python worker.py   # a dedicated corpus backfill box
```

The queue split keeps corpus results out of `analysis_results` entirely. It does
**not** stop the two sharing a GPU — one semaphore spans both workers — so run
a long backfill on its own instance rather than in front of customer uploads.
````

- [ ] **Step 10: Commit**

```bash
git add apps/ml
git commit -m "feat(ml): consume the corpus queue through the same engine"
```

---

## Task 16: The `SourceResolver` seam

**Files:**

- Create: `apps/poller/src/source-resolver.ts`, `apps/poller/src/source-resolver.test.ts`

**Interfaces:**

- Consumes: `CorpusJob` from `@repo/queue`.
- Produces:
  - `CorpusPostRef = { id: string; platformVideoId: string; durationSec: number; license: string | null }`
  - `ResolvedClip = { storageKey: string; checksumSha256: string; durationSec: number | null; acquisitionRoute: string; url: string }`
  - `SourceResolver = { resolve(post: CorpusPostRef): Promise<ResolvedClip | null> }`
  - `nullSourceResolver: SourceResolver`
  - `sourceResolver(name?: string): SourceResolver`
  - `ClipStore = { hasClip(postId: string): Promise<boolean>; recordClip(postId: string, clip: ResolvedClip): Promise<{ id: string }> }`
  - `prismaClipStore(db?): ClipStore`
  - `backfillClips(input: { posts: CorpusPostRef[]; resolver: SourceResolver; store: ClipStore; enqueue: (job: CorpusJob) => Promise<void> }): Promise<{ resolved: number; enqueued: number; skipped: number }>`

TRIBE needs the video file and the Data API does not provide one. The validation spec's §11a lists three routes — creator upload, capture-at-post-time, and scraping the published stream — and rules the third out for a diligence artifact. **This does not reverse that ruling; it defers it**, and `corpus.clips` stays empty until the decision is made deliberately. The pipeline is complete and testable without it.

- [ ] **Step 1: Write the failing test**

`apps/poller/src/source-resolver.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { CorpusJob } from '@repo/queue';

import {
  backfillClips,
  nullSourceResolver,
  sourceResolver,
  type ClipStore,
  type CorpusPostRef,
  type ResolvedClip,
  type SourceResolver,
} from './source-resolver.ts';

const post = (id: string, license: string | null = 'creativeCommon'): CorpusPostRef => ({
  id,
  platformVideoId: `vid-${id}`,
  durationSec: 20,
  license,
});

function fakeStore(existing: string[] = []) {
  const recorded: { postId: string; clip: ResolvedClip }[] = [];
  const store: ClipStore = {
    async hasClip(postId) {
      return existing.includes(postId);
    },
    async recordClip(postId, clip) {
      recorded.push({ postId, clip });
      return { id: `clip-${postId}` };
    },
  };
  return { store, recorded };
}

const resolving: SourceResolver = {
  async resolve(p) {
    return {
      storageKey: `corpus/${p.platformVideoId}.mp4`,
      checksumSha256: 'a'.repeat(64),
      durationSec: p.durationSec,
      acquisitionRoute: 'creator_upload',
      url: `https://storage.test/${p.platformVideoId}.mp4`,
    };
  },
};

describe('the default resolver', () => {
  test('resolves nothing, including for a Creative-Commons post', async () => {
    // A CC-BY licence resolves the COPYRIGHT question — the uploader has
    // granted reuse, including commercial, with attribution. It does NOT
    // resolve the ToS question: YouTube's terms still bar access by
    // unauthorised means. Those two halves are routinely conflated and are not
    // conflated here, which is why the default resolver returns nothing even
    // when the licence looks permissive.
    expect(await nullSourceResolver.resolve(post('a'))).toBeNull();
  });

  test('is what `sourceResolver()` selects today', () => {
    expect(sourceResolver()).toBe(nullSourceResolver);
    expect(sourceResolver('none')).toBe(nullSourceResolver);
  });

  test('refuses an unknown resolver rather than silently resolving nothing', () => {
    // Otherwise a typo in CORPUS_SOURCE_RESOLVER looks exactly like the
    // deferred state, and a backfill that acquires nothing looks healthy.
    expect(() => sourceResolver('creator-uploads')).toThrow(/unknown/i);
  });
});

describe('backfillClips', () => {
  test('enqueues nothing while the resolver resolves nothing', async () => {
    const { store, recorded } = fakeStore();
    const jobs: CorpusJob[] = [];
    const result = await backfillClips({
      posts: [post('a'), post('b')],
      resolver: nullSourceResolver,
      store,
      enqueue: async (job) => void jobs.push(job),
    });

    expect(result).toEqual({ resolved: 0, enqueued: 0, skipped: 0 });
    expect(recorded).toHaveLength(0);
    expect(jobs).toHaveLength(0);
  });

  test('records the clip before enqueueing, so the job always has a row to point at', async () => {
    const { store, recorded } = fakeStore();
    const jobs: CorpusJob[] = [];
    const result = await backfillClips({
      posts: [post('a')],
      resolver: resolving,
      store,
      enqueue: async (job) => void jobs.push(job),
    });

    expect(result).toEqual({ resolved: 1, enqueued: 1, skipped: 0 });
    expect(recorded[0]!.clip.acquisitionRoute).toBe('creator_upload');
    expect(jobs[0]).toEqual({
      corpusPostId: 'a',
      clipId: 'clip-a',
      modality: 'video',
      media: { url: 'https://storage.test/vid-a.mp4' },
    });
  });

  test('skips a post that already has a clip', async () => {
    // Re-running the backfill must not re-acquire, re-store and re-score a clip
    // — that is GPU spend on a number the corpus already holds.
    const { store, recorded } = fakeStore(['a']);
    const jobs: CorpusJob[] = [];
    const result = await backfillClips({
      posts: [post('a'), post('b')],
      resolver: resolving,
      store,
      enqueue: async (job) => void jobs.push(job),
    });

    expect(result).toEqual({ resolved: 1, enqueued: 1, skipped: 1 });
    expect(recorded.map((r) => r.postId)).toEqual(['b']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test apps/poller/src/source-resolver.test.ts`
Expected: FAIL — `Cannot find module './source-resolver.ts'`

- [ ] **Step 3: Implement it**

`apps/poller/src/source-resolver.ts`:

```ts
import { prismaService, type PrismaClient } from '@repo/db';
import type { CorpusJob } from '@repo/queue';

/**
 * The deferred half — source files (spec §7).
 *
 * TRIBE needs the video file, and the Data API does not provide one. The
 * validation spec's §11a lists three routes — creator upload,
 * capture-at-post-time, and scraping the published stream — and rules the third
 * out for a diligence artifact. **This module does not reverse that ruling; it
 * defers it**, behind one interface with one method, and `corpus.clips` stays
 * empty until the decision is made deliberately.
 *
 * What makes the deferral nearly free is one column. `videos.list?part=status`
 * returns `status.license` at no extra quota on the call already being made, so
 * after two weeks of polling "do enough channels have >=20 Creative-Commons
 * clips under 30 s?" is a SQL query against the corpus rather than a separate
 * research exercise — and whichever route is eventually chosen, no re-crawl is
 * needed. The weekly readiness report puts that number in front of somebody
 * every Monday.
 *
 * For the record, so the eventual decision is made on facts: a CC-BY licence
 * resolves the **copyright** question (the uploader has granted reuse,
 * including commercial, with attribution) and does **not** resolve the **ToS**
 * question (YouTube's terms still bar access by unauthorised means; the
 * realistic exposure is API-project termination rather than litigation). Those
 * two halves are routinely conflated and are not conflated here — which is why
 * the default resolver returns nothing even for a post whose licence looks
 * permissive.
 */

export interface CorpusPostRef {
  id: string;
  platformVideoId: string;
  durationSec: number;
  license: string | null;
}

export interface ResolvedClip {
  storageKey: string;
  checksumSha256: string;
  durationSec: number | null;
  /** `creator_upload` | `capture_at_post_time` | … — recorded per clip, because
   *  the routes carry different licence and ToS positions. */
  acquisitionRoute: string;
  /** Where `apps/ml` fetches the bytes. Short-lived. */
  url: string;
}

export interface SourceResolver {
  resolve(post: CorpusPostRef): Promise<ResolvedClip | null>;
}

/** The only implementation today. Resolves nothing, on purpose. */
export const nullSourceResolver: SourceResolver = {
  async resolve() {
    return null;
  },
};

const RESOLVERS: Record<string, SourceResolver> = {
  none: nullSourceResolver,
};

export function sourceResolver(
  name: string = process.env.CORPUS_SOURCE_RESOLVER ?? 'none',
): SourceResolver {
  const resolver = RESOLVERS[name];
  if (!resolver) {
    // Not a silent fallback to `none`: a typo would then look identical to the
    // deferred state, and a backfill that acquires nothing would look healthy.
    throw new Error(`unknown CORPUS_SOURCE_RESOLVER "${name}" — known: ${Object.keys(RESOLVERS)}`);
  }
  return resolver;
}

export interface ClipStore {
  hasClip(postId: string): Promise<boolean>;
  recordClip(postId: string, clip: ResolvedClip): Promise<{ id: string }>;
}

export function prismaClipStore(db: PrismaClient = prismaService): ClipStore {
  return {
    async hasClip(postId) {
      return (await db.corpusClip.count({ where: { postId } })) > 0;
    },
    async recordClip(postId, clip) {
      return db.corpusClip.upsert({
        where: { postId },
        create: {
          postId,
          storageKey: clip.storageKey,
          checksumSha256: clip.checksumSha256,
          durationSec: clip.durationSec,
          acquisitionRoute: clip.acquisitionRoute,
        },
        update: {
          storageKey: clip.storageKey,
          checksumSha256: clip.checksumSha256,
          durationSec: clip.durationSec,
          acquisitionRoute: clip.acquisitionRoute,
        },
        select: { id: true },
      });
    },
  };
}

/**
 * Acquire what can be acquired and queue it for scoring.
 *
 * The clip row is written BEFORE the job is enqueued so a job never references
 * a clip that does not exist. The reverse order would leave `apps/ml` running
 * inference whose result `apps/poller` then cannot attach to anything.
 */
export async function backfillClips(input: {
  posts: CorpusPostRef[];
  resolver: SourceResolver;
  store: ClipStore;
  enqueue: (job: CorpusJob) => Promise<void>;
}): Promise<{ resolved: number; enqueued: number; skipped: number }> {
  let resolved = 0;
  let enqueued = 0;
  let skipped = 0;

  for (const post of input.posts) {
    if (await input.store.hasClip(post.id)) {
      skipped += 1;
      continue;
    }

    const clip = await input.resolver.resolve(post);
    if (!clip) continue;
    resolved += 1;

    const row = await input.store.recordClip(post.id, clip);
    await input.enqueue({
      corpusPostId: post.id,
      clipId: row.id,
      modality: 'video',
      media: { url: clip.url },
    });
    enqueued += 1;
  }

  return { resolved, enqueued, skipped };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/poller/src/source-resolver.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add apps/poller/src/source-resolver.ts apps/poller/src/source-resolver.test.ts
git commit -m "feat(poller): the SourceResolver seam, resolving nothing by design"
```

---

## Task 17: Persist corpus scores

**Files:**

- Create: `apps/poller/src/scores.ts`, `apps/poller/src/scores.test.ts`
- Modify: `apps/poller/src/index.ts` (add the second worker)

**Interfaces:**

- Consumes: `CORPUS_RESULT_JOB`, `corpusSucceededSchema`, `corpusFailedSchema`, `CorpusSucceeded` from `@repo/queue`; `composite` from `@repo/scoring`.
- Produces: `ScoreRow` (the `corpus.scores` insert shape), `scoreRow(result: CorpusSucceeded): ScoreRow`, `handleCorpusResult(job: Job<unknown>): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`apps/poller/src/scores.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { composite } from '@repo/scoring';
import { corpusSucceededSchema } from '@repo/queue';

import fixture from '../../../packages/queue/src/__fixtures__/corpus-succeeded.json';
import { scoreRow } from './scores.ts';

const result = corpusSucceededSchema.parse(fixture);

describe('scoreRow', () => {
  test('computes the composite with the SAME function the product ships', () => {
    // Not a re-implementation and not a copied constant: `@repo/scoring` is
    // imported by `apps/worker` too. If corpus features were reduced by
    // different code, the backtest would stop describing the product and
    // nothing else here would notice.
    expect(scoreRow(result).composite).toBe(composite(result.axisBands));
  });

  test('stores no percentile and no resonance score', () => {
    // Both rank against a WORKSPACE's prior analyses (spec §4c). A crawled
    // channel has no workspace, so the number would be undefined at best and
    // misleading at worst. The within-creator ranking happens at extract time,
    // where the comparison set is the creator's own posts — which is also the
    // statistically correct scope, so the two concerns agree.
    const row = scoreRow(result) as Record<string, unknown>;
    expect(row).not.toHaveProperty('percentileInChannel');
    expect(row).not.toHaveProperty('resonanceScore');
  });

  test('keeps the five timeline arrays as parallel columns', () => {
    const row = scoreRow(result);
    expect(row.timelineStartSec).toEqual(result.timeline.startSec);
    expect(row.timelineVisual).toEqual(result.timeline.visual!);
    expect(
      new Set([
        row.timelineStartSec.length,
        row.timelineAttention.length,
        row.timelineVisual.length,
        row.timelineAudio.length,
        row.timelineLanguage.length,
      ]).size,
    ).toBe(1);
  });

  test('rejects a ragged timeline instead of storing one', () => {
    // The corpus has no reason to accept a row whose curves disagree: a
    // truncation decision belongs in `apps/ml`, where the reason is known.
    const ragged = { ...result, timeline: { ...result.timeline, visual: [0.1] } };
    expect(() => scoreRow(ragged)).toThrow(/length/i);
  });

  test('carries the transcript through for the B2 rung', () => {
    // `research/` builds the text features from this — it is the only text the
    // extract has that is not on the 30-day clock.
    expect(scoreRow(result).transcript).toHaveLength(result.timeline.startSec.length);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test apps/poller/src/scores.test.ts`
Expected: FAIL — `Cannot find module './scores.ts'`

- [ ] **Step 3: Implement it**

`apps/poller/src/scores.ts`:

```ts
import { UnrecoverableError, type Job } from 'bullmq';
import { prismaService } from '@repo/db';
import {
  CORPUS_RESULT_JOB,
  corpusFailedSchema,
  corpusSucceededSchema,
  type CorpusSucceeded,
} from '@repo/queue';
import { composite } from '@repo/scoring';

/**
 * The `corpus-results` consumer: turns what `apps/ml` reports into
 * `corpus.scores`.
 *
 * The mirror image of `apps/worker/src/results.ts`, and deliberately much
 * smaller. There is no status column to advance, no `inference_runs` row, no
 * percentile and no insights step — a corpus row is raw upstream output plus
 * the one reduction the product also performs.
 */

export interface ScoreRow {
  postId: string;
  clipId: string;
  attempt: number;
  timelineStartSec: number[];
  timelineAttention: number[];
  timelineVisual: number[];
  timelineAudio: number[];
  timelineLanguage: number[];
  axisBands: CorpusSucceeded['axisBands'];
  transcript: CorpusSucceeded['transcript'];
  composite: number;
  device: string | null;
  durationMs: number;
}

export function scoreRow(result: CorpusSucceeded): ScoreRow {
  const { startSec, attention, visual, audio, language } = result.timeline;
  const curves = [startSec, attention, visual ?? [], audio ?? [], language ?? []];

  if (new Set(curves.map((c) => c.length)).size > 1) {
    // `apps/ml` already truncates a ragged timeline to the shortest curve,
    // where the reason for the mismatch is known. One arriving here means
    // something else produced it, and a retry will not fix that.
    throw new UnrecoverableError(
      `corpus ${result.corpusPostId}: timeline arrays disagree in length ` +
        `(${curves.map((c) => c.length).join(', ')})`,
    );
  }

  return {
    postId: result.corpusPostId,
    clipId: result.clipId,
    attempt: result.attempt,
    timelineStartSec: startSec,
    timelineAttention: attention,
    timelineVisual: visual ?? [],
    timelineAudio: audio ?? [],
    timelineLanguage: language ?? [],
    axisBands: result.axisBands,
    transcript: result.transcript ?? null,
    // The product's own reduction, imported rather than restated.
    composite: composite(result.axisBands),
    device: result.device ?? null,
    durationMs: result.durationMs,
  };
}

async function onSucceeded(result: CorpusSucceeded): Promise<void> {
  const row = scoreRow(result);
  // `@@unique([postId, attempt])` makes the write idempotent under
  // at-least-once delivery, the same way `inference_runs` does on the app side.
  await prismaService.corpusScore.upsert({
    where: { postId_attempt: { postId: row.postId, attempt: row.attempt } },
    create: {
      postId: row.postId,
      clipId: row.clipId,
      attempt: row.attempt,
      timelineStartSec: row.timelineStartSec,
      timelineAttention: row.timelineAttention,
      timelineVisual: row.timelineVisual,
      timelineAudio: row.timelineAudio,
      timelineLanguage: row.timelineLanguage,
      axisBands: row.axisBands,
      transcript: row.transcript ?? undefined,
      composite: row.composite,
      device: row.device,
      durationMs: row.durationMs,
    },
    update: {
      composite: row.composite,
      axisBands: row.axisBands,
      device: row.device,
      durationMs: row.durationMs,
    },
  });
}

export async function handleCorpusResult(job: Job<unknown>): Promise<void> {
  switch (job.name) {
    case CORPUS_RESULT_JOB.succeeded:
      return onSucceeded(corpusSucceededSchema.parse(job.data));
    case CORPUS_RESULT_JOB.failed: {
      const failure = corpusFailedSchema.parse(job.data);
      // Nothing to persist: a corpus post with no score simply has no row, and
      // the extract's own N tells the story. Logged so a systematically failing
      // backfill is visible rather than merely small.
      console.error(
        `[corpus] ${failure.corpusPostId} attempt ${failure.attempt} failed` +
          `${failure.retryable ? ' (will retry)' : ''}: ${failure.error}`,
      );
      return;
    }
    default:
      throw new UnrecoverableError(`unknown corpus result job "${job.name}"`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/poller/src/scores.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Consume the queue**

In `apps/poller/src/index.ts`, add the import:

```ts
import { CORPUS_RESULTS_QUEUE } from '@repo/queue';

import { handleCorpusResult } from './scores.ts';
```

and a second worker beside the first:

```ts
const results = new Worker(CORPUS_RESULTS_QUEUE, handleCorpusResult, {
  connection,
  prefix: QUEUE_PREFIX,
  // Short database writes, not GPU work. Every handler is idempotent and
  // order-independent — and unlike the analysis path there is no parent row two
  // events contend for, so no lock ordering is needed here.
  concurrency: 8,
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3_600 },
});

results.on('failed', (job, error) => {
  console.error(`[corpus] ${job?.name ?? 'job'} ${job?.id ?? '?'} failed:`, error.message);
});
```

and close it in `shutdown`, before `queue.close()`:

```ts
await results.close();
```

- [ ] **Step 6: Verify the app end to end**

Run: `bun test apps/poller && bun run typecheck && bun run lint`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add apps/poller/src/scores.ts apps/poller/src/scores.test.ts apps/poller/src/index.ts
git commit -m "feat(poller): persist corpus scores with the product's own composite"
```

---

## Task 18: Three openings in the harness

**Files:**

- Modify: `research/eval/snapshot.py:112-149`, `research/eval/ladder.py:21-47`, `research/eval/report.py:118-135`, `research/eval/cli.py:183-201`
- Create: `research/tests/test_snapshot_extras.py`, `research/tests/test_ladder_metadata.py`

**Interfaces:**

- Consumes: nothing new.
- Produces:
  - `write_snapshot(..., producer: str, seed: int, extra: dict | None = None)` — merges `extra` into the manifest, refusing to overwrite a reserved key.
  - `ladder.FORBIDDEN_FEATURE_COLUMNS: tuple[str, ...]`, `ladder.metadata_columns(snap: Snapshot) -> tuple[str, ...]`.
  - `report.render_report` reads `payload["analysis"] = {"title": str, "note": str}`.
  - `cli.run` copies `snap.manifest.get("analysis")` into the payload.

Three small, additive changes. The `analysis` block is deliberately carried by the **snapshot's own manifest** rather than a CLI flag: §1a requires that `research/` gain no code path by which a corpus snapshot can produce a pre-registration verdict, and a flag is exactly such a path — someone would eventually run the corpus snapshot without it. A snapshot that declares what it is cannot be laundered by the command line.

- [ ] **Step 1: Write the failing tests**

`research/tests/test_snapshot_extras.py`:

```python
import numpy as np
import pandas as pd
import pytest

from eval.snapshot import SnapshotError, load_snapshot, write_snapshot

REQUIRED = {
    "post_id": ["p1", "p2"],
    "creator_id": ["c1", "c1"],
    "published_at": pd.to_datetime(["2026-07-01", "2026-07-02"]),
    "label": [0.1, 0.2],
    "view_count": [100, 200],
    "format": ["SHORT_FORM", "SHORT_FORM"],
    "duration_sec": [20.0, 25.0],
    "hashtag_count": [1, 2],
    "published_hour": [12, 13],
    "published_dow": [2, 3],
    "follower_count": [1000, 1000],
}


def _write(tmp_path, extra=None):
    write_snapshot(
        tmp_path,
        pd.DataFrame(REQUIRED),
        np.zeros((2, 4)),
        np.zeros((2, 6)),
        producer="corpus",
        seed=0,
        extra=extra,
    )


def test_extra_keys_survive_the_round_trip(tmp_path):
    _write(tmp_path, {"outcome": "views_at_Nd", "maturation": {"n_days": 14, "phase": 1}})
    manifest = load_snapshot(tmp_path).manifest
    # Two runs at different maturation floors are silently incomparable unless
    # the floor travels with the artifact — the label changed meaning between
    # them, and nothing else in the snapshot records that.
    assert manifest["outcome"] == "views_at_Nd"
    assert manifest["maturation"] == {"n_days": 14, "phase": 1}


def test_extra_cannot_overwrite_a_reserved_key(tmp_path):
    # `checksums` is what makes the snapshot verifiable at all.
    with pytest.raises(SnapshotError):
        _write(tmp_path, {"checksums": {}})


def test_snapshots_without_extra_are_unchanged(tmp_path):
    _write(tmp_path)
    manifest = load_snapshot(tmp_path).manifest
    assert set(manifest) == {"version", "producer", "seed", "rows", "creators", "dims", "checksums"}
```

`research/tests/test_ladder_metadata.py`:

```python
import numpy as np
import pandas as pd
import pytest

from eval.ladder import FORBIDDEN_FEATURE_COLUMNS, features_for, metadata_columns
from eval.snapshot import METADATA_COLUMNS, Snapshot

POSTS = pd.DataFrame(
    {
        "post_id": ["p1", "p2"],
        "creator_id": ["c1", "c1"],
        "published_at": pd.to_datetime(["2026-07-01", "2026-07-02"]),
        "label": [0.1, 0.2],
        "view_count": [100, 200],
        "format": ["SHORT_FORM", "SHORT_FORM"],
        "duration_sec": [20.0, 25.0],
        "hashtag_count": [1, 2],
        "published_hour": [12, 13],
        "published_dow": [2, 3],
        "follower_count": [1000, 1000],
        "days_since_publish": [40, 39],
    }
)


def snap(manifest):
    return Snapshot(posts=POSTS, text=np.zeros((2, 4)), neuro=np.zeros((2, 6)), manifest=manifest)


def test_a_snapshot_with_no_extras_keeps_the_prereg_columns():
    assert metadata_columns(snap({})) == METADATA_COLUMNS


def test_a_corpus_snapshot_can_add_a_covariate():
    columns = metadata_columns(snap({"extra_metadata_columns": ["days_since_publish"]}))
    assert columns == METADATA_COLUMNS + ("days_since_publish",)
    assert features_for("B1", snap({"extra_metadata_columns": ["days_since_publish"]})).shape[1] == 6


def test_view_count_can_never_enter_the_feature_matrix():
    # Under the corpus's PRIMARY outcome `view_count` is not a subtle leak but
    # the label's identity, and B1 scoring near-perfectly is the only symptom.
    # Enforced HERE, where the matrix is actually built, rather than only in the
    # producer that happens to write the manifest today.
    with pytest.raises(ValueError, match="view_count"):
        metadata_columns(snap({"extra_metadata_columns": ["view_count"]}))


def test_a_constant_column_can_never_enter_it_either():
    # `format` is required by the contract but constant in a Shorts-only corpus.
    # A zero-variance column is degenerate in a fitted model, not merely useless.
    with pytest.raises(ValueError, match="format"):
        metadata_columns(snap({"extra_metadata_columns": ["format"]}))


def test_an_unknown_column_fails_loudly():
    with pytest.raises(ValueError, match="not in posts"):
        metadata_columns(snap({"extra_metadata_columns": ["nonexistent"]}))


def test_the_prereg_columns_never_overlap_the_forbidden_list():
    assert not set(METADATA_COLUMNS) & set(FORBIDDEN_FEATURE_COLUMNS)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd research && .venv/bin/python -m pytest tests/test_snapshot_extras.py tests/test_ladder_metadata.py`
Expected: FAIL — `write_snapshot() got an unexpected keyword argument 'extra'`, `cannot import name 'metadata_columns'`

- [ ] **Step 3: Open `snapshot.py`**

In `research/eval/snapshot.py`, change `write_snapshot`'s signature and manifest assembly:

```python
#: Manifest keys `write_snapshot` owns. A producer's `extra` may not overwrite
#: any of them — `checksums` in particular is what makes a snapshot verifiable.
RESERVED_MANIFEST_KEYS = frozenset(
    {"version", "producer", "seed", "rows", "creators", "dims", "checksums"}
)


def write_snapshot(
    out_dir: Path,
    posts: pd.DataFrame,
    text: np.ndarray,
    neuro: np.ndarray,
    *,
    producer: str,
    seed: int,
    extra: dict | None = None,
) -> None:
    """Write a validated snapshot. Refuses to write anything malformed.

    `extra` is merged into the manifest, for facts that describe THIS snapshot
    rather than the format: which outcome it carries, the maturation floor and
    the phase that produced it, the exclusion tallies, and whether it is the
    pre-registered analysis or a secondary exploratory one. They belong in the
    artifact because a reader holding only the snapshot must be able to tell two
    runs apart — a shifted maturation floor changes what `label` MEANS, and
    without it that shows up as an unexplainable movement in rho.
    """
```

and at the end, before writing the file:

```python
    if extra:
        collisions = RESERVED_MANIFEST_KEYS & set(extra)
        if collisions:
            raise SnapshotError(
                f"extra manifest keys collide with reserved ones: {', '.join(sorted(collisions))}"
            )
        manifest.update(extra)
    (out_dir / MANIFEST_FILE).write_text(json.dumps(manifest, indent=2) + "\n")
```

- [ ] **Step 4: Open `ladder.py`**

In `research/eval/ladder.py`, add below `RIDGE_ALPHA`:

```python
#: Columns that must never reach a feature matrix, whatever a manifest says.
#:
#: `label` and `view_count` are the corpus's two spellings of the same leak: its
#: PRIMARY outcome is views at a fixed age, so `view_count` there is not a
#: subtle post-publication leak but the label's IDENTITY, and B1 scoring
#: near-perfectly is the only symptom. `format` is required by the snapshot
#: contract but constant in a Shorts-only corpus, and a zero-variance column is
#: degenerate in a fitted model rather than merely useless. The identifiers are
#: listed for completeness — a model fit on `post_id` is not a model.
FORBIDDEN_FEATURE_COLUMNS: tuple[str, ...] = (
    "label",
    "view_count",
    "format",
    "post_id",
    "creator_id",
    "published_at",
)

# The prereg's own B1 columns must satisfy the same rule they enforce.
assert not set(METADATA_COLUMNS) & set(FORBIDDEN_FEATURE_COLUMNS)


def metadata_columns(snap: Snapshot) -> tuple[str, ...]:
    """B1's columns: the prereg's, plus whatever this snapshot declares.

    The corpus adds `days_since_publish` (spec §1b): within-creator z-scoring
    does not remove channel GROWTH, a time trend that lives inside each creator,
    so the trend is detrended out of the label and also offered to B1 as an
    explicit covariate. Synthetic snapshots declare nothing and are unaffected.

    The guard lives here, not only in the producer, because this is where the
    matrix is actually built — a second producer, or a hand-edited manifest,
    would otherwise route straight past it.
    """
    extra = tuple(snap.manifest.get("extra_metadata_columns", ()))

    forbidden = [c for c in extra if c in FORBIDDEN_FEATURE_COLUMNS]
    if forbidden:
        raise ValueError(
            f"extra_metadata_columns names forbidden column(s): {', '.join(forbidden)}"
        )

    missing = [c for c in extra if c not in snap.posts.columns]
    if missing:
        raise ValueError(f"extra_metadata_columns not in posts: {', '.join(missing)}")

    return METADATA_COLUMNS + extra
```

and change the first line of `features_for`:

```python
    metadata = snap.posts[list(metadata_columns(snap))].to_numpy(dtype=float)
```

- [ ] **Step 5: Open `report.py` and `cli.py`**

In `research/eval/report.py`, inside `render_report`, replace the title assembly:

```python
    # A snapshot may declare what analysis it IS. The corpus backtest is a
    # secondary exploratory analysis against a different label from the
    # pre-registered one (corpus spec §1a) — and the declaration rides on the
    # snapshot's manifest rather than a command-line flag on purpose, so there
    # is no invocation that produces a prereg-titled report from corpus data.
    analysis = payload.get("analysis") or {}
    title = analysis.get("title", "Validation result")
    lines: list[str] = [
        f"# {title} — {band}",
        "",
    ]
    if analysis.get("note"):
        lines += [analysis["note"], ""]
```

In `research/eval/cli.py`, inside `run`, add to the initial `payload` dict:

```python
        # Copied from the snapshot, never from an argument — see report.py.
        "analysis": snap.manifest.get("analysis"),
```

- [ ] **Step 6: Run the whole research suite**

Run: `cd research && .venv/bin/python -m pytest`
Expected: PASS — the 164 existing tests plus the 9 new ones. The existing `test_report.py` assertions on `splitlines()[0]` still hold, because a payload with no `analysis` block keeps the title `Validation result`.

- [ ] **Step 7: Commit**

```bash
git add research/eval/snapshot.py research/eval/ladder.py research/eval/report.py research/eval/cli.py research/tests
git commit -m "feat(research): manifest extras, a guarded B1 column list, and self-declaring snapshots"
```

---

## Task 19: `extract.py` — the second producer

**Files:**

- Create: `research/eval/extract.py`, `research/tests/test_extract.py`

**Interfaces:**

- Consumes: `write_snapshot` (`eval.snapshot`).
- Produces:
  - `PRIMARY_OUTCOME = "views_at_Nd"`, `SECONDARY_OUTCOME = "engagement_rate"`
  - `FIXED_AGE_TOLERANCE_DAYS = 2`, `SECONDARY_VIEW_FLOOR = 1000`, `TEXT_DIMS = 128`, `AXES`, `AXIS_STATS`
  - `SECONDARY_ANALYSIS: dict`
  - `Observation = namedtuple`-like dataclass `{ age_days: float; views: int; likes: int | None; comments: int | None }`
  - `CorpusRow` dataclass — one post with its snapshots and its score
  - `resolve_at_age(snapshots, published_at, n_days, tolerance) -> Observation | None`
  - `detrend_within_creator(posts: pd.DataFrame) -> np.ndarray`
  - `Built = { posts: pd.DataFrame; text: np.ndarray; neuro: np.ndarray; extra: dict }`
  - `build_snapshot(rows, *, outcome, maturation, now) -> Built`
  - `write_corpus_snapshot(rows, out_dir, *, outcome, maturation, now) -> Built`

- [ ] **Step 1: Write the failing test**

`research/tests/test_extract.py`:

```python
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from eval.extract import (
    FIXED_AGE_TOLERANCE_DAYS,
    PRIMARY_OUTCOME,
    SECONDARY_OUTCOME,
    SECONDARY_VIEW_FLOOR,
    CorpusRow,
    Observation,
    build_snapshot,
    detrend_within_creator,
    resolve_at_age,
)
from eval.ladder import metadata_columns
from eval.snapshot import METADATA_COLUMNS, REQUIRED_COLUMNS, Snapshot

NOW = datetime(2026, 12, 1, tzinfo=timezone.utc)
MATURATION = {"n_days": 14, "phase": 1}


def snapshots(*pairs):
    """(age_days, views) -> the snapshot tuples the extract reads."""
    return [(NOW - timedelta(days=200 - age), views, 100, 10) for age, views in pairs]


def row(post_id, creator_id, *, published_days_ago=200, series=((14, 5000),), likes=100, **kw):
    published_at = NOW - timedelta(days=published_days_ago)
    return CorpusRow(
        post_id=post_id,
        creator_id=creator_id,
        published_at=published_at,
        duration_sec=kw.get("duration_sec", 20.0),
        hashtag_count=kw.get("hashtag_count", 2),
        follower_count=kw.get("follower_count", 10_000),
        transcript=kw.get("transcript", "watch this"),
        axis_bands=kw.get(
            "axis_bands",
            {
                axis: {"mean": 0.0, "std": 0.1, "peak": 0.2}
                for axis in ("visual", "audio", "language", "emotional", "memorability")
            },
        ),
        composite=kw.get("composite", 0.2),
        snapshots=[
            (published_at + timedelta(days=age), views, likes, 10) for age, views in series
        ],
    )


def cohort(n_creators=3, n_posts=6):
    return [
        row(f"p{c}{i}", f"c{c}", published_days_ago=200 - i, series=((14, 1000 * (i + 1)),))
        for c in range(n_creators)
        for i in range(n_posts)
    ]


class TestFixedAge:
    def test_reads_the_snapshot_at_age_n_not_the_latest_one(self):
        # A post polled for months has a much larger latest view count. Falling
        # back to "most recent" would silently measure different posts at
        # different ages — the exact confound fixed-age measurement removes.
        published_at = NOW - timedelta(days=200)
        series = [
            (published_at + timedelta(days=age), views, 10, 1)
            for age, views in [(1, 100), (14, 5_000), (180, 90_000)]
        ]
        found = resolve_at_age(series, published_at, 14, FIXED_AGE_TOLERANCE_DAYS)
        assert found is not None
        assert found.views == 5_000

    def test_resolves_the_nearest_snapshot_when_polling_was_interrupted(self):
        published_at = NOW - timedelta(days=200)
        series = [
            (published_at + timedelta(days=age), views, 10, 1) for age, views in [(1, 100), (13, 4_800)]
        ]
        found = resolve_at_age(series, published_at, 14, FIXED_AGE_TOLERANCE_DAYS)
        assert found is not None and found.views == 4_800

    def test_returns_nothing_rather_than_falling_back(self):
        # Only a day-40 observation exists. There is no honest reading of this
        # post's views at day 14, so it drops out and is COUNTED.
        published_at = NOW - timedelta(days=200)
        series = [(published_at + timedelta(days=40), 30_000, 10, 1)]
        assert resolve_at_age(series, published_at, 14, FIXED_AGE_TOLERANCE_DAYS) is None


class TestDetrending:
    def test_removes_a_within_creator_growth_trend(self):
        # A growing channel gives its LATER posts more baseline reach — a trend
        # inside each creator that within-creator z-scoring leaves untouched.
        import pandas as pd

        posts = pd.DataFrame(
            {
                "creator_id": ["c1"] * 5,
                "published_at": pd.to_datetime(
                    ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01"]
                ),
                "raw_label": [1.0, 2.0, 3.0, 4.0, 5.0],
            }
        )
        residual = detrend_within_creator(posts)
        assert np.allclose(residual, 0.0, atol=1e-9)

    def test_leaves_variation_that_is_not_a_trend(self):
        import pandas as pd

        posts = pd.DataFrame(
            {
                "creator_id": ["c1"] * 5,
                "published_at": pd.to_datetime(
                    ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01"]
                ),
                "raw_label": [1.0, 5.0, 2.0, 6.0, 3.0],
            }
        )
        assert np.std(detrend_within_creator(posts)) > 0.5


class TestPrimarySnapshot:
    def test_emits_every_required_column(self):
        built = build_snapshot(cohort(), outcome=PRIMARY_OUTCOME, maturation=MATURATION, now=NOW)
        for column in REQUIRED_COLUMNS:
            assert column in built.posts.columns

    def test_carries_no_view_based_exclusion(self):
        # THE guard against selecting on the outcome variable. It is invisible
        # in the output: a snapshot built the wrong way looks entirely normal
        # and simply reports a better rho. Asserted against the tallies, not
        # inferred from row counts.
        rows = cohort() + [row("tiny", "c0", series=((14, 3),), likes=None)]
        built = build_snapshot(rows, outcome=PRIMARY_OUTCOME, maturation=MATURATION, now=NOW)
        assert "views_below_floor" not in built.extra["exclusions"]
        assert "likes_hidden" not in built.extra["exclusions"]
        assert "tiny" in set(built.posts["post_id"])

    def test_view_count_is_present_but_never_a_feature(self):
        built = build_snapshot(cohort(), outcome=PRIMARY_OUTCOME, maturation=MATURATION, now=NOW)
        assert "view_count" in built.posts.columns
        assert "view_count" not in METADATA_COLUMNS
        columns = metadata_columns(
            Snapshot(posts=built.posts, text=built.text, neuro=built.neuro, manifest=built.extra)
        )
        assert "view_count" not in columns
        assert "format" not in columns

    def test_records_the_maturation_value_and_phase(self):
        built = build_snapshot(cohort(), outcome=PRIMARY_OUTCOME, maturation=MATURATION, now=NOW)
        assert built.extra["maturation"] == MATURATION
        assert built.extra["outcome"] == PRIMARY_OUTCOME

    def test_declares_itself_a_secondary_exploratory_analysis(self):
        built = build_snapshot(cohort(), outcome=PRIMARY_OUTCOME, maturation=MATURATION, now=NOW)
        assert built.extra["analysis"]["kind"] == "secondary-exploratory"
        assert "pre-registration" in built.extra["analysis"]["note"]

    def test_counts_a_post_below_the_floor_separately_from_a_polling_gap(self):
        rows = cohort() + [
            row("young", "c0", published_days_ago=3, series=((1, 10),)),
            row("gap", "c0", series=((40, 30_000),)),
        ]
        built = build_snapshot(rows, outcome=PRIMARY_OUTCOME, maturation=MATURATION, now=NOW)
        assert built.extra["exclusions"]["below_maturation_floor"] == 1
        assert built.extra["exclusions"]["no_snapshot_at_age"] == 1


class TestSecondarySnapshot:
    def test_drops_hidden_likes_and_counts_them(self):
        rows = cohort() + [row("hidden", "c0", likes=None)]
        built = build_snapshot(rows, outcome=SECONDARY_OUTCOME, maturation=MATURATION, now=NOW)
        assert built.extra["exclusions"]["likes_hidden"] == 1
        assert "hidden" not in set(built.posts["post_id"])

    def test_applies_the_denominator_floor_only_here(self):
        rows = cohort() + [row("tiny", "c0", series=((14, SECONDARY_VIEW_FLOOR - 1),))]
        built = build_snapshot(rows, outcome=SECONDARY_OUTCOME, maturation=MATURATION, now=NOW)
        assert built.extra["exclusions"]["views_below_floor"] == 1

    def test_the_primary_runs_on_strictly_more_posts(self):
        rows = cohort() + [row("hidden", "c0", likes=None)]
        primary = build_snapshot(rows, outcome=PRIMARY_OUTCOME, maturation=MATURATION, now=NOW)
        secondary = build_snapshot(rows, outcome=SECONDARY_OUTCOME, maturation=MATURATION, now=NOW)
        assert len(primary.posts) > len(secondary.posts)


class TestFeatures:
    def test_neuro_features_are_the_five_axes_by_three_statistics(self):
        built = build_snapshot(cohort(), outcome=PRIMARY_OUTCOME, maturation=MATURATION, now=NOW)
        assert built.neuro.shape == (len(built.posts), 15)

    def test_text_features_come_from_the_transcript(self):
        rows = [
            row("a", "c1", transcript="a completely different sentence"),
            row("b", "c1", transcript="watch this"),
        ] + cohort()
        built = build_snapshot(rows, outcome=PRIMARY_OUTCOME, maturation=MATURATION, now=NOW)
        assert built.text.shape[0] == len(built.posts)
        assert built.text.shape[1] > 0
        # Two different transcripts must not produce the same row.
        index = {pid: i for i, pid in enumerate(built.posts["post_id"])}
        assert not np.allclose(built.text[index["a"]], built.text[index["b"]])

    def test_features_stay_row_aligned_with_posts(self):
        built = build_snapshot(cohort(), outcome=PRIMARY_OUTCOME, maturation=MATURATION, now=NOW)
        assert built.text.shape[0] == len(built.posts) == built.neuro.shape[0]


def test_the_snapshot_validator_accepts_what_the_extract_emits(tmp_path):
    # The seam most likely to drift, and the one that silently invalidates
    # everything downstream if it does.
    from eval.extract import write_corpus_snapshot
    from eval.snapshot import load_snapshot

    write_corpus_snapshot(
        cohort(), tmp_path, outcome=PRIMARY_OUTCOME, maturation=MATURATION, now=NOW
    )
    loaded = load_snapshot(tmp_path)
    assert loaded.manifest["producer"] == "corpus"
    assert loaded.manifest["outcome"] == PRIMARY_OUTCOME
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd research && .venv/bin/python -m pytest tests/test_extract.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'eval.extract'`

- [ ] **Step 3: Implement the builder**

`research/eval/extract.py`:

```python
"""The corpus extract — a second producer of the snapshot format.

This is not an extension of the harness; it is the thing `snapshot.py` was
written anticipating, in its own words: *"Two producers emit this: `synth.py`
today, a Postgres extract later."* It reads the `corpus` schema and emits
`posts.parquet`, the feature sidecars and `manifest.json`, after which
everything downstream — splits, leakage assertions, the B0-B4 ladder, bootstrap,
negative controls, verdict, report — runs **unmodified**, already tested against
worlds with known answers.

**This is not the pre-registered experiment (spec §1a).** The prereg locks
`averageViewPercentage`, which comes from the YouTube *Analytics* API and is
available only to a channel owner, so no public poller can obtain it. Every
snapshot this module writes declares itself a secondary exploratory analysis in
its own manifest, and `cli.run` copies that declaration into the report — a
structural separation rather than an editorial one, because a pre-registration
constrains researcher degrees of freedom only if the constraint survives contact
with a second, easier dataset.

    Sayable:     "we backtested the shipped ranking on N historical Shorts;
                  within-creator rho = X."
    Not sayable: "validated per our pre-registration."
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import HashingVectorizer

from eval.snapshot import write_snapshot

#: The primary outcome, fixed in writing before any data existed (spec §1b).
PRIMARY_OUTCOME = "views_at_Nd"

#: The secondary. Both are computed on every run; the primary does not move.
SECONDARY_OUTCOME = "engagement_rate"

#: How far from age N a snapshot may sit and still be read as "at age N".
#: A post whose polling was interrupted resolves to its nearest observation
#: within this window, or to nothing at all — never to "most recent".
FIXED_AGE_TOLERANCE_DAYS = 2

#: Denominator floor for the SECONDARY outcome only. A ratio over 40 views is
#: noise; a ratio over 1,000 is a rate. Applied when computing the secondary and
#: nowhere else, because a view-count floor on a VIEWS label is selection on the
#: outcome variable — the flaw that disqualifies Instagram's `top_media` (§2).
SECONDARY_VIEW_FLOOR = 1000

AXES = ("visual", "audio", "language", "emotional", "memorability")
AXIS_STATS = ("mean", "std", "peak")

TEXT_DIMS = 128

#: Stamped into every corpus manifest. `cli.run` copies it into the payload and
#: `report.render_report` titles the artifact with it.
SECONDARY_ANALYSIS = {
    "kind": "secondary-exploratory",
    "title": "Secondary exploratory analysis — corpus backtest",
    "note": (
        "This is **not** the pre-registered experiment. The pre-registration locks "
        "`averageViewPercentage`, a YouTube Analytics metric available only to a channel "
        "owner and therefore unobtainable by any public poller. This report backtests the "
        "shipped ranking against a different, publicly observable label on a corpus of "
        "historical Shorts. It does not, and cannot, produce a pre-registration verdict."
    ),
}


@dataclass(frozen=True)
class Observation:
    age_days: float
    views: int
    likes: int | None
    comments: int | None


@dataclass(frozen=True)
class CorpusRow:
    """One `corpus.posts` row with everything the extract needs beside it."""

    post_id: str
    creator_id: str
    published_at: datetime
    duration_sec: float
    hashtag_count: int
    follower_count: int
    transcript: str
    axis_bands: dict
    composite: float
    #: `(captured_at, views, likes, comments)` per snapshot, any order.
    snapshots: list[tuple[datetime, int | None, int | None, int | None]] = field(
        default_factory=list
    )


@dataclass(frozen=True)
class Built:
    posts: pd.DataFrame
    text: np.ndarray
    neuro: np.ndarray
    extra: dict


def resolve_at_age(
    snapshots: list[tuple[datetime, int | None, int | None, int | None]],
    published_at: datetime,
    n_days: int,
    tolerance: int = FIXED_AGE_TOLERANCE_DAYS,
) -> Observation | None:
    """The observation nearest age `n_days`, or None.

    **Never falls back to the most recent snapshot.** That fallback is the whole
    confound fixed-age measurement exists to remove: a post polled for six
    months would contribute its six-month view count while a fresh one
    contributes two weeks', and the resulting correlation would be substantially
    a restatement of how long each post has been up.
    """
    candidates: list[Observation] = []
    for captured_at, views, likes, comments in snapshots:
        if views is None:
            continue
        age = (captured_at - published_at).total_seconds() / 86400.0
        if abs(age - n_days) <= tolerance:
            candidates.append(Observation(age, int(views), likes, comments))

    if not candidates:
        return None
    return min(candidates, key=lambda obs: abs(obs.age_days - n_days))


def detrend_within_creator(posts: pd.DataFrame) -> np.ndarray:
    """Residual of `raw_label` on within-creator publish order (spec §1b).

    Within-creator normalisation does NOT remove channel growth: a growing
    channel gives its later posts more baseline reach, and that is a time trend
    living *inside* each creator, which z-scoring against the creator's own mean
    leaves entirely intact. Regressing the label on publish RANK (not on the
    date, so an irregular posting cadence does not distort the slope) and
    keeping the residual removes it.

    A creator with fewer than three posts gets mean-centring instead: a line
    through two points has no residual, and fitting one would zero the label.
    """
    out = np.zeros(len(posts), dtype=float)
    values = posts["raw_label"].to_numpy(dtype=float)

    for creator in posts["creator_id"].unique():
        mask = (posts["creator_id"] == creator).to_numpy()
        own = values[mask]
        if len(own) < 3:
            out[mask] = own - own.mean()
            continue
        # Rank by publish time, oldest first.
        order = np.argsort(posts["published_at"].to_numpy()[mask], kind="stable")
        rank = np.empty(len(own), dtype=float)
        rank[order] = np.arange(len(own), dtype=float)
        slope, intercept = np.polyfit(rank, own, 1)
        out[mask] = own - (slope * rank + intercept)

    return out


def _axis_vector(axis_bands: dict) -> list[float]:
    return [float(axis_bands[axis][stat]) for axis in AXES for stat in AXIS_STATS]


def build_snapshot(
    rows: list[CorpusRow],
    *,
    outcome: str,
    maturation: dict,
    now: datetime,
) -> Built:
    """Assemble one outcome's snapshot, with its own exclusion set.

    **Exclusions are per-outcome (spec §5b).** The primary takes no view-based
    exclusion of any kind; the secondary adds a hidden-likes drop and a
    denominator floor, both counted and reported. That asymmetry is why the two
    are never mixed inside one parquet, and why the report states two Ns.
    """
    if outcome not in (PRIMARY_OUTCOME, SECONDARY_OUTCOME):
        raise ValueError(f"unknown outcome {outcome!r}")

    n_days = int(maturation["n_days"])
    exclusions: dict[str, int] = {"below_maturation_floor": 0, "no_snapshot_at_age": 0}
    if outcome == SECONDARY_OUTCOME:
        exclusions["likes_hidden"] = 0
        exclusions["views_below_floor"] = 0

    records: list[dict] = []
    neuro: list[list[float]] = []
    transcripts: list[str] = []

    for row in rows:
        age_now = (now - row.published_at).total_seconds() / 86400.0
        observation = resolve_at_age(row.snapshots, row.published_at, n_days)

        if observation is None:
            # Two different facts, kept apart: a post that is simply too young
            # is expected attrition that resolves itself next week, while a
            # polling gap is an operational problem worth seeing.
            if age_now < n_days:
                exclusions["below_maturation_floor"] += 1
            else:
                exclusions["no_snapshot_at_age"] += 1
            continue

        if outcome == SECONDARY_OUTCOME:
            if observation.likes is None:
                # Counted, not silently dropped: hiding likes is not independent
                # of how a post performed, so this is a selection effect rather
                # than missing data, and the report says how large it is.
                exclusions["likes_hidden"] += 1
                continue
            if observation.views < SECONDARY_VIEW_FLOOR:
                exclusions["views_below_floor"] += 1
                continue
            raw_label = (observation.likes + (observation.comments or 0)) / observation.views
        else:
            # log1p for the LADDER's benefit only. The headline metric is
            # Spearman rho, which is rank-based, so the transform changes
            # nothing about the primary number — heavy tails and viral outliers
            # are already handled by ranking. Recorded here so it is not later
            # "fixed" in one place and not the other.
            raw_label = float(np.log1p(observation.views))

        records.append(
            {
                "post_id": row.post_id,
                "creator_id": row.creator_id,
                "published_at": row.published_at,
                "raw_label": raw_label,
                "view_count": observation.views,
                "format": "SHORT_FORM",
                "duration_sec": row.duration_sec,
                "hashtag_count": row.hashtag_count,
                "published_hour": row.published_at.hour,
                "published_dow": row.published_at.weekday(),
                "follower_count": row.follower_count,
                # The covariate §1b asks for. NOT the age at which the label was
                # read (that is `n_days` for every post, by construction, and a
                # constant column is degenerate in a fitted model) but the
                # post's age at extraction — which varies, and is the axis
                # channel growth runs along.
                "days_since_publish": float(age_now),
                "composite": row.composite,
            }
        )
        neuro.append(_axis_vector(row.axis_bands))
        transcripts.append(row.transcript or "")

    posts = pd.DataFrame(records)
    if posts.empty:
        raise ValueError(
            f"no posts survived the {outcome} exclusion set: {exclusions} — "
            "the corpus is not ready to extract"
        )

    posts["label"] = detrend_within_creator(posts)
    posts = posts.drop(columns=["raw_label"])

    vectorizer = HashingVectorizer(n_features=TEXT_DIMS, alternate_sign=False, norm="l2")
    text = vectorizer.transform(transcripts).toarray()

    extra = {
        "outcome": outcome,
        "maturation": maturation,
        "exclusions": exclusions,
        "detrended_within_creator": True,
        "extra_metadata_columns": ["days_since_publish"],
        "analysis": SECONDARY_ANALYSIS,
    }

    return Built(posts=posts, text=text, neuro=np.asarray(neuro, dtype=float), extra=extra)


def write_corpus_snapshot(
    rows: list[CorpusRow],
    out_dir: Path,
    *,
    outcome: str,
    maturation: dict,
    now: datetime,
) -> Built:
    built = build_snapshot(rows, outcome=outcome, maturation=maturation, now=now)
    write_snapshot(
        Path(out_dir),
        built.posts,
        built.text,
        built.neuro,
        producer="corpus",
        seed=0,
        extra=built.extra,
    )
    return built
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd research && .venv/bin/python -m pytest tests/test_extract.py -v`
Expected: PASS, 17 tests

- [ ] **Step 5: Commit**

```bash
git add research/eval/extract.py research/tests/test_extract.py
git commit -m "feat(research): the corpus extract, with per-outcome exclusions and fixed-age reads"
```

---

## Task 20: Reading the corpus, and the `extract` command

**Files:**

- Modify: `research/requirements.txt`, `research/eval/extract.py` (append the reader), `research/eval/cli.py:230-257`, `research/README.md`
- Create: `research/tests/test_extract_cli.py`

**Interfaces:**

- Consumes: `CorpusRow`, `write_corpus_snapshot`.
- Produces: `CORPUS_SQL: str`, `read_corpus(dsn: str) -> list[CorpusRow]`, `cli` subcommand `extract --dsn --out --outcome --n-days --phase`, `cli.maturation_from_args(n_days: int, phase: int) -> dict`.

`N` is supplied on the command line rather than recomputed here. The poller already owns that computation (`apps/poller/src/maturation.ts`) and prints it in every weekly readiness report; a second implementation in Python is precisely the drift the one-parameter rule exists to prevent. Making it an argument also puts the value in the shell history and the manifest together, which is what makes two runs comparable or visibly not.

- [ ] **Step 1: Add the driver**

In `research/requirements.txt`, add below `pytest`:

```
psycopg[binary]>=3.2  # the corpus extract's only database dependency
```

Run: `cd research && .venv/bin/pip install -r requirements.txt`

- [ ] **Step 2: Write the failing test**

`research/tests/test_extract_cli.py`:

```python
import pytest

from eval.cli import maturation_from_args


def test_phase_1_must_carry_the_fallback_value():
    # A phase-1 run uses the hard-coded fallback BY DEFINITION. A manifest
    # claiming phase 1 with any other N is either a typo or a computed value
    # mislabelled as an assumed one — and the manifest is the only thing that
    # makes two runs at different floors comparable.
    assert maturation_from_args(14, 1) == {"n_days": 14, "phase": 1}
    with pytest.raises(ValueError, match="phase 1"):
        maturation_from_args(11, 1)


def test_phase_2_takes_whatever_the_query_produced():
    assert maturation_from_args(11, 2) == {"n_days": 11, "phase": 2}


def test_an_unknown_phase_is_rejected():
    with pytest.raises(ValueError):
        maturation_from_args(14, 3)
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd research && .venv/bin/python -m pytest tests/test_extract_cli.py`
Expected: FAIL — `cannot import name 'maturation_from_args'`

- [ ] **Step 4: Append the reader to `extract.py`**

```python
# ─── reading the corpus ──────────────────────────────────────────────────────

#: One row per scored post, with its snapshots and axis bands folded in.
#:
#: `corpus.scores` is joined, not left-joined: a post with no score has no
#: features, so it cannot be a row in any snapshot. Posts awaiting acquisition
#: are therefore absent rather than present-and-null, which is what keeps the
#: feature arrays row-aligned with the parquet by construction.
CORPUS_SQL = """
  select
    p.id::text                                as post_id,
    c.id::text                                as creator_id,
    p.published_at                            as published_at,
    p.duration_sec                            as duration_sec,
    coalesce(array_length(p.tags, 1), 0)      as hashtag_count,
    coalesce(c.subscriber_count, 0)           as follower_count,
    s.transcript                              as transcript,
    s.axis_bands                              as axis_bands,
    s.composite                               as composite,
    (
      select coalesce(
        json_agg(json_build_array(m.captured_at, m.views, m.likes, m.comments)),
        '[]'::json
      )
      from corpus.metric_snapshots m
      where m.post_id = p.id
    )                                         as snapshots
  from corpus.posts p
  join corpus.channels c on c.id = p.channel_id
  join corpus.scores s on s.post_id = p.id
  where p.published_at is not null
  order by c.id, p.published_at
"""


def _transcript_text(transcript) -> str:
    """The transcript as one string. `None` and `[]` both mean a silent clip."""
    if not transcript:
        return ""
    return " ".join(entry.get("text", "") for entry in transcript).strip()


def read_corpus(dsn: str) -> list[CorpusRow]:
    """Read every scored post out of the `corpus` schema.

    Connects with the same `app_service` credential `apps/poller` uses — corpus
    tables carry RLS forced with zero policies, so no other role can read them
    at all.
    """
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(dsn, row_factory=dict_row) as connection:
        with connection.cursor() as cursor:
            cursor.execute(CORPUS_SQL)
            records = cursor.fetchall()

    return [
        CorpusRow(
            post_id=record["post_id"],
            creator_id=record["creator_id"],
            published_at=record["published_at"],
            duration_sec=float(record["duration_sec"]),
            hashtag_count=int(record["hashtag_count"]),
            follower_count=int(record["follower_count"]),
            transcript=_transcript_text(record["transcript"]),
            axis_bands=record["axis_bands"],
            composite=float(record["composite"]),
            snapshots=[
                (
                    datetime.fromisoformat(captured_at)
                    if isinstance(captured_at, str)
                    else captured_at,
                    None if views is None else int(views),
                    None if likes is None else int(likes),
                    None if comments is None else int(comments),
                )
                for captured_at, views, likes, comments in record["snapshots"]
            ],
        )
        for record in records
    ]
```

- [ ] **Step 5: Add the CLI subcommand**

In `research/eval/cli.py`, add near the top-level constants:

```python
from eval.extract import (
    FALLBACK_N_DAYS_FOR_PHASE_1,
    PRIMARY_OUTCOME,
    SECONDARY_OUTCOME,
    read_corpus,
    write_corpus_snapshot,
)


def maturation_from_args(n_days: int, phase: int) -> dict:
    """The maturation block that travels in the manifest.

    `N` comes from `apps/poller` (which computes it and prints it in the weekly
    readiness report), not from a second implementation here — a `N` that could
    be derived two ways is exactly the drift the one-parameter rule exists to
    prevent. The consistency check below is the one thing worth asserting: a
    phase-1 run uses the fallback BY DEFINITION, so a manifest claiming phase 1
    with some other value is a computed number mislabelled as an assumed one.
    """
    if phase not in (1, 2):
        raise ValueError(f"phase must be 1 or 2, got {phase}")
    if phase == 1 and n_days != FALLBACK_N_DAYS_FOR_PHASE_1:
        raise ValueError(
            f"phase 1 uses the fallback N={FALLBACK_N_DAYS_FOR_PHASE_1}, not {n_days} — "
            "if this N was computed, it is phase 2"
        )
    return {"n_days": n_days, "phase": phase}
```

and in `main`, beside the `synth` subparser:

```python
    extract_cmd = sub.add_parser("extract", help="write a snapshot from the corpus schema")
    extract_cmd.add_argument("--dsn", required=True, help="APP_SERVICE_DATABASE_URL")
    extract_cmd.add_argument("--out", required=True, type=Path)
    extract_cmd.add_argument(
        "--outcome", choices=[PRIMARY_OUTCOME, SECONDARY_OUTCOME], default=PRIMARY_OUTCOME
    )
    extract_cmd.add_argument(
        "--n-days", type=int, required=True, help="the maturation parameter, from the readiness report"
    )
    extract_cmd.add_argument("--phase", type=int, required=True, choices=[1, 2])
```

and in the dispatch, before the `run` call:

```python
    if args.command == "extract":
        from datetime import datetime, timezone

        rows = read_corpus(args.dsn)
        built = write_corpus_snapshot(
            rows,
            args.out,
            outcome=args.outcome,
            maturation=maturation_from_args(args.n_days, args.phase),
            now=datetime.now(timezone.utc),
        )
        print(
            f"wrote {len(built.posts)} posts / {built.posts['creator_id'].nunique()} creators "
            f"to {args.out} — outcome {args.outcome}, exclusions {built.extra['exclusions']}"
        )
        return EXIT_OK
```

Add to `research/eval/extract.py`, beside the other constants:

```python
#: Mirrors `FALLBACK_N_DAYS` in `apps/poller/src/maturation.ts`. Only used to
#: check that a phase-1 manifest carries the fallback it claims — the value
#: itself is always supplied by the caller, never computed here.
FALLBACK_N_DAYS_FOR_PHASE_1 = 14
```

- [ ] **Step 6: Run the tests**

Run: `cd research && .venv/bin/python -m pytest`
Expected: PASS — all 164 + 17 + 3 + 9 tests.

- [ ] **Step 7: Document the workflow**

Add to `research/README.md`:

````markdown
## The corpus backtest (a secondary exploratory analysis)

**Not the pre-registered experiment.** See
[`docs/superpowers/specs/2026-08-12-youtube-corpus-poller-design.md`](../docs/superpowers/specs/2026-08-12-youtube-corpus-poller-design.md) §1a.
The snapshot declares that in its own manifest, and the report is titled with it
— there is no invocation that produces a prereg-titled report from corpus data.

`N` and its phase come from the poller's weekly readiness report, which prints
both. Passing them explicitly is what puts them in the manifest, and a manifest
that records the floor is what makes two runs comparable or visibly not.

```bash
# primary outcome — views at a fixed age, within creator, detrended
.venv/bin/python -m eval extract \
  --dsn "$APP_SERVICE_DATABASE_URL" \
  --out snapshots/corpus-primary --outcome views_at_Nd --n-days 14 --phase 1

.venv/bin/python -m eval run --snapshot snapshots/corpus-primary --out out/corpus-primary

# secondary outcome — engagement rate, with its own exclusion set
.venv/bin/python -m eval extract \
  --dsn "$APP_SERVICE_DATABASE_URL" \
  --out snapshots/corpus-secondary --outcome engagement_rate --n-days 14 --phase 1

.venv/bin/python -m eval run --snapshot snapshots/corpus-secondary --out out/corpus-secondary
```

The two outcomes are never mixed inside one parquet: their exclusion sets differ
(the primary takes no view-based exclusion at all), so the primary runs on
strictly more posts and the report states both Ns.
````

Add `research/snapshots/corpus-*` and `research/out/corpus-*` to `research/.gitignore`.

- [ ] **Step 8: Commit**

```bash
git add research
git commit -m "feat(research): read the corpus schema and add the extract command"
```

---

## Task 21: The zero-shot headline

**Files:**

- Create: `research/eval/zeroshot.py`, `research/tests/test_zeroshot.py`
- Modify: `research/eval/cli.py` (add to the payload), `research/eval/report.py` (render the section)

**Interfaces:**

- Consumes: `per_creator_spearman`, `mean_over_creators` (`eval.metrics`), `bootstrap_over_creators` (`eval.stats`).
- Produces: `zero_shot(snap: Snapshot, *, seed: int) -> dict | None` returning `{ "rho": float, "lo": float, "hi": float, "creators": int, "posts": int }`.

Two analyses, not one (§8a). The ladder answers the research question — does neuro beat metadata and text. This answers the original one, and it is the more honest headline precisely because **nothing is fitted, so nothing can be overfitted**: it tests the product exactly as it ships. Reporting only the fitted result would invite the obvious question of what was tuned.

- [ ] **Step 1: Write the failing test**

`research/tests/test_zeroshot.py`:

```python
import numpy as np
import pandas as pd

from eval.snapshot import Snapshot
from eval.zeroshot import zero_shot


def snap(composite, label, creators=None, manifest=None):
    n = len(label)
    posts = pd.DataFrame(
        {
            "post_id": [f"p{i}" for i in range(n)],
            "creator_id": creators or ["c1"] * n,
            "published_at": pd.date_range("2026-01-01", periods=n, freq="D"),
            "label": label,
            "composite": composite,
        }
    )
    return Snapshot(
        posts=posts, text=np.zeros((n, 2)), neuro=np.zeros((n, 2)), manifest=manifest or {}
    )


def test_returns_nothing_without_a_composite_column():
    # A synthetic world has no shipped composite to correlate, so the section
    # must be absent rather than zero — absent reads as "not applicable",
    # zero reads as "the product predicts nothing".
    with_composite = snap([1, 2, 3], [1, 2, 3])
    assert zero_shot(with_composite, seed=0) is not None

    bare = Snapshot(
        posts=with_composite.posts.drop(columns=["composite"]),
        text=with_composite.text,
        neuro=with_composite.neuro,
        manifest={},
    )
    assert zero_shot(bare, seed=0) is None


def test_a_perfectly_ordering_composite_scores_one():
    result = zero_shot(snap([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]), seed=0)
    assert result["rho"] == 1.0
    assert result["posts"] == 5
    assert result["creators"] == 1


def test_ranks_within_creator_only():
    # Across creators, reach is dominated by audience size, so a pooled
    # correlation would be mostly a restatement of subscriber count. Creator B's
    # labels are an order of magnitude larger and inversely ordered; a pooled
    # Spearman would be dragged negative, a within-creator one stays at 1.
    result = zero_shot(
        snap(
            [1, 2, 3, 1, 2, 3],
            [1, 2, 3, 100, 200, 300],
            creators=["a", "a", "a", "b", "b", "b"],
        ),
        seed=0,
    )
    assert result["rho"] == 1.0
    assert result["creators"] == 2


def test_carries_a_confidence_interval():
    rng = np.random.default_rng(0)
    n = 200
    composite = rng.normal(size=n)
    result = zero_shot(
        snap(composite, composite + rng.normal(scale=0.5, size=n), creators=[f"c{i % 20}" for i in range(n)]),
        seed=0,
    )
    assert result["lo"] < result["rho"] < result["hi"]
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd research && .venv/bin/python -m pytest tests/test_zeroshot.py`
Expected: FAIL — `No module named 'eval.zeroshot'`

- [ ] **Step 3: Implement it**

`research/eval/zeroshot.py`:

```python
"""The un-fitted headline: does the SHIPPED composite rank a creator's own posts?

Two analyses are worth running on this corpus (spec §8a), and they answer
different questions:

* **The ladder** answers the research question — do TRIBE features carry signal
  beyond metadata and text? It fits B0-B4.
* **This** answers the original one — does the product, exactly as it ships,
  rank a creator's posts against their realised reach? **Nothing is fitted, so
  nothing can be overfitted.**

The second is the more honest headline for precisely that reason. Reporting only
the fitted result would invite the obvious question of what was tuned, and the
answer "the corpus it was evaluated on" is not one worth giving.

Within creator, always. Across creators, reach is dominated by audience size,
and a correlation that does not condition on the creator is mostly a restatement
of subscriber count.
"""

from __future__ import annotations

import numpy as np

from eval.metrics import per_creator_spearman
from eval.snapshot import Snapshot
from eval.stats import bootstrap_over_creators


def zero_shot(snap: Snapshot, *, seed: int = 0) -> dict | None:
    """Within-creator Spearman of `composite` against `label`, bootstrapped.

    Returns None when the snapshot carries no `composite` column — a synthetic
    world has no shipped score to correlate, and an absent section reads as
    "not applicable" where a zero would read as "the product predicts nothing".
    """
    if "composite" not in snap.posts.columns:
        return None

    index = np.arange(len(snap.posts))
    y_true = snap.posts["label"].to_numpy(dtype=float)
    y_pred = snap.posts["composite"].to_numpy(dtype=float)

    by_creator = per_creator_spearman(snap.posts, index, y_true, y_pred)
    interval = bootstrap_over_creators(by_creator, seed=seed)

    return {
        "rho": interval.point,
        "lo": interval.lo,
        "hi": interval.hi,
        "creators": len(by_creator),
        "posts": int(len(snap.posts)),
    }
```

- [ ] **Step 4: Wire it into the pipeline**

In `research/eval/cli.py`, import it and add to the payload built in `run`, immediately after `controls` is computed:

```python
from eval.zeroshot import zero_shot
```

```python
        # Computed on every run and reported whether or not the ladder is. It
        # depends on nothing the controls gate, because nothing is fitted.
        "zero_shot": zero_shot(snap, seed=seed),
```

In `research/eval/report.py`, in `render_report`, after the negative-controls loop and BEFORE the `if voided:` early return:

```python
    # Rendered even on a voided run: the controls gate the FITTED result, and
    # this one fits nothing, so a control failure says nothing about it.
    zero = payload.get("zero_shot")
    if zero:
        lines += [
            "",
            "## Zero-shot — the shipped composite, nothing fitted",
            "",
            f"Within-creator rho **{_fmt(zero['rho'])}** "
            f"[{_fmt(zero['lo'])}, {_fmt(zero['hi'])}] "
            f"over {zero['posts']} posts and {zero['creators']} creators.",
            "",
            "No model was trained on this corpus for this number: it is the ranking the "
            "product ships, correlated against realised reach within each creator. The "
            "label carries algorithmic distribution as well as content — thumbnail, title, "
            "posting time, channel momentum and external traffic all move views — so the "
            "claim is that content predicts realised reach, not that content is its only "
            "cause.",
        ]
```

- [ ] **Step 5: Run the whole research suite**

Run: `cd research && .venv/bin/python -m pytest`
Expected: PASS — including `test_report.py`, whose payloads carry no `zero_shot` key and therefore render exactly as before.

- [ ] **Step 6: Verify the two artifacts differ from the prereg's**

```bash
cd research
.venv/bin/python -m eval synth --world signal --out /tmp/synthetic
.venv/bin/python -m eval run --snapshot /tmp/synthetic --out /tmp/synthetic-out
head -1 /tmp/synthetic-out/report.md
```

Expected: `# Validation result — GREEN` — a synthetic snapshot declares no `analysis` block, so the prereg-facing title is unchanged and no zero-shot section appears.

- [ ] **Step 7: Commit**

```bash
git add research/eval/zeroshot.py research/tests/test_zeroshot.py research/eval/cli.py research/eval/report.py
git commit -m "feat(research): the zero-shot headline, fitted on nothing"
```

---

## Self-Review

**Spec coverage.**

| Spec section                                         | Task                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| §1a not the prereg                                   | 18 (self-declaring manifest), 19 (`SECONDARY_ANALYSIS`), 20 (README) |
| §1b primary/secondary, detrending, log transform     | 19                                                                   |
| §2 why YouTube                                       | no code — recorded in `apps/poller/README.md` (13)                   |
| §3 separate schema                                   | 1                                                                    |
| §3c RLS departure                                    | 2, 3                                                                 |
| §3d tables                                           | 1 (plus `corpus.poll_runs`, justified in-task)                       |
| §4a new app, repeatable jobs                         | 5, 13                                                                |
| §4b symmetric queue pair, shared engine, no insights | 14, 15                                                               |
| §4c no percentile                                    | 1 (schema), 17 (asserted)                                            |
| §5a traversal, quota                                 | 6, 10                                                                |
| §5b duration rule, per-outcome exclusions            | 7 (ingest), 19 (extract)                                             |
| §5c cadence, two-phase `N`, manifest records it      | 8, 9, 19, 20                                                         |
| §5d hand-curated frame                               | 5                                                                    |
| §6 retention tiers, text sweep                       | 11                                                                   |
| §7 `SourceResolver`, licence captured                | 6 (licence), 16 (seam)                                               |
| §8 extract, `REQUIRED_COLUMNS` mapping, guards       | 18, 19                                                               |
| §8a two analyses                                     | 21 (zero-shot), existing ladder                                      |
| §9 all ten tests                                     | 7, 10, 14, 16, 19 — see below                                        |
| §10 costs                                            | no code                                                              |
| §11 out of scope                                     | honoured; the one exception is Task 4, stated in Global Constraints  |
| §12 resolved questions                               | 9 (#1), 12 (#2), 19 (#3); #4 is owner-deferred by the spec           |

**§9's test list, individually placed:** duration at the 30 s boundary + each exclusion counted → Task 7; re-poll appends and does not duplicate → Task 7 (deterministic `capturedAt`) and Task 10 (`skipDuplicates`); text sweep on schedule, refreshed rows untouched → Task 11; `db:check-rls` fails on a corpus grant → Task 3 Step 4, which _proves the assertion fires_; the extract's snapshot passes `snapshot.py`'s own validator → Task 19's final test; shared corpus contract fixture → Tasks 14 + 15; primary carries no view-based exclusion → Task 19 `test_carries_no_view_based_exclusion`; `view_count` never reaches the feature matrix → Task 18 `test_view_count_can_never_enter_the_feature_matrix` (enforced in `ladder.py`, where the matrix is built) and Task 19; fixed-age reads at `N` including an interrupted series → Task 19's three `TestFixedAge` cases; two-phase fallback and the phase in the manifest → Task 9 and Task 20.

**Placeholder scan.** No TBDs. The one file committed deliberately incomplete is `apps/poller/seeds/channels.yaml`, which is _data requiring human curation_, not code — it fails its own schema loudly, the criteria are written into its header, and Task 13's README states the poller refuses to start without it.

**Type consistency.** `IngestPlan.excluded` is `Record<ExclusionReason, number>` in Tasks 7, 10 and `store.ts`. `StoredPost` is produced by `CorpusStore.upsertPosts` (Task 10) and consumed by `isDue` (Task 8), which needs only `firstSeenAt` / `lastSnapshotAt` — structurally compatible. `Maturation` is produced by `chooseMaturation`/`readMaturation` (Task 9) and consumed by `buildReadiness` (Task 12) and, as a plain dict, by `build_snapshot` (Task 19) and `maturation_from_args` (Task 20) — the two languages agree on `{n_days, phase}`, and Task 20 asserts the phase-1 value matches Task 9's fallback. `composite()` has one definition (Task 4) and three callers (`apps/worker`, Task 17, and — via the stored column — Task 21). `CorpusJob` is produced by `backfillClips` (Task 16), validated by `corpusJobSchema` (Task 14) and parsed by `CorpusJob` in Python (Task 15).

**Known gaps, stated rather than hidden.**

- **`apps/poller` has no deploy.** `infra/deploy/` covers `api` and `worker` only, and the spec does not ask for a third image. The poller runs locally or on the existing worker box until someone decides otherwise — but note that the cadence in §5c is only real if the process actually runs daily, so this is the first thing to revisit after the frame is curated.
- **Prisma writes are typechecked, not exercised.** `prismaStore`, `prismaSweepStore`, `prismaClipStore`, `buildReadiness` and `onSucceeded` have no test against a live database, matching the posture `apps/worker` already documents. The first real poll run is what confirms them.
- **The atlas check remains upstream of every axis number this corpus produces** (`CLAUDE.md` TODO #1, spec §12.4). It is owner-deferred by the spec and is deliberately not scheduled here — but the composite the zero-shot headline correlates inherits it, so that caveat belongs in any report of this number.

---
