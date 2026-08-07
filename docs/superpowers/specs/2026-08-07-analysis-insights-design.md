# Analysis insights — filling `analysis_results` from the TRIBE tensor

**Date:** 2026-08-07
**Scope:** `apps/ml`, `packages/queue`, `apps/worker`, `apps/api`, `apps/mobile`
**Status:** implemented — see the as-built note below

> **Two later corrections, both in `scoring.ts`.** The per-axis summary is no longer a bare `mean`:
> `apps/ml` sends `{mean, std, peak}` and a named `BAND_SUMMARY` constant selects one (default
> `peak`). A time-average of z-scored BOLD sits near zero by construction — the objection §0 of the
> model-design doc raises against the brain-wide average applies within a network too. And
> `percentile` interpolates rather than counting: against 5 priors a raw count yields only
> 0/20/40/60/80/100, so the headline number could never read 72 until ~20 analyses. Neither changes
> anything else below.
>
> **As built, one deviation from §Stage 1.** The atlas stores **Schaefer 2018 parcel ids** (`int16`,
> 1–400) with their names, not 17 network ids, and `axis_map.py` matches on parcel-name prefixes.
> The audio axis needs auditory cortex _specifically_ (`SomMotB_Aud` — Heschl's / STG); at the
> 17-network level that parcel is inside SomMotB alongside hand and foot motor cortex, so a
> network-id atlas could not express the mapping this spec's own table asks for. Storing parcel ids
> also keeps the axis mapping a code review rather than a regenerated binary. Everything else below
> is as built. Source resolved to Schaefer 2018 (the fallback named under §Risks), for the same
> reason plus its parcel names carrying their network assignment inline.

## Problem

A successful analysis today writes **one JSON blob and three nulls.**

`apps/ml` runs TRIBE, reduces the `[T × 20484]` predicted-fMRI tensor to a single per-timestep mean,
and publishes it. `apps/worker` receives that curve, discovers it cannot store it — the
`analysis_results_timeline_len_chk` constraint requires all five parallel arrays to be equal-length
or all empty, and only two of the five exist — and parks it in `raw_stats` instead
(`apps/worker/src/results.ts`, `timelineColumns`). `resonance_score`, `percentile_in_channel` and
`confidence` stay null by deliberate choice. `analysis_axis_scores` and `analysis_recommendations`
have never had a row written to them.

So the result screen at `apps/mobile/src/app/(app)/analysis/[id].tsx` renders an empty `Score` and
nothing else. A creator waits minutes for a GPU run and is shown that it finished.

The gap is smaller than it looks. The blocker for four of the five product axes _and_ the three
missing timeline bands is one thing: a fixed vertex→network index map that nobody has written yet.
Everything downstream of it is arithmetic.

## Goals

1. Every column in `analysis_results` that can be filled honestly is filled, and the two child
   tables get rows.
2. The numbers are **deterministic and traceable to the brain data** — the same clip against the
   same history produces the same score.
3. The prose is written by Claude, grounded in numbers it did not invent, and validated before it
   is stored.
4. A creator sees a verdict, a timeline, five axes and concrete timestamped advice.

## Non-goals

- **Calibration against real engagement.** Nothing here trains a head on retention or likes. The
  score is self-relative by construction; see [Decision 1](#decision-1--the-score-is-a-self-relative-percentile).
- **`POSTING_TIME` recommendations.** The enum has the value; this pipeline knows nothing about
  timing and will not guess.
- **Cross-creator comparison.** Explicitly rejected — it is the confounder
  `docs/resonance-model-design.md` §2b is built to avoid.
- **New tables or columns.** Everything needed already exists, including RLS.

## What already exists (verified)

| Thing                                               | Where                                                                     | State                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------- |
| `analysis_results` five timeline arrays             | `packages/db/prisma/schema.prisma:272-276`                                | present, unwritten                                  |
| `resonance_score` 0–100 check constraint            | `security_rls/migration.sql:524`                                          | present — a percentile satisfies it by construction |
| `analysis_axis_scores` + `analysis_recommendations` | `schema.prisma:291-321`                                                   | present, unwritten                                  |
| SELECT policies on both child tables                | `security_rls/migration.sql:405-411`                                      | present, rooted at `private.can_access_analysis`    |
| Timestamped transcript                              | `neuralset.events.etypes.Sentence` / `Word` (`start`, `duration`, `text`) | available on every segment, currently discarded     |
| `react-native-svg`                                  | `apps/mobile/package.json:43`                                             | already a dependency                                |
| `Meter`, `Score` primitives                         | `apps/mobile/src/components/ui/`                                          | `Score` already renders `value: number \| null`     |

**No migration is required.** This is the single most important fact about the scope.

## Decisions

### Decision 1 — the score is a self-relative percentile

`percentile_in_channel` is where this clip's composite band activation ranks among the workspace's
own prior succeeded analyses. `resonance_score` is that same number, rounded to an integer.

They are deliberately **the same number in two presentations** — the screen shows "72" and "top
28%". Deriving a second, differently-scaled number would imply a calibration that does not exist.
When one lands, `resonance_score` is where it goes, and `percentile_in_channel` keeps its current
meaning unchanged.

This needs no external labels, matches the "relative before absolute" commitment in
`docs/resonance-model-design.md` §1b, and sharpens as a creator analyzes more.

**Cold start:** below **5** prior succeeded analyses in the workspace, `resonance_score` and
`percentile_in_channel` stay **null**, and **no `analysis_axis_scores` rows are written at all**.

The line is: _relative things wait for history, absolute things ship immediately._ The score and the
axis bars are both ranks against the creator's own past, so neither exists at analysis #1. The
timeline and the recommendations are about this clip alone, so both render from the very first
analysis and carry the screen until the ranking turns on.

Writing axis rows with a sentinel `0` was the alternative — `AnalysisAxisScore.score` is non-null —
and it is rejected: a zero-length bar labelled "Visual attention" reads as _bad_, not as _unknown_,
and no amount of surrounding copy reliably undoes that.

### Decision 2 — Claude writes prose over numbers it did not compute

Every number — bands, axis scores, percentile, confidence — is computed in code. Claude receives
those numbers plus the transcript and writes `analysis_recommendations`: which moment to call out,
what to say about it, which timestamps it refers to.

This is the split that makes the output checkable. A hallucinated timestamp is caught by comparing
it against the curve; a hallucinated score would not be caught by anything. It also keeps the axis
bars traceable back to the brain data, which is the whole claim of the product.

### Decision 3 — Yeo-17, not Yeo-7

`docs/resonance-model-design.md` §1a says "Yeo-7/17". Use **17**, and treat this spec as amending
that doc.

In the 7-network solution, auditory cortex (Heschl's, STG) is folded into **Somatomotor** alongside
hand and foot motor cortex, and the language regions are smeared across **Default** and
**Frontoparietal**. An "audio engagement" score computed from Yeo-7 Somatomotor is mostly dilution,
and a "clarity" score from Yeo-7 Default is worse. The 17-network solution splits out the auditory
(`SomMotB_Aud`) and temporo-parietal language parcels that these two axes actually need.

### Decision 4 — extend the existing path; no third queue

`apps/ml` publishes more; `apps/worker` computes and persists. Rejected alternatives:

- **A third `analysis-insights` queue.** `apps/worker` runs 8 jobs concurrently and is not
  GPU-bound; at a 5 s Claude call that is ~1.6 analyses/sec, far above what a GPU feeds it. The
  queue would solve a throughput problem that does not exist. Revisit if Anthropic rate limits ever
  become the constraint.
- **Doing it all in `apps/ml`.** Puts an Anthropic key on the GPU box and product judgment in the
  compute node, and reduces `apps/worker` to a pipe.

### Decision 5 — the two BETA axes get real numbers and keep their label

Limbic (→ `EMOTIONAL_PULL`) and Default Mode (→ `MEMORABILITY`) are both in the Yeo-17 solution, so
both axes get a computed score rather than staying empty. They ship `BETA` regardless. Having a
number does not make a cortical proxy for a subcortical structure defensible — the label is the
honesty, not the absence of data.

---

## Architecture

```text
apps/ml (GPU)
  preds [T × 20484]
    └─ yeo17_fsaverage5.npy ──▶ bands [T × 17] ──▶ 3 timeline curves + 5 clip-level scalars
  segments[].ns_events ───────▶ timestamped transcript
                     │
                     ▼  [analysis-results] · analysis.succeeded
apps/worker
  tx1  scoring.ts   percentile vs. workspace history ──▶ analysis_results (+ raw_stats.bands)
                                                     ──▶ analysis_axis_scores × 5
                                                     ──▶ analyses → SUCCEEDED
       ── screen becomes useful here; realtime already pushes the status flip ──
       insights.ts  claude-opus-5, json_schema output
  tx2                                                ──▶ analysis_recommendations × ≤4
```

### Stage 1 — `apps/ml`: parcellation and transcript

**`apps/ml/atlas/yeo17_fsaverage5.npy`** — `int8[20484]`, `0` = medial wall / unassigned, `1..17` =
network. Committed to the repo, generated once by `apps/ml/scripts/build_atlas.py` from the Yeo 2011
fsaverage5 annot files. Checking in the ~20 KB array rather than fetching at runtime keeps `nilearn`
out of `requirements.txt`, where it is currently a commented-out optional dependency.

**`apps/ml/atlas/axis_map.py`** — the 17→5 mapping, as a readable table with the parcel names in
comments so a reviewer can check it against the atlas rather than trusting the code.

| Product axis | Yeo-17 networks                     |
| ------------ | ----------------------------------- |
| visual       | Visual A/B/C + Dorsal Attention A/B |
| audio        | SomMot B (auditory)                 |
| language     | Temporal-Parietal + Default B       |
| emotional    | Limbic A/B                          |
| memorability | Default A/C                         |

**`apps/ml/parcellation.py`** — `bands(preds) -> np.ndarray[T, 5]`, mean over each axis's vertices,
skipping label 0. Pure and unit-testable against a synthetic `preds`.

**`engine.predictions_to_dict`** gains `axis_timeline` (the three curves, row-aligned with
`segments`) and `axis_means` (all five clip-level scalars). The existing keys are untouched.

**Transcript** — each segment already carries its `ns_events`; `Sentence` and `Word` events expose
`start`, `duration`, `text`. Join per segment so the transcript aligns row-for-row with the
attention curve. Segments with no speech contribute an empty string, not a dropped row.

**`worker.py::_timeline`** fills `visual` / `audio` / `language`. Its existing truncate-to-shorter
guard extends to the new arrays.

### Stage 2 — the contract

`packages/queue/src/contract.ts`, mirrored by hand in `apps/ml/queue_contract.py`. The timeline
schema already accepts the three bands as `.nullish()` — they simply start arriving. Three additions
to `analysisSucceededSchema`, all `.nullish()` per the Pydantic convention:

```ts
durationSec: z.number().nullish(),
transcript: z.array(z.object({ startSec: z.number(), text: z.string() })).nullish(),
axisBands: z.object({
  visual: z.number(), audio: z.number(), language: z.number(),
  emotional: z.number(), memorability: z.number(),
}).nullish(),
```

`composite` is **not** on the wire — `apps/worker` derives it, so the weighting lives in one place
and can change without a contract change.

Payload size for a 60 s clip at ~1.5 s segments: five 40-float arrays plus 40 transcript lines,
roughly 8 KB. Well within Redis's comfort.

### Stage 3 — `apps/worker/src/scoring.ts` (new, deterministic, pure)

```ts
composite(bands): number          // 0.40·visual + 0.35·audio + 0.25·language
percentile(value, history): number  // linear-interpolated ECDF, 0..100
confidence(priorCount, nSegments): number  // 0..1
```

`composite` weights the three defensible axes by the tiers in `docs/resonance-model-design.md` §1a.
Emotional and memorability are excluded from the top-line number entirely — a BETA axis should not
move the hero score.

**The history query** reads `raw_stats.bands` off prior succeeded analyses in the same workspace,
not the timeline arrays: five floats per row instead of five arrays, and no JSON path operator
needed since Prisma returns `rawStats` and TypeScript parses it. Rows without `bands` (analyses that
predate this work) are skipped, which also means the feature bootstraps cleanly on existing data
rather than needing a backfill.

`confidence = min(1, priorCount / 20) × min(1, nSegments / 20)`. Two things make a percentile
trustworthy: how much history it ranks against, and how much signal the clip itself carried. A 3-second
clip has too few segments for its band means to be stable, and that shows up here rather than being
hidden.

**Ordering inside transaction 1** is load-bearing and not free to change: take the existing
`lockAnalysis` row lock first (the deadlock discipline in `apps/worker/README.md` applies unchanged),
then **read the history before writing this analysis's own `bands`** — otherwise the clip ranks
against itself.

**Axis rows** — five, written only once the history threshold is met (see
[Decision 1](#decision-1--the-score-is-a-self-relative-percentile)), `position` fixed by the order in
the table below so the UI never has to sort. `score` is the per-band percentile against the same
history. Upserted on the existing `@@unique([analysisId, axis])`, so a re-delivered job overwrites
rather than duplicating.

| position | axis               | confidence                                       |
| -------- | ------------------ | ------------------------------------------------ |
| 0        | `VISUAL_ATTENTION` | `STABLE`                                         |
| 1        | `AUDIO_ENGAGEMENT` | `STABLE`                                         |
| 2        | `CLARITY`          | `MEDIUM`, or `BETA` when the transcript is empty |
| 3        | `EMOTIONAL_PULL`   | `BETA`                                           |
| 4        | `MEMORABILITY`     | `BETA`                                           |

`CLARITY` dropping to `BETA` on a silent clip is not cosmetic: a language-network score on a music
video is measuring nothing, and the label is what tells the creator so.

### Stage 4 — `apps/worker/src/insights.ts` (new)

Runs **after** the first transaction commits. The screen becomes useful the moment the analysis
flips SUCCEEDED — the realtime channel from `2026-08-05-analysis-realtime-design.md` already pushes
that — and the tips arrive a beat later.

**Markers are computed in code, not asked for.** `findMarkers(timeline)` returns the top two dips
and top two peaks in the attention curve with their timestamps. Claude explains them; it does not
locate them.

**Prompt input:** modality, duration, the five axis percentiles with their confidence labels (or an
explicit "not enough history to rank this yet"), the three curves downsampled to ≤40 points by
uniform stride, the markers, the transcript, and a plain statement of what is uncertain.

**Call:** `@anthropic-ai/sdk`, `claude-opus-5`, `max_tokens: 16000`, `output_config.format` with a
`json_schema` — structured outputs, not tool use, since there is nothing to execute.

```jsonc
{
  "recommendations": [{ "kind": "...", "message": "...", "targetStartSec": 0, "targetStopSec": 0 }],
}
```

`kind` is an enum over 7 of the 8 `RecommendationKind` values; `POSTING_TIME` is omitted from the
schema so the model cannot reach for it.

**Validation before write** — every field is treated as untrusted:

- zod parse against the same shape
- drop any recommendation whose timestamps fall outside `[0, durationSec]` or where `start > stop`
- truncate `message` to 200 characters
- `priority` assigned from array order, never read from the model
- cap at 4
- check `stop_reason === 'refusal'` **before** reading `content`

**Idempotency:** `analysis_recommendations` has an autoincrement `id` and no natural key, so a
re-delivered job would duplicate rows. Transaction 2 is `deleteMany({ analysisId })` then
`createMany`.

**Failure policy: best-effort, never throws.** A failed Claude call logs, records
`insights: { status: 'failed', error }` **merged into** the existing `raw_stats` — a whole-object
write would clobber the `bands` that transaction 1 just stored and that every future percentile
depends on — and returns. Throwing would fail the BullMQ job
and retry the whole handler — re-running transaction 1 (harmless, it is idempotent) and re-billing
Claude — because a copywriting call had a bad minute. The analysis is already complete and useful
without tips.

**Cost:** roughly 3 K input / 600 output tokens per analysis. At Opus 5 rates ($5/$25 per MTok) that
is about $0.03, against a GPU-minute.

**Configuration:** `ANTHROPIC_API_KEY` in `apps/worker/.env` (and `.env.example`). Absent, the stage
is skipped with a warning at boot rather than failing per-job — a developer running the worker
without a key still gets scores and timelines.

### Stage 5 — `apps/api`

`GET /analyze/:id` (`apps/api/src/routes/analyze/get.ts`) extends its `select` to the five timeline
arrays plus `confidence`, and includes `axisScores` (ordered by `position`) and `recommendations`
(ordered by `priority`). Enums are imported from `@repo/db/enums`, never the barrel, per the repo
convention.

No ownership filter is added — `c.var.db` already runs inside `withUser()`, and the child tables'
existing policies resolve through `private.can_access_analysis`. `GET /analyze` (list) is
**unchanged**; a list row does not need axes or tips.

After the route changes, `turbo run build` must regenerate `dist/app.d.ts` or the mobile typecheck
resolves `AppType` to stale types.

### Stage 6 — `apps/mobile`

`(app)/analysis/[id].tsx` rebuilt to the hierarchy in `docs/resonance-model-design.md` §1b:
**verdict → timeline → why → what to fix.**

- **Verdict** — the existing `Score`, which already handles `value: number | null`. Caption is the
  percentile, or the cold-start line when it is null.
- **Timeline** — new `src/components/analysis/attention-timeline.tsx`. Inline `react-native-svg`
  (already a dependency, already used by `bloom.tsx`) — no charting library. Three band paths over a
  shared x-axis, with the code-computed dip and peak markers labelled in plain language.
- **Why** — five `Meter` rows, one per axis, `BETA` rendered with the existing `Badge`. Absent
  during cold start (no rows exist), replaced by the same baseline copy as the verdict.
- **What to fix** — the recommendation list; tapping a row with timestamps scrubs the timeline to
  that moment.

Tips arrive after the status flip, so the section renders a placeholder while
`recommendations` is empty on a SUCCEEDED analysis and fills in on the next realtime invalidation.
`apps/mobile/DESIGN.md` gets the new component documented alongside the existing primitives.

---

## Testing

| Layer             | How                                                                                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `parcellation.py` | pytest against a synthetic `preds` where each network's vertices are set to a known constant — the band means are then exactly predictable                                                                                                                                                 |
| Atlas integrity   | assert length 20484, labels within `0..17`, and that every one of the five product axes maps to a non-empty vertex set                                                                                                                                                                     |
| `scoring.ts`      | unit tests: cold start returns null score **and zero axis rows**, the threshold boundary at exactly 5 priors, percentile boundaries (all-lowest, all-highest, ties), history excludes the analysis being scored, `CLARITY` downgrade on an empty transcript, confidence at the clamp edges |
| `insights.ts`     | validation tests against fixture model output — out-of-range timestamps dropped, `priority` reassigned, over-long messages truncated, more than 4 capped, refusal handled. The Anthropic client is injected so tests never make a network call                                             |
| Contract          | round-trip a Pydantic-serialised `analysis.succeeded` payload through the zod schema, covering the `null`-vs-`undefined` trap the `.nullish()` convention exists for                                                                                                                       |
| `apps/worker`     | extend `scripts/test-concurrency.ts` so the races cover the new writes                                                                                                                                                                                                                     |
| `apps/api`        | `app.request()` smoke tests for the extended response shape                                                                                                                                                                                                                                |
| End-to-end        | one real clip through Redis → ml → worker → Postgres, asserting all five arrays land and the length constraint accepts them                                                                                                                                                                |

## Risks

**The atlas file is the critical path.** Everything downstream depends on a correct
`yeo17_fsaverage5.npy`. If the Yeo 2011 fsaverage5 annot files prove awkward to obtain, the fallback
is the Schaefer 2018 400-parcel fsaverage5 annotation, whose parcel names carry their 17-network
assignment (`17Networks_LH_SomMotB_Aud_1`) and which is distributed more conveniently. Either source
produces the same artifact and the same downstream code; only `build_atlas.py` differs. **Resolve
this first** — it gates the rest of the plan.

**Vertex ordering.** The atlas must be in the same vertex order TRIBE emits (fsaverage5, left
hemisphere then right, 10242 each). Verify against a known-anatomy check — visual-network vertices
should show the strongest response on a high-motion clip — before trusting any downstream number.

**The percentile is only as good as its history.** Five analyses is a low bar, chosen so the feature
becomes visible quickly. It is a tuning constant, not a statistical claim, and it belongs in one
named place in `scoring.ts`.

**Prompt quality is unmeasured.** There is no eval for whether the tips are good. The validation
layer catches malformed output, not unhelpful output. Ship, read real ones, iterate.

## Open questions

None blocking. The atlas source (Yeo 2011 annot vs. Schaefer 2018) is settled during the first
implementation step, and the choice does not affect anything downstream of `build_atlas.py`.
