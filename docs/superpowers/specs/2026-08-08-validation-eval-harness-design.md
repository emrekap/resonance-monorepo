# Validation eval harness — making the pre-registration executable

**Date:** 2026-08-08
**Scope:** `research/` (new top-level directory), `docs/validation-prereg.md` (one amendment)
**Status:** designed, not implemented

## Problem

[`docs/validation-prereg.md`](../../validation-prereg.md) commits to one metric, one label, one
baseline and a Δρ ≥ 0.10 bar, dated before any data exists. That document is the whole reason a
future result will mean anything. But it is **prose**, and prose does not enforce itself.

Everything it locks is currently a promise about what someone will do later, by hand, months from
now, with a cohort finally in front of them and a raise depending on the number. That is exactly the
moment when "within-creator normalization statistics are fit on train only" quietly becomes "fit on
all the data, because the split refactor moved it and nobody noticed." The failure is silent: a
leaked normalizer produces a _better_ number, not an error.

The second problem is timing. [`validation-experiment-spec.md` §12](../../validation-experiment-spec.md)
promises "a reproducible eval harness (fixed splits, seeds) so the number can be re-run in
diligence." If that harness is written **after** the data arrives, the analysis is being designed
while its outcome is visible — which is the researcher degree of freedom the pre-registration exists
to close, reintroduced one level down. Writing the analysis code before the data exists is the only
way the prereg's guarantee actually holds.

Both problems have the same fix, and it is available now.

## Approach

Build the harness against **synthetic data with known ground truth**, before the cohort exists.

This is not a stopgap for "we have no real data yet." It is the only window in which the statistics
can be tested against truth at all: with real data nobody knows the right answer, so a harness that
silently computes the wrong Spearman is indistinguishable from one that computes the right one. With
a planted world, the harness either recovers the effect that was planted or it does not.

Two design commitments follow, and both are the point of the exercise:

1. **Every leakage rule becomes an assertion with a test that proves it fires on a violation** — not
   a test that it passes on clean data, which proves nothing.
2. **The harness computes the verdict.** The prereg commits to a threshold; a human applying that
   threshold after seeing the numbers is the failure mode. `verdict.py` applies it mechanically.

### Scope

Task A only — within-creator ranking, the single primary task the pre-registration stands or falls
on. Task B (per-second retention curve, dip localization within ±1 s) is roughly double the work for
something the prereg itself calls secondary and exploratory, and it bolts on later without
reshaping anything here.

**Explicitly out of scope:** feature extraction (that stays `apps/ml`'s job, landing in
`feature_artifacts`), the Postgres → snapshot extract (specced below, deferred), and any production
model training.

## Architecture — the snapshot is the contract

One format, two producers, one consumer:

```text
research/eval/synth.py ──┐
                         ├──▶  snapshot/  ──▶  harness  ──▶  results.json
(later) pg extract ──────┘     posts.parquet                 report.md
                               features/b2_text.npy          verdict: GREEN|YELLOW|RED
                               features/b3_neuro.npy
                               manifest.json
```

The synthetic producer and the eventual Postgres extract emit the **same format**, so the harness
has exactly one input path and it is exercised from day one. That is what lets this be written now
rather than rewritten later.

### Snapshot layout

| File                    | Holds                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `posts.parquet`         | scalars — `post_id`, `creator_id`, `published_at`, `label`, `view_count`, `format`, + B1 metadata |
| `features/b2_text.npy`  | caption/title embedding, row-aligned to `posts.parquet`                                           |
| `features/b3_neuro.npy` | TRIBE features, row-aligned to `posts.parquet`                                                    |
| `manifest.json`         | snapshot version, producer, seed, git SHA, row counts, feature dims, checksums                    |

`label` is **`averageViewPercentage`** — the single primary label fixed by
[prereg §4](../../validation-prereg.md), carried as one column so no code path can select a
different one. `view_count` is present only to apply the inclusion threshold; it is never a feature.
The B1 metadata columns are those named in the ladder: length, hashtag count, post time,
day-of-week, follower count.

