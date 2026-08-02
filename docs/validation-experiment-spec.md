# Validation Experiment Spec — "Does the neuroscience earn its cost?"

> **Status:** experiment design, pre-implementation (2026-08-02). Drill-down of §4 of
> [resonance-model-design.md](resonance-model-design.md); consumes the labels defined in
> [platform-data-contract.md](platform-data-contract.md). Purpose: produce **one honest,
> pre-registered accuracy number** proving (or refuting) that TRIBE-derived neuro-features predict
> engagement better than cheap baselines — the core technical de-risking for the raise.

**The one-liner we want to be able to say:** _"On a held-out cohort, TRIBE features rank a creator's
next posts by retention at Spearman ρ = Y, beating a metadata+text baseline (ρ = X) by Δ, 95% CI
[...], p < 0.01 — and pick the better of two posts N% of the time."_

If we can't beat metadata+text, the neuroscience isn't earning its GPU cost, and we want to know that
in **week 3, not month 9.**

---

## 1. Falsifiable hypothesis

**H1 (primary):** neuro-features from TRIBE improve _within-creator_ prediction of engagement/
retention over the best simple baseline (metadata + caption text), by a pre-registered margin, with
significance clustered at the creator level.

**H0 (null):** TRIBE features add no lift beyond metadata + text.

Everything below is designed to make H1 genuinely falsifiable — no moving goalposts.

---

## 2. Pre-registration (do this before touching results)

Lock these **before** looking at any test-set outcome, and store them in the repo with a timestamp:

- The **primary metric** and the **single primary task** (below).
- The **baseline** we must beat and the **success margin** (§9).
- The **cohort inclusion criteria** and **splits** (§4, §7).

This is both scientific hygiene (kills p-hacking) and a diligence asset — a dated pre-registration
that we then meet is far more convincing to a technical investor than a cherry-picked chart.

---

## 3. Cohort & data

**YouTube-first** — it is the only source of the temporal golden label (`audienceWatchRatio`, see the
data contract). Instagram/TikTok come later for scale.

- **Size (ballpark, refine with a power analysis in §8):** ~**50 creators × ~40 posts ≈ 2,000 posts.**
  Rationale: within-creator rank stats need **≥20 posts/creator**; cold-start generalization needs
  **≥30 distinct creators**.
- **Diversity:** span niches (talking-head, vlog, tutorial, entertainment), lengths, and follower
  tiers, so results aren't a single-genre artifact.
- **Inclusion:** owner-authorized channels (OAuth), videos with enough views for stable retention
  curves (drop ultra-low-view posts where the curve is noise), exclude Shorts vs. long-form mixing
  unless modeled separately (different retention dynamics).
- **What we pull:** per post → the **video file** (for TRIBE features — note the acquisition caveat in
  the data contract) + the **retention curve** + scalar analytics + metadata.

---

## 4. The two prediction tasks

- **Task A — Ranking (PRIMARY).** Within each creator, rank their posts by an engagement/retention
  outcome. This mirrors the MVP hero feature (A/B + "top X% of your posts") and is the most
  noise-robust use of the model. **Primary label:** `averageViewPercentage` (completion) and/or a
  within-creator-normalized engagement-rate.
- **Task B — Timeline (SECONDARY).** Predict the per-second retention curve `retention(t)` from
  per-timestep features. **Label:** YouTube `audienceWatchRatio` × `elapsedVideoTimeRatio`. This is
  the scientifically novel claim (segment-level, calibrated) but rides on YouTube-only data.

Lead the raise narrative on **Task A** (robust, product-legible); use **Task B** as the "and it works
temporally too" proof.

---

## 5. Model ladder (what we compare)

Each rung adds information; the treatment must beat the cheap rungs.

| ID     | Model                                                                    | Purpose                          |
| ------ | ------------------------------------------------------------------------ | -------------------------------- |
| **B0** | Creator historical mean (predict every post = their average)             | Null floor                       |
| **B1** | Metadata only (length, hashtags, post time, follower count, day-of-week) | Cheap confounders                |
| **B2** | Caption/title text embedding                                             | Language-only baseline           |
| **B3** | **TRIBE neuro-features (treatment)**                                     | The hypothesis                   |
| **B4** | TRIBE + metadata + text (full model)                                     | Ceiling / does neuro add on top? |

**Ablations within B3** (to find _what_ carries signal): fused latent vs. network-aggregated (Yeo-7)
vs. raw brain tensor; and per-modality (video-only / audio-only / text-only encoders). The key
scientific result is **B3 > B1, B2** and **B4 > B1+B2 combined** — i.e. neuro-features add
_orthogonal_ signal, not a restatement of metadata.

---

## 6. Evaluation protocol (where experiments secretly die)

Two regimes, both reported:

