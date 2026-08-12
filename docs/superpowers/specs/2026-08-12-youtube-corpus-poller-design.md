# YouTube Shorts corpus poller — design

**Date:** 2026-08-12
**Status:** design, not yet implemented
**Scope:** a new `apps/poller` that builds a corpus of public YouTube Shorts (≤30 s) with their
engagement metrics over time, in an isolated `corpus` Postgres schema, so the shipped resonance
score can be ranked against real outcomes. Instagram and TikTok are explicitly **out of scope** —
§2 records why. Source-file acquisition is explicitly **deferred** — §7 records the seam.

---

## 1. Goal, and the claim it can support

Produce a number of this shape:

> On N Shorts across M creators, the resonance composite ranks a creator's own posts against their
> realised engagement rate at Spearman ρ = X.

Two words in that sentence are load-bearing. **"A creator's own"** — the ranking is within-creator,
because across creators, engagement is dominated by audience size, and a correlation that does not
condition on the creator is mostly a restatement of subscriber count. **"Realised"** — the metric is
read after it has matured, not at discovery time.

### 1a. This is NOT the pre-registered experiment

[`validation-prereg.md`](../../validation-prereg.md) §4 locks exactly one primary label:
`averageViewPercentage`. That metric comes from the YouTube **Analytics** API, is available only to
the channel owner, and therefore **cannot be obtained by any public poller**. This corpus runs a
different analysis against a different label.

That distinction is the entire return on having pre-registered. A pre-registration constrains
researcher degrees of freedom only if the constraint survives contact with a second, easier dataset;
if this corpus's number is later reported as "the validation," the commitment was spent for nothing
and the prereg becomes decoration. So the separation is structural, not editorial:

- corpus results write to their own output directory, never to the prereg's,
- the generated report is titled as a **secondary exploratory analysis** in its own front matter,
- `research/` gains no code path by which a corpus snapshot can produce a prereg verdict.

**Sayable:** "we backtested the shipped ranking on N historical Shorts; within-creator ρ = X."
**Not sayable:** "validated per our pre-registration." The first survives technical diligence. The
second does not, and it is the kind of overclaim that costs more than the number is worth.

### 1b. The label

```
engagement_rate = (likes + comments) / views
```

Ranked within creator. A ratio rather than raw counts, because within a channel the dominant
confound is **age**: an older Short has had longer to accumulate. A ratio cancels most of that,
since numerator and denominator accumulate together. Two further controls, because "most" is not
"all":

- `days_since_publish` enters the B1 metadata rung as an explicit covariate.
- Posts below a **maturation floor** are excluded outright (§5b), with the floor itself measured
  rather than assumed (§5c).

`likes` is nullable in the wild: creators can hide like counts. Such posts are excluded and the
exclusion is **counted and reported**, because hiding likes is not independent of how a post
performed, so silently dropping them would be a selection effect rather than missing data.

---

## 2. Why YouTube, and why not Instagram or TikTok

The obvious first instinct is Instagram's Hashtag Search API, since it returns `media_url` and looks
like it hands you videos and engagement in one call. It does not work here, and it fails on
**statistics before it fails on terms** — which matters, because the statistical failure is not
fixable by getting permission.

| Requirement            | IG Hashtag Search                    | YouTube Data API v3               |
| ---------------------- | ------------------------------------ | --------------------------------- |
| Creator identity       | ✗ `username`/`owner` stripped as PII | ✓ `channelId` on every video      |
| Denominator for a rate | ✗ no `views`/`reach`/`impressions`   | ✓ `statistics.viewCount`          |
| Follower control (B1)  | ✗ none                               | ✓ `channels.list.subscriberCount` |
| Unselected sample      | ✗ `top_media` or a 24 h window       | ✓ full uploads playlist           |
| Breadth                | ✗ 30 unique hashtags / 7 days        | ✓ 1 quota unit per 50 videos      |

Without creator identity there is no within-creator ranking, and §1 established that a
cross-creator correlation is not worth reporting. Without a denominator the only available label is
raw like count, which is a function of reach and follower count — neither observable. And both media
edges are sampled wrongly in opposite directions: `top_media` is **selected on the outcome
variable**, truncating the label's range; `recent_media` covers only the last 24 hours, so the
label has not formed yet.

On terms, Instagram Public Content Access additionally requires App Review plus Business
Verification, its five approved use cases are all brand/campaign monitoring rather than corpus
construction, and Meta's Platform Terms bar external parties from training on platform data without
express permission — which is the specific stated purpose.

