# Pre-Registration — "Do neuro-features earn their cost?"

> **Committed 2026-08-08, before any cohort was recruited and before any test-set result was
> observed.** This is the commitment artifact required by
> [`validation-experiment-spec.md`](validation-experiment-spec.md) §2. The spec is the method; this
> file is the part that has to be dated and frozen for the result to mean anything.
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

| Outcome    | Criterion                                                                                            | Committed action                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Green**  | B3 beats `max(B1, B2)` by **Δρ ≥ 0.10**, significant across creators (**p < 0.05**, paired Wilcoxon) | Thesis validated. Build the calibration head; use the number for the raise                     |
| **Yellow** | Positive but Δρ < 0.10, or not significant                                                           | Iterate features / labels / cohort and **re-run under a new pre-registration**                 |
| **Red**    | No lift over metadata+text (95% CI on the uplift includes 0)                                         | Neuro-features are not earning their GPU cost — pivot the technical story before scaling spend |

Committing to the **Red** action in advance is the only thing that makes Green mean anything.

## 7. Cohort, splits and leakage rules

**Cohort.** ~50 YouTube creators × ~40 posts ≈ 2,000 posts. Owner-authorized channels only. Minimum
posts per creator: **20** (below that, within-creator rank statistics are noise). Diversity across
niche, length and follower tier. Shorts and long-form are modeled separately, never mixed.

**Inclusion.** A per-video view threshold, fixed before collection, below which retention curves are
too noisy to use. Posts are excluded on view count alone — never on how well they scored.

**Splits, both reported.**

- **Regime 1 — new post, known creator:** per creator, temporal split; train on older posts, test on
  the most recent 20%.
- **Regime 2 — new creator:** grouped hold-out; entire creators held out of training.

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

| Field                               | Value       |
| ----------------------------------- | ----------- |
| Date collection started             | `[FILL IN]` |
| Date results first observed         | `[FILL IN]` |
| Creators / posts actually analyzed  | `[FILL IN]` |
| B1 ρ (95% CI)                       | `[FILL IN]` |
| B2 ρ (95% CI)                       | `[FILL IN]` |
| **B3 ρ (95% CI)**                   | `[FILL IN]` |
| B4 ρ (95% CI)                       | `[FILL IN]` |
| **Uplift B3 − max(B1,B2) (95% CI)** | `[FILL IN]` |
| p (paired Wilcoxon across creators) | `[FILL IN]` |
| Pairwise accuracy (secondary)       | `[FILL IN]` |
| Label-shuffle control passed?       | `[FILL IN]` |
| **Verdict (Green / Yellow / Red)**  | `[FILL IN]` |

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
