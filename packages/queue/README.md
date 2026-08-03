# @repo/queue

The contract between the three processes that talk over Redis/BullMQ.

Queue names, the key prefix, payload schemas, and the connection factory. No Prisma, no Hono — it
is imported by a producer, a consumer, and (mirrored by hand) a Python process.

## The flow

```text
  apps/api  ──add──▶  [analysis]          ──▶  apps/ml   worker.py
                                                 │ TRIBE v2 on the GPU
                                                 ▼
  apps/worker  ◀────  [analysis-results]  ◀──────┘
       │ prismaService (BYPASSRLS)
       ▼
  analyses · analysis_results · inference_runs
```

**Why two queues and not one.** `apps/ml` never writes app tables — Prisma is the single schema
owner, and a second ORM in Python is precisely the drift this architecture exists to avoid. So the
Python worker reports what it computed and a Bun worker persists it. That also keeps the BYPASSRLS
credential in exactly one process, which is neither the API nor the GPU box.

**Why a queue at all.** Inference is seconds-to-minutes. Blocking a client request on it would hold
an API connection for the duration and lose the work on any disconnect. The queue gives durability,
retries with backoff, and lets the GPU scale independently of the API.

## Interop

`apps/api` and `apps/worker` use `bullmq` from npm; `apps/ml` uses `bullmq` from PyPI. They are the
same project and run the **same Lua scripts** against Redis, so a job one adds is a job the other
consumes. That is what lets the queue straddle the polyglot split with no bridge service.

The Python side cannot import TypeScript, so [`apps/ml/queue_contract.py`](../../apps/ml/queue_contract.py)
mirrors [`src/contract.ts`](src/contract.ts) as Pydantic models. **Change one, change the other.**
Both sides validate on the way in, so a drifted field fails at the boundary instead of arriving in
`apps/worker` as a null that Postgres happily stores.

## Keys

Everything is namespaced under `resonance:` (`QUEUE_PREFIX`) rather than BullMQ's `bull` default, so
a shared Redis cannot collide on a name as generic as `analysis`.

| Queue              | Producer   | Consumer      | Job names                                                     |
| ------------------ | ---------- | ------------- | ------------------------------------------------------------- |
| `analysis`         | `apps/api` | `apps/ml`     | `analyze`                                                     |
| `analysis-results` | `apps/ml`  | `apps/worker` | `analysis.started` · `analysis.succeeded` · `analysis.failed` |

## Idempotency

BullMQ is at-least-once, so every consumer has to tolerate a repeat.

- The `analyze` job's id **is** the analysis id, so a client retrying a POST it never saw the
  response to cannot queue the same GPU run twice.
- Result job ids are `{analysisId}:{attempt}:{name}`, so a Python worker that crashes between
  publishing and acking does not write the same row twice.
- `inference_runs` is keyed `(analysis_id, attempt)`, which is what makes the upserts in
  `apps/worker` safe under a redelivery.

## Env

```bash
REDIS_URL=redis://127.0.0.1:6379   # all three processes; default if unset
```

Local Redis: [`infra/docker/docker-compose.yml`](../../infra/docker/docker-compose.yml).
