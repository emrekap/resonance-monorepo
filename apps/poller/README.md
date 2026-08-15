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