TikTok is excluded by [`platform-data-contract.md`](../../platform-data-contract.md): counts only,
no watch-time outside Business tier, and its Research API is access-restricted and largely
non-commercial.

**Instagram is not abandoned — it is re-routed.** The compliant path is the
`connected-accounts` OAuth flow already half-built in `apps/api`, where the creator authorises and
`ig_reels_avg_watch_time` becomes available. That matches the conclusion the data contract already
reached: _YouTube for validation, Instagram for scale._

---

## 3. Isolation — a separate Postgres schema

Corpus rows live in a **`corpus` Postgres schema**, not in the app's tables.

[`schema.prisma`](../../../packages/db/prisma/schema.prisma) already declares `schemas = ["public"]`,
so this is a one-line datasource change to `["public", "corpus"]` plus new models carrying
`@@schema("corpus")`. Prisma remains the single schema owner.

```
corpus.channels   corpus.posts   corpus.metric_snapshots   corpus.clips   corpus.scores
```

### 3a. Why not reuse `Channel` / `Post` in a system workspace

That was the first proposal and it was wrong. Fitting the corpus into customer tables required
**loosening two invariants on live tables**:

- `Channel.connectedAccountId` would become nullable — a publicly observed channel has nothing that
  authorised it — forcing every existing consumer to handle a null that is currently impossible.
- `@@unique([platform, platformChannelId])` would have to admit `workspaceId`, because the moment a
  real customer connects a channel already in the corpus, their insert fails.

Relaxing constraints on customer tables to accommodate a research pipeline is the signal that the
model is being stretched. With a separate schema both problems do not get solved — they cease to
exist. A crawled channel and a connected channel cannot collide, because they are not in the same
table, and the fact that they are different objects is expressed rather than encoded.

### 3b. The compliance argument, which is the stronger one

The two datasets are governed by **different regimes**:

|                  | Corpus                         | Customer                 |
| ---------------- | ------------------------------ | ------------------------ |
| Governed by      | YouTube API ToS                | user consent             |
| Retention        | 36 mo metrics / 30 d text (§6) | until disconnect         |
| Deletion trigger | use-case amendment lapse       | disconnect, `purgeAfter` |

Sharing a table means every retention sweep must discriminate between them correctly, on every run,
forever. A sweep with a wrong predicate either deletes customer rows or over-retains platform data —
the first is a bug, the second is a compliance incident. Separate schemas make that error class
unrepresentable rather than merely unlikely. Dropping the corpus entirely, should the amendment in
§6 be denied, becomes a schema operation instead of a mass `DELETE` racing live traffic.

### 3c. RLS — a deliberate, documented departure

`CLAUDE.md` requires every new table to carry a policy rooted at `workspace_id` or `profile_id`.
Corpus tables have no tenant, so that rule cannot be followed literally.

It is followed in intent: **RLS enabled and forced, with zero policies.** Forced RLS plus no policy
denies every role; only the `BYPASSRLS` service credential passes. This is strictly stricter than a
workspace policy, and it fails closed — a future accidental `GRANT` still reaches nothing.

The reason the convention exists is that `public` is reachable by client roles through PostgREST.
`corpus` grants nothing to `anon` or `authenticated` at all, which removes the exposure the
convention was written to prevent. `db:check-rls` gains a corresponding assertion: **no client-role
grant of any kind on any object in `corpus`** — mirroring how it already fails on column-level
grants outside the realtime allowlist.

### 3d. Tables

- **`corpus.channels`** — seeded identity: `platform_channel_id`, `title`, `subscriber_count`,
  `niche`, poll cursor, `last_polled_at`.
- **`corpus.posts`** — one per Short: `platform_video_id`, `published_at`, `duration_sec`, `title`,
  `description`, `tags`, **`license`** (§7), `text_refreshed_at` (§6).
- **`corpus.metric_snapshots`** — the time series. `(post_id, captured_at)` unique; `views`,
  `likes`, `comments`. One row per poll, never an update.
- **`corpus.clips`** — the source file once acquired: storage pointer, checksum, duration,
  acquisition route. Empty until §7 resolves.
- **`corpus.scores`** — raw ML output per clip: timeline arrays, axis bands, transcript, composite.
  **No percentile** — see §4c.

---

## 4. Processes

