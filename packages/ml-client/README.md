# packages/ml-client

**Not built, and not on the critical path.** This directory is a README and nothing else — no
`package.json`, no source, and nothing in the monorepo imports it.

## Why it is empty

It was scaffolded when the plan was for `apps/api` to call `apps/ml` over HTTP, with a typed client
generated from the ML service's OpenAPI spec as the seam across the polyglot boundary. **The queue
replaced that.** Inference is seconds-to-minutes, so the analysis path goes `apps/api` → BullMQ →
`apps/ml` → BullMQ → `apps/worker`, and its contract is
[`@repo/queue`](../queue/src/contract.ts) mirrored by hand in
[`apps/ml/queue_contract.py`](../../apps/ml/queue_contract.py). There is no HTTP call from `apps/api`
to `apps/ml` anywhere in the codebase, so there is nothing for a generated client to type.

## When it would earn its place

`apps/ml` still has a FastAPI face (`main.py`, and `manage_space.py` for the Hugging Face Space), so
this becomes real the moment something in the TS layer needs a **synchronous** call into it — a
health/capability probe, a model-metadata endpoint, an admin surface. At that point: generate from
the ml OpenAPI spec (`openapi-typescript` / `orval`), never hand-write, and follow
[`add-package`](../../.claude/skills/add-package/SKILL.md) to wire it into Bun workspaces and Turbo.

Until then, leaving this as a marked placeholder is deliberate — the alternative is deleting it and
losing the note explaining why the obvious-looking seam is not the one this repo uses.