Wide float features sit beside the parquet rather than inside it, ordered to match its row order and
checksummed in the manifest. This mirrors what the schema already does — `FeatureArtifact` is a
pointer carrying `shape`/`dtype`/`checksum` while the tensor lives in object storage
([`packages/db/prisma/schema.prisma`](../../../packages/db/prisma/schema.prisma)) — so the deferred
extract becomes a near-mechanical mapping instead of a translation.

The loader validates the snapshot against its manifest (checksums, dims, row alignment) and refuses
to run on any mismatch. A silently truncated feature array must not become a quietly worse ρ.

### Modules

```text
research/
  README.md
  requirements.txt          numpy, pandas, pyarrow, scipy, scikit-learn, pytest — no torch
                            (one file, not the run/dev split apps/ml needs — nothing here deploys,
                             so there is no production install to keep lean)
  eval/
    snapshot.py   format, load, validate, manifest
    synth.py      the ground-truth generator
    splits.py     Regime 1 + Regime 2, and the leakage assertions
    ladder.py     B0–B4
    metrics.py    within-creator Spearman, pairwise accuracy, top-k
    stats.py      bootstrap over creators, paired Wilcoxon
    controls.py   label-shuffle, naive brain-wide average
    verdict.py    prereg §6 thresholds → Green/Yellow/Red
    report.py     results.json + report.md
    cli.py        python -m eval run --snapshot … --out …
  tests/
```

`research/` is a new top level beside `apps/`, `packages/` and `infra/`, deliberately: `apps/` means
things that deploy, and this never will. It is a **Python island** in the same sense as `apps/ml` —
no `package.json`, so Bun and Turbo ignore it — but with its own dependency set, because
`apps/ml`'s suite is kept torch-free and dependency-light on purpose and scipy/sklearn/pandas have
no business in it.

### Pipeline

```text
load → split → assemble features
     → CONTROLS (label-shuffle, brain-average)   ── fail ─▶ VOID, stop, emit nothing further
     → fit/predict ladder → metrics → stats → verdict → report
```

Controls sit **before** the ladder, not after it, because prereg §7 requires them to run before the
primary result is read and voids the run if the label-shuffle still predicts. Ordering them later
would mean computing the number first and deciding afterwards whether we were allowed to look — the
gate has to be upstream to be a gate. Note that the controls themselves fit models (a shuffled-label
run of the ladder is how you show it collapses to chance), so `fit/predict` is reachable from both
stages; the difference is that only the second stage's output reaches `metrics` and beyond.

The model ladder is [prereg §5](../../validation-prereg.md): **B0** creator historical mean, **B1**
metadata only, **B2** caption/title text embedding, **B3** TRIBE neuro-features (the treatment),
**B4** all three. The baseline to beat is `max(B1, B2)`, fixed in advance.

Both regimes are reported: **Regime 1** (new post, known creator — per-creator temporal split, most
recent 20% held out) and **Regime 2** (new creator — grouped hold-out, entire creators withheld).

## Leakage rules become executable

Each prose rule in [prereg §7](../../validation-prereg.md) becomes a runtime assertion **plus a test
that proves it fires on a deliberately corrupted split.** A test that an assertion passes on clean
data proves nothing; the test that matters is the one that breaks the split on purpose.

| Rule (prereg §7)                             | Enforcement                                                                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| No creator in both train and test (Regime 2) | set-intersection assert on creator ids                                                                                                  |
| Time order respected (Regime 1)              | assert `max(train.published_at) ≤ min(test.published_at)` per creator                                                                   |
| Normalization fit on train only              | the normalizer records the index set it was fit on and raises if asked to transform a row whose creator statistics came from outside it |
| Features come only from the video            | post-publication columns are absent from the feature-assembly path by construction; a test asserts that adding one raises               |

## Two things the harness decides, so a human cannot