```text
apps/poller (NEW, Bun)  ──── YouTube Data API v3 ────▶  seed list
  │ BullMQ repeatable job                                  → channels.list
  │ prismaService (BYPASSRLS)                              → playlistItems.list
  ▼                                                        → videos.list (batched 50)
corpus.channels · corpus.posts · corpus.metric_snapshots

  ……… once §7 resolves ………

apps/poller ──add──▶ [corpus] ──▶ apps/ml ──▶ [corpus-results] ──▶ apps/poller
                                  same engine.py                     │
                                                                     ▼
                                                              corpus.scores
```

### 4a. Why a new app rather than a mode of an existing one

`apps/poller` writes corpus tables with `prismaService`, the `BYPASSRLS` credential that
`apps/api` must never hold — the same reasoning that made `apps/worker` a separate process rather
than a second entrypoint. It also has a different lifecycle from both: cron-shaped rather than
request- or queue-shaped, and it must keep running on a schedule whether or not anyone is using the
product.

Scheduling uses **BullMQ repeatable jobs** rather than `setInterval` or an ECS scheduled task: it
survives restarts, deduplicates across replicas, and is visible in the bull-board already running in
`infra/docker/`. Redis is already a dependency, so this adds no infrastructure.

### 4b. Symmetric queue pair — `apps/worker` is untouched

The corpus path **mirrors** the analysis path instead of borrowing from it: `[corpus]` in,
`[corpus-results]` out, persisted by `apps/poller`. Because corpus results land in `corpus.scores`
rather than `analysis_results`, `apps/worker` needs no changes at all, and corpus backfill cannot
starve or delay a customer job.

Both queues are added to [`packages/queue/src/contract.ts`](../../../packages/queue/src/contract.ts)
and mirrored by hand in `apps/ml/queue_contract.py`, per the standing convention — **change one,
change the other** — with `.nullish()` throughout for the Pydantic reason documented there.

**The one thing that must stay shared is `engine.py`.** A separate queue is not a separate inference
path. If corpus features were computed by different code than product features, the backtest would
silently stop describing the product, and no test would catch it. `apps/ml` consumes both queues and
routes both to the same engine; only the payload and result contracts differ.

Corpus jobs skip the Anthropic insights step. Recommendations are creator-facing output, and 1,600
of them is spend on text nobody reads.

### 4c. `corpus.scores` stores no percentile

`percentileInChannel` and `resonanceScore` in `apps/worker/src/scoring.ts` are computed **against the
workspace's prior analyses**. For a crawled channel there is no workspace history and no tenant, so
that number would be undefined at best and misleading at worst.

The corpus therefore stores the raw upstream values — timeline, axis bands, composite — and the
within-creator ranking is applied at extract time in `research/`, where the comparison set is the
creator's own posts. That is also the statistically correct scope, so the two concerns agree.

---

## 5. The poll cycle

### 5a. Traversal, and why quota is a non-issue

Seed file → `channels.list` (subscriber count, uploads-playlist id) → `playlistItems.list` (walk the
uploads playlist) → `videos.list` batched 50 at a time for `statistics`, `contentDetails`, `status`.

`playlistItems.list` and `videos.list` cost **1 unit each**; `search.list` costs **100**. Channel-first
traversal is therefore ~100× cheaper than discovery, and 40 channels costs low hundreds of units
against a 10,000/day default. **The statistically correct shape and the quota-cheap shape are the
same shape** — discovery is what is expensive, and this design does none.

### 5b. Inclusion, and Shorts detection

There is no `isShort` field on the Data API. The common workaround — probing whether
`youtube.com/shorts/{id}` resolves without redirecting — is unofficial and unnecessary here, because
the **≤30 s rule is stricter than the Shorts boundary anyway**. Filtering on
`contentDetails.duration <= 30s` uses an official field, yields a homogeneous format, and satisfies
[`validation-experiment-spec.md`](../../validation-experiment-spec.md) §3's requirement not to mix
short-form with long-form.

Excluded, each with a counted reason: duration > 30 s; `like_count` hidden; view count below a floor
where the ratio is noise; age below the maturation floor.

### 5c. Cadence — daily, then weekly

Every poll appends a `corpus.metric_snapshots` row; nothing is ever updated in place. **Daily for the
first 14 days** after a post is first seen, **weekly** thereafter.