- **Regime 1 — new post, known creator (personalization):** for each creator, temporal split — train
  on older posts, test on the **K most recent** (e.g. last 20%). Mirrors production ("score my next
  post") and blocks temporal leakage.
- **Regime 2 — new creator (cold start):** **grouped** hold-out — entire creators held out of
  training. Tests whether the global/cohort model generalizes to someone who just signed up.

**Leakage rules (non-negotiable):**

- Features come **only** from the video, never from anything post-publication.
- Within-creator normalization statistics are fit on **train only** and applied to test (fitting them
  on all data leaks the outcome distribution — classic trap).
- No creator appears in both train and test in Regime 2.
- Time-order respected in Regime 1 (never train on a post published after the test post).

---

## 7. Metrics (pre-registered)

**Task A (primary):**

- **Within-creator Spearman ρ** (predicted vs. actual), averaged over creators — the headline.
- **Pairwise accuracy / AUC** — "given two of a creator's posts, do we pick the higher performer?"
  This is the most **investor-legible** number ("we pick the better post N% of the time").
- **Top-1 / top-k** — do we identify the creator's best post(s)?

**Task B (secondary):**

- **Per-second Pearson/Spearman** between predicted and actual retention curve, averaged.
- **Dip localization** — is the largest predicted drop within **±1 s** of the real one? (Directly
  validates the "trim the 0:07 dip" product claim.)

**Always report as UPLIFT over baseline** (B3 − B1, B4 − B2, …) with confidence intervals — the delta
is the story, not the absolute number.

---

## 8. Statistical analysis

- **Unit of analysis = the creator, not the post.** Posts within a creator are correlated; treating
  them as independent inflates significance. Average the metric per creator, then aggregate across
  creators.
- **Confidence intervals:** bootstrap **over creators** (resample creators, recompute) → 95% CI on
  each metric and on the uplift.
- **Significance:** paired test across creators (Wilcoxon signed-rank / permutation) on per-creator
  uplift B3−B1. Correct for multiple comparisons if we test multiple axes/labels.
- **Power analysis (do first):** given expected effect size (target Δρ ≈ 0.1–0.15) and creator-level
  variance, confirm ~50 creators gives adequate power; adjust N up if not.

---

## 9. Go / no-go (pre-registered thresholds)

| Outcome    | Criterion                                                                                                              | Action                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Green**  | B3 beats the best of {B1,B2} by **Δρ ≥ 0.10** _or_ pairwise accuracy **≥ 65%**, significant across creators (p < 0.05) | Thesis validated — build; use the number for the raise                                      |
| **Yellow** | Positive but sub-threshold / not significant                                                                           | Iterate features (latent vs. network), labels (retention vs. engagement), or cohort; re-run |
| **Red**    | No lift over metadata+text (CI includes 0)                                                                             | Neuro-features aren't earning their cost — pivot the technical story before scaling spend   |

Committing to the **Red** action in advance is what makes this honest rather than theater.

---

## 10. Validity & negative controls

- **Confounder isolation:** because length/time/followers live in B1, any B3 > B1 win is signal
  _beyond_ those confounders. Additionally regress them out and confirm the win survives.
- **Label-shuffle negative control:** permute outcomes within creator → all models should collapse to
  chance. If B3 still "predicts," there's leakage — stop and fix.
- **Replicate the known negative result:** confirm the **naive global brain-drive** baseline fails
  (per arXiv 2607.01400) and that **region-weighted latent** features beat it. This turns a
  literature risk into a demonstrated differentiator.
- **Distribution-shift check:** report performance separately for short-form vs. long-form; TRIBE was
  trained on movies, and we need to see it holds on UGC, not assume it.

---

## 11. Cost & timeline (rough)

1. Recruit + OAuth ~50 YouTube creators; backfill posts + analytics. _(Depends on API access — the
   main external dependency.)_
2. Acquire video files (see data-contract caveat) + run TRIBE feature extraction. **GPU line item:**
   ~2,000 posts × inference seconds — batch on the L4/A10G stack; this is the dominant compute cost.
3. Train the ladder, run both regimes, bootstrap, write up.

Target: **a defensible number in ~3–5 weeks**, dominated by cohort recruitment and backfill, not
modeling.

---

## 12. Deliverables (the diligence artifact)

- A **dated pre-registration** (metric, baseline, threshold) committed before results.
- A **reproducible eval harness** (fixed splits, seeds) so the number can be re-run in diligence.
- A **one-page result:** headline ρ / pairwise-accuracy with CIs, the uplift-over-baseline table, one
  retention-curve overlay (predicted vs. actual), and the go/no-go call.

---

## 13. Threats to validity (state them, don't hide them)

- **Selection bias:** only _published_ posts are observed; killed drafts are invisible → truncated
  label range. Within-published ranking mitigates, doesn't remove.
- **Algorithmic luck:** distribution/timing confounds "content quality"; the target is partly
  exogenous → we validate a _propensity_, not a guarantee (why ranking > point estimates).
- **Small-n creators:** thin-history creators weaken within-creator stats; report metrics vs.
  posts-per-creator.
- **YouTube-only golden label:** Task B generalization to IG/TikTok is unproven until those platforms'
  (weaker) labels are tested.
- **Label noise:** retention curves are stable only above a view threshold; enforce it in inclusion.