**Controls gate the result.** Prereg §7 requires the negative controls to run "before reading the
primary result," and says a surviving label-shuffle signal voids the run. So the harness runs
controls **first** and, on failure, voids the run and does not compute or emit the primary result at
all. A number you are not entitled to should not be reachable by scrolling.

**The verdict is computed, not chosen.** `verdict.py` applies the prereg's thresholds mechanically
and writes the band into `results.json`; `report.md` renders whatever it says.

### Amendment required: the outcome bands are not mutually exclusive

Building the verdict mechanically surfaced a genuine ambiguity in the frozen document. Prereg §6
defines:

- **Green** — B3 beats `max(B1,B2)` by Δρ ≥ 0.10, significant at p < 0.05
- **Yellow** — positive but Δρ < 0.10, **or not significant**
- **Red** — no lift (95% CI on the uplift includes 0)

A result with a positive point estimate below 0.10 whose CI includes 0 satisfies **both Yellow and
Red**. Unresolved, that is a free choice made after seeing the numbers — precisely the freedom the
document exists to remove.

**Resolution, to be recorded as a dated amendment before any data is collected:**

1. **Red** if the 95% CI on the uplift includes 0 — no demonstrated lift, whatever the point estimate
2. else **Green** if Δρ ≥ 0.10 and p < 0.05
3. else **Yellow**

Red takes precedence because it is the conservative reading and the one that cannot be accused of
grading on a curve. This must land in `docs/validation-prereg.md` as an amendment dated **before**
collection begins; an ordering rule decided afterwards is worth nothing.

## Testing — four worlds

`synth.py` plants a world whose answer is known, and the tests assert the harness recovers it.

| World            | Contains                                                                                       | Harness must                                   |
| ---------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Signal**       | B3 carrying a planted Δρ ≈ 0.15 over B1/B2, creator random effects, confounders loaded onto B1 | return **Green**                               |
| **Null**         | B3 carrying no signal                                                                          | return **Red**                                 |
| **Leaky**        | a deliberately corrupted split                                                                 | fire the matching assertion                    |
| **Contaminated** | features that encode the label directly                                                        | catch it in label-shuffle and **void** the run |

Beneath that, the arithmetic layer: Spearman against scipy, bootstrap CI coverage, paired Wilcoxon
on known inputs, and a determinism test — same seed produces an identical `results.json` modulo
timestamps.

The synthetic generator's own parameters (true effect size, creator variance, confounder loading)
are explicit arguments, so a test reads as a statement about what was planted and what was
recovered.

## Deferred, with the shape already fixed

**The Postgres → snapshot extract.** The research tables (`post_labels`, `feature_artifacts`,
`post_metric_snapshots`) have never held a row, so an extract written against them today is guesswork
that gets rewritten the moment real backfill exists. The snapshot format is the stable interface;
the extract is a later producer of it. `research/README.md` carries the sketch — including that
`post_labels.split_tag` is the column the schema added so the train/test rule is checkable in SQL,
and the harness's own splits should be reconciled against it once both exist.

## Risks

- **Synthetic realism.** A harness that works on planted Gaussian structure can still meet
  surprises on real creator data — heavy tails, tiny per-creator n, ties in the label. Mitigation:
  the generator takes explicit distribution parameters, and the inclusion-criteria path (view
  threshold, ≥20 posts per creator) is exercised in tests rather than assumed.
- **The prereg amendment is load-bearing.** If the precedence rule is not committed before
  collection, the ambiguity it resolves reopens and the verdict becomes negotiable again.
- **Scope creep toward Task B.** The timeline task is the scientifically interesting one and will be
  tempting. It is out of scope here on purpose; adding it should be its own spec.

## Follow-up, out of scope here

`FeatureKind.YEO7_TIMESERIES` in [`schema.prisma`](../../../packages/db/prisma/schema.prisma) names
the superseded atlas — the shipped parcellation is Schaefer-2018 17-network. Correcting the enum
value is a Postgres migration and belongs with the `add-db-model` skill, not in this work. The
snapshot format should not repeat the mistake: its neuro feature is named for what it is.
