# Pre-Registration — "Do neuro-features earn their cost?"

> **Committed 2026-08-08, before any cohort was recruited and before any test-set result was
> observed. Amended 2026-08-09 — see [Amendments](#amendments) — while still unrun: no cohort had
> been recruited and no real or test-set result had ever been observed.** This is the commitment
> artifact required by [`validation-experiment-spec.md`](validation-experiment-spec.md) §2. The spec
> is the method; this file is the part that has to be dated and frozen for the result to mean
> anything.
>
> **Status: locked, not yet run.** No data has been collected. The `[FILL IN]` markers below are
> _outputs_ — they are filled only in §8, after the run, and nothing above §8 may be edited once
> collection begins. If something above turns out to be wrong, the honest move is a new dated
> pre-registration that says so and supersedes this one, not an edit to this one.

---

## 1. Hypothesis

**H1 (primary):** TRIBE-derived neuro-features improve _within-creator_ prediction of retention over
the best cheap baseline (metadata + caption text), by the margin in §6, with significance clustered
at the creator level.

**H0 (null):** TRIBE features add no lift beyond metadata + text.

## 2. Primary task — one, chosen in advance

**Task A — within-creator ranking.** Given a creator's posts, rank them by realized retention.

Task B (per-second timeline prediction) is **secondary and exploratory**. It is reported, but it is
not what H1 stands or falls on, and a Task B win does not rescue a Task A loss. Locking one primary
task is the point of this document — two primaries is two chances to declare success.

## 3. Primary metric — one, chosen in advance

**Within-creator Spearman ρ** between predicted and actual `averageViewPercentage`, computed per
creator, then averaged across creators.

Reported alongside, but **not** primary: pairwise accuracy ("given two posts, do we pick the better
one?"), top-1 / top-k, and for Task B per-second correlation plus dip localization within ±1 s.
Pairwise accuracy is the investor-legible number; it is secondary here precisely so that the choice
of headline cannot be made after seeing which one looks better.

## 4. Label

`averageViewPercentage` from the YouTube Analytics API (completion rate), per video, owner-authorized
via OAuth.

Fixed in advance because the label is the easiest thing to switch after the fact — "retention was
noisy so we used likes" is where a validation quietly becomes a marketing exercise. If the primary
label proves unusable, that is a **negative result plus a new pre-registration**, not a substitution.

## 5. Model ladder

| ID     | Model                                                                    | Role                             |
| ------ | ------------------------------------------------------------------------ | -------------------------------- |
| **B0** | Creator historical mean                                                  | Null floor                       |
| **B1** | Metadata only (length, hashtags, post time, follower count, day-of-week) | Cheap confounders                |
| **B2** | Caption/title text embedding                                             | Language-only baseline           |
| **B3** | **TRIBE neuro-features** (treatment)                                     | The hypothesis                   |
| **B4** | TRIBE + metadata + text                                                  | Ceiling / does neuro add on top? |

**The baseline to beat is `max(B1, B2)`** — chosen before seeing results, so a weak B1 cannot be
presented as the comparison after the fact.

## 6. Success threshold — the number that makes this falsifiable

| Outcome    | Criterion                                                                                                                                                                                      | Committed action                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Green**  | B3 beats `max(B1, B2)` by **Δρ ≥ 0.10**, significant across creators (**p < 0.05**, paired Wilcoxon)                                                                                           | Thesis validated. Build the calibration head; use the number for the raise                     |
| **Yellow** | Positive but Δρ < 0.10, or not significant                                                                                                                                                     | Iterate features / labels / cohort and **re-run under a new pre-registration**                 |
| **Red**    | No lift over metadata+text: the uplift is **unmeasurable** (no finite baseline to beat), or its 95% CI includes 0, or its CI lies **entirely below 0** (B3 measurably worse than the baseline) | Neuro-features are not earning their GPU cost — pivot the technical story before scaling spend |

Committing to the **Red** action in advance is the only thing that makes Green mean anything.

**Precedence is Red-first.** As worded, these bands are not mutually exclusive: a positive point
estimate below 0.10 whose CI still includes zero satisfies both Yellow's text and Red's. Red is
decided first, checked in this order: (1) the uplift is unmeasurable, (2) its CI includes zero, (3)
its CI lies entirely below zero — any one of the three is Red regardless of the point estimate. An
unmeasurable uplift takes the RED action rather than a softer one deliberately: it is not a
demonstrated lift, so the conservative band is where a result that could not be computed belongs, not
a punt to Yellow's "iterate and re-run." Green and Yellow are only considered once all three Red
checks have failed. See [Amendment 1](#amendments).

## 7. Cohort, splits and leakage rules

**Cohort.** ~50 YouTube creators × ~40 posts ≈ 2,000 posts. Owner-authorized channels only. Minimum
posts per creator: **20** (below that, within-creator rank statistics are noise). Diversity across
niche, length and follower tier. Shorts and long-form are modeled separately, never mixed.

**Inclusion.** A per-video view threshold, fixed before collection, below which retention curves are
too noisy to use. Posts are excluded on view count alone — never on how well they scored.

**Splits, both reported — Regime 1 is the headline.**

- **Regime 1 — new post, known creator (headline):** per creator, temporal split; train on older
  posts, test on the most recent 20%. This is the production case ("score my next post"), and its
  band is **the** Verdict in §6 and §8 — named in advance, before any cohort data existed, so the
  headline cannot be chosen after seeing which regime looks better. See [Amendment 2](#amendments).
- **Regime 2 — new creator:** grouped hold-out; entire creators held out of training. Reported in
  full and binding on the write-up — a Regime 2 result is never omitted or downplayed because Regime
  1 looks better — but it does not select the headline band.

**Leakage rules (non-negotiable).**

- Features come only from the video. Nothing post-publication.
- Within-creator normalization statistics are fit on **train only** and applied to test.
- No creator appears in both train and test in Regime 2.
- Time order respected in Regime 1 — never train on a post published after the test post.

**Statistics.** Unit of analysis is the **creator**, not the post. Bootstrap over creators for 95%
CIs on each metric and on the uplift. Paired Wilcoxon signed-rank across creators on per-creator
uplift B3−max(B1,B2). Multiple-comparison correction if more than one label or axis is tested.

**Negative controls, run before reading the primary result.** Label-shuffle within creator — every
model must collapse to chance; if B3 still "predicts," there is leakage, and the run is void until it
is found. Naive brain-wide-average baseline must fail, replicating the known negative result
(arXiv 2607.01400).

## 8. Results — filled only after the run

| Field                                                   | Value       |
| ------------------------------------------------------- | ----------- |
| Date collection started                                 | `[FILL IN]` |
| Date results first observed                             | `[FILL IN]` |
| Creators / posts actually analyzed                      | `[FILL IN]` |
| B1 ρ (95% CI)                                           | `[FILL IN]` |
| B2 ρ (95% CI)                                           | `[FILL IN]` |
| **B3 ρ (95% CI)**                                       | `[FILL IN]` |
| B4 ρ (95% CI)                                           | `[FILL IN]` |
| **Uplift B3 − max(B1,B2) (95% CI), Regime 1**           | `[FILL IN]` |
| p (paired Wilcoxon across creators), Regime 1           | `[FILL IN]` |
| Uplift B3 − max(B1,B2) (95% CI), Regime 2               | `[FILL IN]` |
| p (paired Wilcoxon across creators), Regime 2           | `[FILL IN]` |
| Pairwise accuracy (secondary)                           | `[FILL IN]` |
| `label_shuffle` control passed?                         | `[FILL IN]` |
| `brain_average` control passed?                         | `[FILL IN]` |
| `feature_label_leak` control passed?                    | `[FILL IN]` |
| **Verdict (Green / Yellow / Red), Regime 1 — headline** | `[FILL IN]` |
| Verdict (Green / Yellow / Red), Regime 2                | `[FILL IN]` |

## 9. Known threats this pre-registration does not remove

Stated here so they cannot be presented as discoveries later:

- **Selection bias** — only published posts are observed; killed drafts are invisible, so the label
  range is truncated. Within-published ranking mitigates, does not erase.
- **Algorithmic luck** — distribution and timing confound "content quality." The target is partly
  exogenous, so what gets validated is a propensity, not a guarantee.
- **Distribution shift** — TRIBE was trained on adults watching movies in a scanner. Short-form
  vertical UGC is a different distribution; encoders may transfer, brain-calibration may not.
- **YouTube-only** — Task B's golden label does not exist on IG/TikTok, so temporal generalization
  beyond YouTube is untested by this experiment.
- **Atlas validity** — the axis→network mapping used for any interpretable-feature ablation has not
  been checked against real anatomy (see `resonance-model-design.md` §2e). That affects the _why_
  axes, not the fused-latent B3 result.
- **Negative-control false-positive rate** — measured on the harness's own synthetic worlds, not on
  a cohort (30-seed sweeps): `brain_average` (ceiling 0.10) fires on ~8 of 30 seeds on the null world
  and ~8 of 30 on the signal world (~27%); `label_shuffle` (tolerance 0.10) fires on ~9 of 30 seeds on
  the null world and ~5 of 30 on the signal world, and a separate 20-seed sweep found 4 firings:
  three sitting right on the boundary (−0.100, −0.102, +0.105) and one well past it (−0.145, roughly
  45% beyond the 0.10 threshold). Both thresholds are round numbers
  chosen without a power calculation, applied to a statistic whose standard deviation is ≈0.085 at 40
  creators. Both fail **closed** — a false positive VOIDs a good run, it never passes a leaking one —
  so the direction is safe, but a VOID will sometimes mean "resample," not "leak." Neither threshold
  has been changed: lowering a pre-registered threshold after watching it fire is the post-hoc
  adjustment this pre-registration exists to prevent. Stated here so they cannot be presented as
  discoveries later. See [Amendment 3](#amendments).

## Amendments

All four amendments below were made **2026-08-09**, one day after this document was committed and
before any cohort had been recruited or any real-cohort or test-set result had ever been observed —
every number any amendment references came from a synthetic world whose ground truth `research/`
generated itself. The header block's own rule ("nothing above §8 may be edited once collection
begins") is what makes this legitimate: collection has not begun. Each amendment tightens a
commitment already made; none loosens a bar, and none was made in response to a real result, because
none existed.

**Amendment 1 (2026-08-09) — §6's Red criterion now names all three conditions `verdict()` computes,
including a wholly-negative uplift CI.** As originally written, §6 named only one Red condition, "CI
includes 0". `research/eval/verdict.py`'s `verdict()` has always also treated an unmeasurable uplift
(a NaN bound — e.g. when `research/eval/cli.py`'s `_select_baseline` finds no finite baseline to
beat) as Red, which §6 never stated; and a 95% CI on the uplift that lies _entirely below_ zero — B3
measurably worse than the baseline — matched neither Red nor Green as §6 was worded, so it fell
through to Yellow ("iterate and re-run"), prescribing another run for the clearest refutation the
experiment can produce. `_is_worse_than_baseline` closes that gap, checked after the unmeasurable and
includes-zero checks and before Green — precedence remains Red-first, nothing reordered. §6 and the
"Precedence is Red-first" paragraph now state all three conditions. **Attestation:** found and fixed
against the null synthetic world and a no-finite-baseline fixture only; no real-cohort or test-set
data existed or was observed at any point during this change.

**Amendment 2 (2026-08-09) — §7 and §8 name Regime 1 as the headline verdict, in advance.** §7 said
"Splits, both reported" and §8 carried one unqualified Verdict row; neither said which regime's band
is _the_ answer when the two disagree, and choosing after seeing both numbers is the exact move this
document exists to prevent. The harness commits to **Regime 1 (new post, known creator, per-creator
temporal split)** as the headline, in code (`research/eval/cli.py`'s `HEADLINE_REGIME`), and records
the attribution in `results.json` as `verdict_regime` alongside `verdict`. §8 now carries a Regime 1
verdict row, marked headline, and a separate Regime 2 verdict row, reported and binding but not
headline. **Attestation:** made before any cohort data existed; the two regimes can legitimately
disagree on synthetic worlds by construction, which is what surfaced the gap this amendment closes.

**Amendment 3 (2026-08-09) — §9 gains the measured control false-positive rates.** Two of the three
negative controls fire on _clean_ synthetic data at double-digit rates (see §9's new bullet for the
numbers). Neither threshold (`SHUFFLE_TOLERANCE`, `BRAIN_AVERAGE_CEILING`) was changed — disclosure,
not adjustment, is what a pre-registration commits to. **Attestation:** measured entirely on the
harness's own synthetic null/signal worlds across 30-seed and 20-seed sweeps; no cohort exists to
have leaked into this measurement, and none had been observed.

**Amendment 4 (2026-08-09) — §8 reports all three controls, not one.** §8's results table asked only
"Label-shuffle control passed?", but the harness gates the run on **three** controls —
`label_shuffle`, `brain_average` and `feature_label_leak` (`research/eval/controls.py`) — the third
added during implementation to close a leakage class (a feature column that literally _is_ the label)
that the label-shuffle permutation test cannot detect by construction, because permuting the label
destroys the model's ability to exploit that column exactly as much whether or not the association
was a real leak. §8 now carries one row per control. **Attestation:** the third control was designed,
implemented and tested against synthetic worlds only, before any cohort existed.
