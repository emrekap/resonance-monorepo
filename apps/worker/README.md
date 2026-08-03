# apps/worker

**Bun + BullMQ** — consumes the `analysis-results` queue and writes what `apps/ml` computed into
Postgres.

```text
apps/ml  ──▶  [analysis-results]  ──▶  apps/worker  ──▶  analyses
                                                          analysis_results
                                                          inference_runs
```

## Why this is its own process

Two reasons, and both are about the credential.

1. **`apps/ml` must not write app tables.** Prisma is the single owner of the app schema; a second
   ORM in Python is the schema drift the polyglot split exists to avoid. So the Python worker
   reports its outcome on a queue and this process persists it.
2. **`apps/api` must not hold BYPASSRLS.** Writing an ML result means writing rows for a user this
   process is not acting as, which cannot go through `withUser()`/RLS the way a request can — so it
   connects as `app_service`. That credential has no business in a process that serves HTTP.
   Keeping it here is why the separation is real and not just a naming convention.

It also scales on a different axis: the API scales with request volume, this scales with GPU
throughput, which is a small fraction of it.

## Layout

```text
src/
  index.ts     # boots the Worker, logs, drains on SIGINT/SIGTERM
  results.ts   # the handlers — one per job name, all idempotent
```

## The three job names

| Job                  | Writes                                                                             |
| -------------------- | ---------------------------------------------------------------------------------- |
| `analysis.started`   | `analyses` → PROCESSING (only from QUEUED), `inference_runs` row for the attempt   |
| `analysis.succeeded` | `analysis_results`, `inference_runs` timings, `analyses` → SUCCEEDED               |
| `analysis.failed`    | `inference_runs` error; `analyses` → FAILED **only when the attempt was the last** |

That last row matters: a retryable miss is an `inference_runs` row and nothing else. Showing a
creator "failed" for an attempt the queue retries successfully 30 seconds later is worse than
showing them "still working".

## Idempotency

BullMQ is at-least-once and `started` can arrive _after_ its own `succeeded` (two deliveries, a
retry, a reordering). So:

- `started` uses `updateMany` gated on `status: QUEUED`, which cannot walk a finished analysis back.
- `inference_runs` is upserted on `(analysis_id, attempt)`.
- `analysis_results` is upserted on `analysis_id`.

## Not written yet

`resonanceScore`, `percentileInChannel` and `confidence` are left **null** on purpose — the absolute
0–100 only ships once calibration is validated (see [`docs/resonance-model-design.md`](../../docs/resonance-model-design.md)),
and nothing in this pipeline computes it. A placeholder number would read as a real one.

The timeline columns are written only when all five parallel arrays arrive.
`analysis_results_timeline_len_chk` requires them equal-length or all empty, and the
visual/audio/language bands need a Yeo-7 parcellation of the fsaverage5 vertices that `apps/ml` does
not do yet. Until then the real attention curve rides along in `raw_stats` rather than being
discarded.

## Run it

```bash
cp .env.example .env    # REDIS_URL + APP_SERVICE_DATABASE_URL
bun run dev             # or: bun run start
```

Needs Redis — `docker compose -f infra/docker/docker-compose.yml up -d`.
