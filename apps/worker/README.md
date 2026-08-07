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
  index.ts       # boots the Worker, logs, drains on SIGINT/SIGTERM
  results.ts     # the handlers — one per job name, all idempotent
  scoring.ts     # bands → percentile, confidence, axis rows (pure)
  insights.ts    # bands + transcript → recommendations, via Claude (best-effort)
scripts/
  test-concurrency.ts   # races two events for one analysis against a real database
```

`analysis.succeeded` runs in two phases. The first transaction writes everything deterministic and
flips the analysis SUCCEEDED; the second writes the recommendations after the model answers. The
split is what lets the screen be useful immediately and the tips arrive late — or never, without
taking the analysis down with them.

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

## Concurrency — one lock, taken first

Idempotency is not enough on its own. The worker runs **8 jobs at a time**, and two events for the
_same_ analysis routinely arrive together (they are published seconds apart, and any restart drains a
backlog holding both). Their transactions overlap on the same three tables, so whichever order each
handler happened to write in became a lock order — and `started` (analyses → inference_runs) against
`succeeded` (inference_runs → analyses) is a cycle. Postgres broke it the only way it can: **40P01
deadlock detected**, one transaction killed, one event lost.

So every handler now takes the `analyses` row with `SELECT … FOR NO KEY UPDATE` **before anything
else** (`lockAnalysis` in `results.ts`). One ordering point for all three, so writers of one analysis
queue instead of colliding, and statement order inside a handler stops being load-bearing.

```bash
bun run test:concurrency    # races started × succeeded and started × failed, N rounds each
```

That script drives the real handlers against a real database on throwaway analyses it deletes
afterwards. Before the lock it deadlocked in ~5 of every 6 rounds.

Retries are the second half: BullMQ reads the retry policy off the **job**, so it is set by the
producer — `ML_RESULT_ATTEMPTS` (default 5) in `apps/ml/worker.py`. Without it every result job had a
single attempt, and any transient Postgres error discarded the outcome of a GPU run that cannot be
recomputed, stranding the analysis in PROCESSING.

## Scoring — `scoring.ts`

`apps/ml` sends raw per-network activations; this turns them into the numbers a creator sees. Pure,
deterministic, and unit-tested: the same clip against the same history scores the same every time,
which is the property that makes the number arguable at all.

**The score is a rank against the creator's own history, never an absolute.** TRIBE outputs z-scored
BOLD, and there is no validated mapping from that onto engagement — inventing one produces a number
that reads as real. Ranking a clip against the same creator's other clips needs no such mapping, and
it is also the statistically correct framing, because the creator is the confounder you have to
condition on ([`docs/resonance-model-design.md`](../../docs/resonance-model-design.md) §2b).

| Column                  | How                                                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `percentile_in_channel` | where this clip's weighted composite falls in the distribution of the workspace's prior analyses — a **linear-interpolated ECDF**, not a raw count |
| `resonance_score`       | the same number, rounded — "72" and "top 28%" are two presentations of one rank, not two measurements                                              |
| `confidence`            | `min(1, priors/20) × min(1, segments/20)` — a rank needs both a deep history _and_ a clip long enough for its means to be stable                   |
| `analysis_axis_scores`  | five rows, each the same rank computed on that axis's own band                                                                                     |

Only visual, audio and language are weighted into the composite (0.40 / 0.35 / 0.25). EMOTIONAL_PULL
and MEMORABILITY are cortical shadows of subcortical structures that fsaverage5 does not contain, so
they get a score and a `BETA` label but no influence on the headline number. CLARITY drops to `BETA`
when the transcript is empty — a language-network score on a music clip measures nothing, and the
label is what says so.

**Cold start:** below **5** prior analyses, the score, percentile, confidence and _all five axis
rows_ are omitted. Both the number and the bars are ranks against a history that does not exist yet;
the timeline and the recommendations are about the clip alone and carry the screen until then.
Writing axis rows with a sentinel `0` was the alternative and is worse — a zero-length bar labelled
"Visual attention" reads as _bad_, not as _unknown_.

Interpolating rather than counting is what makes the score usable at the history sizes this actually
runs at. Ranking against 5 priors, `below/n` can only be 0, 20, 40, 60, 80 or 100 — the headline
number could never read 72 until a creator had ~20 analyses, and every upload would move it in
20-point steps. A clip matching an entirely flat history scores 50, not 0: it is exactly typical,
which is what the middle of the range means.

The raw bands live in `raw_stats.bands`, which is what every future percentile in the workspace is
computed against. Rows written before this existed simply sit out the ranking, so no backfill is
needed.

### Which statistic is the score — `BAND_SUMMARY`

`apps/ml` sends **three** numbers per axis (`mean`, `std`, `peak`) and this picks one. That is
deliberate, and the choice is currently a documented guess rather than a finding.

`mean` was the original and is the weakest: TRIBE predicts z-scored BOLD, so a time-average sits near
zero by construction — the same objection [`docs/resonance-model-design.md`](../../docs/resonance-model-design.md)
§0 raises against the brain-wide average, which applies within a network too, just less severely.
The default is now `peak` (top-quartile mean), as the closest of the three to "did this hold
attention at its best moments". `std` is §0's "dynamism" proxy but is blind to direction.

Settling it needs real clips ranked each way, which nothing here can do yet. Sending all three is
what makes that a one-word edit in `scoring.ts` instead of a change to the ML image, the queue
contract and a GPU deploy.

## Insights — `insights.ts`

The one non-deterministic step. Claude is given the scores, the curves, the **already-located** peaks
and dips, and the transcript, and writes `analysis_recommendations`. It computes nothing — that split
is what makes the output checkable, since a hallucinated timestamp is caught by comparing it against
the curve while a hallucinated score would be caught by nothing.

Everything returned is treated as untrusted: parsed against a schema, range-checked against the
clip's own duration, truncated, deduped, capped at four, and re-prioritised from array order.
`POSTING_TIME` is absent from the enum the model may choose from — nothing here knows when a creator
posts, and an available enum value is an invitation to guess.

It runs **after** the first transaction commits, so the screen is useful the moment the analysis
flips SUCCEEDED and the tips arrive a beat later over the realtime channel. It **never throws**: a
failure logs, records `raw_stats.insights`, and returns. Failing the job would retry the whole
handler and re-bill the call because a copywriting request had a bad minute.

Needs `ANTHROPIC_API_KEY`. Without it the stage is skipped with one warning at boot and analyses are
still fully scored — only the tips are missing. Roughly $0.03 per analysis.

```bash
bun test    # scoring + insight validation, no network
```

## Run it

```bash
cp .env.example .env    # REDIS_URL + APP_SERVICE_DATABASE_URL
bun run dev             # or: bun run start
```

Needs Redis — `docker compose -f infra/docker/docker-compose.yml up -d`.