This is the design's least obvious payoff. A single-shot crawl forces you to _assume_ when
engagement has matured; a time series lets you **measure** it — the maturation floor in §1b becomes
an observed property of the corpus (the age at which the rate stops moving) rather than a guess
defended in prose. It also yields velocity features for free, and satisfies YouTube's "keep stored
data consistent with live YouTube" obligation as a side effect of doing what the statistics already
required.

### 5d. Sampling frame

Hand-curated, committed to the repo as `apps/poller/seeds/channels.yaml`, spanning niche, length and
subscriber tier. Reproducible, zero discovery quota, and diligence-legible: _"here is our frame, here
is why each channel is in it"_ is a materially stronger answer than _"search returned these."_

Curation must check one property that automated discovery cannot: **a channel whose Shorts all
perform identically contributes nothing**, because there is no variance to rank. The seed file
records a one-line rationale per channel, and the frame's biases are stated in the report rather
than left implicit.

Target ≈ **40 channels × 40 Shorts ≈ 1,600 posts**, comfortably above the prereg's floor of ≥30
creators and ≥20 posts each.

---

## 6. Retention and compliance

[YouTube's derived-metrics policy](https://developers.google.com/youtube/terms/derived-metrics-policy)
splits retention three ways rather than applying a flat 30 days:

| Data                                                            | Limit                          | Table                     |
| --------------------------------------------------------------- | ------------------------------ | ------------------------- |
| Statistical metrics — views, likes, comments, subscriber counts | **36 months**                  | `corpus.metric_snapshots` |
| Derived metrics — anything computed from them                   | **36 months**                  | `corpus.scores`           |
| Everything else — titles, descriptions, channel names           | **30 days**, refresh or delete | `corpus.posts.title` etc. |

So the training corpus — the numbers, and everything derived from them — is retainable for three
years, which is longer than this validation needs. Only **text** is on the short clock.

A nightly sweep nulls `title` / `description` / `tags` / `channels.title` wherever
`text_refreshed_at` is older than 30 days and the poller has not refreshed them since. Because the
poller refreshes on its own cadence, the sweep is a backstop for abandoned rows rather than the
primary mechanism.

**The 36-month tier requires the use-case amendment to be accepted.** That is a form, not a
negotiation, and it gates nothing else — so it should be filed on day one, before implementation
starts. Until it is accepted the corpus operates under the base 30-day policy, which is survivable
for a first pass but not for a corpus meant to be re-analysed later.

Two obligations inherited from the [base developer policies](https://developers.google.com/youtube/terms/developer-policies):
stored data must stay consistent with live YouTube (satisfied by §5c), and deletion requests must be
honoured within 7 days. `DataDeletionRequest` already exists as the audit trail.

---

## 7. The deferred half — source files

TRIBE needs the video file, and the Data API does not provide one. Per
[`validation-experiment-spec.md`](../../validation-experiment-spec.md) §11a there are three routes —
creator upload, capture-at-post-time, and scraping the published stream — and that section rules the
third out for a diligence artifact. **This design does not reverse that ruling; it defers it**, and
`corpus.clips` stays empty until it is made deliberately.

What makes deferral nearly free is one column. `videos.list?part=status` returns
`status.license` as `creativeCommon` or `youtube` **at no extra quota**, on the call already being
made. Capturing it now means that after two weeks of polling, _"do enough channels have ≥20
Creative-Commons clips under 30 s?"_ is a **SQL query against the corpus** rather than a separate
research exercise — and whichever route is eventually chosen, no re-crawl is needed.

Acquisition sits behind a `SourceResolver` interface with one method (post → clip or nothing) and
initially one implementation that resolves nothing. The pipeline is complete and testable without
it.

For the record, so the eventual decision is made on facts: a CC-BY licence resolves the **copyright**
question (the uploader has granted reuse, including commercial, with attribution) and does **not**
resolve the **ToS** question (YouTube's terms still bar access by unauthorised means; the realistic
exposure is API-project termination rather than litigation). Those two halves are routinely
conflated and should not be here.

---

## 8. The extract — feeding `research/`

A new `research/eval/extract.py`, a second producer beside `synth.py`. This is not an extension of
the harness; it is the thing [`snapshot.py`](../../../research/eval/snapshot.py) was written
anticipating, in its own words: _"Two producers emit this: `synth.py` today, a Postgres extract
later."_

It reads the corpus schema and emits the existing snapshot format — `posts.parquet`, the feature
`.npy` sidecars, `manifest.json` with checksums. Everything downstream (splits, leakage assertions,
the B0–B4 ladder, bootstrap, negative controls, verdict, report) then runs **unmodified**, already
tested against worlds with known answers.

Mapping to `REQUIRED_COLUMNS`: `creator_id` ← `corpus.channels.id`; `label` ← §1b's engagement rate
(**not** `averageViewPercentage` — §1a); `view_count` ← latest matured snapshot;
`follower_count` ← `subscriber_count`; `duration_sec`, `published_at`, `published_hour`,
`published_dow`, `hashtag_count` ← `corpus.posts`.

`format` is required by the contract but is **constant** here — the corpus is Shorts-only by
construction (§5b). It is emitted for schema conformance and must be **excluded from the B1 feature
matrix**, since a zero-variance column is degenerate in a fitted model rather than merely useless.
The extract asserts this rather than leaving it to the reader.

Per §1a the extract writes to a corpus-specific output directory and its report front matter marks
it a secondary exploratory analysis.

### 8a. Two analyses, not one

They are distinct and both worth running:

- **Zero-shot (answers the original question).** Correlate the **shipped composite** against
  engagement rate, within creator. Nothing is fitted, so nothing can be overfitted — it tests the
  product exactly as it ships. This is the investor-facing number.
- **The ladder (answers the research question).** Fit B0–B4 on TRIBE features and ask whether neuro
  beats metadata and text baselines.

The zero-shot result is the more honest headline precisely because no model was trained on this
corpus. Reporting only the fitted result would invite the obvious question of what was tuned.

---

## 9. Testing

Hermetic, matching the existing posture of route smoke tests via `app.request()` — **no live YouTube
calls in the suite**, against recorded API fixtures. Specifically:

- duration filtering exactly at the 30 s boundary, and each exclusion reason counted;
- re-polling an unchanged post appends a snapshot and does not update or duplicate, i.e. the
  `(post_id, captured_at)` idempotency holds under at-least-once delivery;
- the text sweep nulls on schedule and leaves refreshed rows alone;
- `db:check-rls` fails when any client-role grant exists on `corpus`;
- **the extract emits a snapshot that `snapshot.py`'s own validator accepts** — the seam most likely
  to drift, and the one that silently invalidates everything downstream if it does;
- a shared fixture across the `[corpus]` / `[corpus-results]` contract, mirroring the existing
  api↔ml drift test.

---

## 10. Costs

| Item                   | Estimate                                                         |
| ---------------------- | ---------------------------------------------------------------- |
| YouTube quota          | low hundreds of units/day against 10,000 free — not a constraint |
| GPU, 1,600 clips ≤30 s | ~15–20 GPU-hours ≈ **$10–20** on an A10G                         |
| Anthropic              | **$0** — insights disabled for corpus jobs (§4b)                 |
| Storage, 1,600 clips   | a few GB in a private bucket                                     |
| Curation               | ~1 day, human — **the real cost line**                           |

The GPU bill being negligible is worth stating plainly, because it is the line most likely to be
assumed prohibitive and used to justify a smaller corpus than the statistics need.

---

## 11. Out of scope

- **Instagram and TikTok polling** (§2). Instagram returns via `connected-accounts`, owner-authorised.
- **Source-file acquisition** (§7). Deferred behind `SourceResolver`, with `license` captured now.
- **Anything touching the pre-registered experiment** (§1a). This corpus cannot produce its label.
- **Changes to `apps/api`, `apps/worker`, or any `public` table.** If the implementation finds itself
  editing one, the isolation in §3 has been breached and the design needs revisiting first.

---

## 12. Open questions

1. **The maturation floor** is measured rather than assumed (§5c), so it is unknown until ~4 weeks of
   polling exist. The extract must therefore be parameterised by it, not hard-coded.
2. **Whether the CC-BY population is large enough** to be viable (§7) — answered by SQL after two
   weeks, not by argument now.
3. **Whether `views` should be modelled** rather than divided out. The chosen ratio treats reach as
   a nuisance; an alternative treats view count as itself partly content-driven and worth predicting.
   Settling it needs the corpus to exist first.
4. **TODO #1 in `CLAUDE.md` still gates every axis number.** The atlas has never been checked against
   real anatomy, and a transposed vertex order still averages to plausible values on all five axes.
   That check is upstream of this corpus meaning anything, and running one high-motion clip through
   the pipeline satisfies it.
