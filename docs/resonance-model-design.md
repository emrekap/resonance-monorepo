# Resonance — From Brain-Encoding to Engagement: Model & Product Design Notes

> **Status:** design discussion, pre-implementation (2026-08-02). Captures how we turn
> raw TRIBE v2 brain-encoding output into a trustworthy, calibrated, user-facing product.
> Framed as an engineering design review — opinionated, with the honest caveats called out.

**The reframe to start with:** the model is the easy part. The label is the hard part.
TRIBE + a prediction head is a few weeks of work; defining a clean, confounder-free target
and getting the data to train it is the whole game. Keep that ratio in mind throughout.

---

## 0. What the raw model actually outputs (grounding)

TRIBE v2 does **not** output "engagement." It outputs a predicted **fMRI brain-activation
tensor**: `[timesteps × ~20,484 cortical vertices]` on the fsaverage5 surface, values that are
roughly **z-scored BOLD amplitudes** — dimensionless deviations from baseline. Positive = a
cortical location predicted to activate above average at that moment; negative = below.

The scalar summaries we currently print are crude reductions of that tensor:

- **`global_mean`** — average over all vertices and time; near zero _by construction_. Tells users
  essentially nothing. Internal sanity check only.
- **`global_std`** — spread of responses; higher ≈ more differentiated brain activity (a weak
  "dynamism" proxy).
- **`global_min` / `global_max`** — strongest predicted suppression/activation anywhere in
  space-time. Noisy peaks.
- **Segments / `n_events`** — **input** metadata (transcript/audio/scene events per ~1 s window),
  i.e. content density/pacing — not an outcome.
- **`mean_activation_per_timestep`** — average response per time point, i.e. a **curve over the
  timeline**. Closest thing to a usable signal — but see the caveat below.

**Two traps before any UI design:**

1. **Never show a creator a z-score.** These are dev telemetry.
2. **The _global_ signal is the weakest one.** Independent research (arXiv 2607.01400) shows a
   naive brain-wide average does **not** predict engagement; the signal lives in _specific_
   regions and only becomes "engagement" after calibration on real behavioral data.

---

## 1. Product representation — how users should see it

### 1a. Axis → brain-network mapping (and how defensible each is)

Load-bearing caveat: **fsaverage5 is a cortical _surface_ — no subcortical structures.** The
actual emotion/reward/memory centers (amygdala, ventral striatum/nucleus accumbens, hippocampus)
are **not in this output at all.** So any "emotion" or "memorability" axis is built from _cortical
proxies_, not the real circuitry. That fact sets the defensibility tiers.

Parcellate vertices with a standard atlas, then roll parcels up into product axes.

> **Settled since, and shipped:** the atlas is **Schaefer-2018, 400 parcels, 17 networks**, on
> fsaverage5 — not the Yeo-7 this note first proposed. Schaefer's 17-network solution is a refinement
> of Yeo's, so the network vocabulary below is unchanged; what it buys is the sub-parcel split that
> makes two of these axes measurable at all. Yeo-7 collapses auditory cortex into one Somatomotor
> network that also carries hand and foot motor, so an "audio engagement" score off it is mostly
> dilution — the 17-network solution exposes `SomMotB_Aud` (Heschl's/STG) on its own. Same story for
> language, which needs Temporo-parietal and Default-B separated from the rest of Default.
> The mapping is committed and reviewable in
> [`apps/ml/atlas/axis_map.py`](../apps/ml/atlas/axis_map.py); the reasoning is in
> [`superpowers/specs/2026-08-07-analysis-insights-design.md`](superpowers/specs/2026-08-07-analysis-insights-design.md)
> §"Decision 3". Glasser remains the option if auditory/language parcels ever need to be finer still.

| Product axis (user sees)     | Cortical networks / regions                                 | Driven by            | Defensibility                                                                    |
| ---------------------------- | ----------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------- |
| **Visual attention**         | Visual net (V1–V4, occipital) + Dorsal Attention (IPS, FEF) | V-JEPA 2 (video)     | **High** — best-predicted region in brain encoding; 1:1 with video input         |
| **Audio engagement**         | Auditory cortex (Heschl's, STG)                             | Wav2Vec-BERT (audio) | **High** — auditory predicts well; direct modality match                         |
| **Clarity / comprehension**  | Language net (L-STG/STS, Broca/IFG, angular gyrus)          | Llama (transcript)   | **Medium** — solid for speech-heavy, weak for non-verbal/music                   |
| **Emotional pull**           | Limbic (OFC, temporal pole), vmPFC                          | all three, weakly    | **Low** — real reward centers are subcortical and _absent_; cortical shadow only |
| **Memorability / narrative** | Default Mode Net (mPFC, PCC/precuneus, angular)             | text + video         | **Low/aspirational** — memory encoding needs hippocampus, not on the surface     |

Honest read: **ship the top two as real, the third as "good enough," gate the bottom two behind a
"beta" label** until validated against actual engagement. Even for strong axes, trust comes from
the calibration head showing the feature correlates with an outcome — the brain-region story is the
_explanation_, the data is the _proof_.

### 1b. Result-screen hierarchy (mobile)

```text
┌─────────────────────────────────────┐
│  ‹ back            dogg1.mp4     ⋯   │
│  ┌───────────────┐                   │
│  │   ▶ thumbnail │   RESONANCE       │
│  │      0:04     │      72           │  ← big number, colored
│  └───────────────┘   ● Strong        │
│   Top 18% of your recent posts       │  ← relative, honest framing
├─────────────────────────────────────┤
│  ATTENTION OVER TIME                 │
│   ╱‾‾╲        ╱‾╲                     │
│  ╱    ╲__╱‾╲_╱   ╲___                 │  ← scrubbable curve under video
│  0s   1s   2s   3s   4s              │
│  ▲ hook lands 0:02   ▼ dip 0:03      │  ← plain-language markers
├─────────────────────────────────────┤
│  WHY                                 │
│  Visual attention  ████████░░  High  │
│  Audio             ██████░░░░  Med   │
│  Clarity           ███████░░░  High  │
│  Emotional pull    ████░░░░░░  beta  │  ← labeled beta = low-confidence
├─────────────────────────────────────┤
│  DO THIS                             │
│  • Front-load the payoff — first     │
│    second is your weakest.           │
│  • Trim the 0:03 dip (~1s).          │
│  • Audio energy fades — punch it up. │
├─────────────────────────────────────┤
│   [ Compare a variant ]  [ Details ] │  ← raw stats live behind "Details"
└─────────────────────────────────────┘
```

Reading order is deliberate: **verdict → timeline → why → what to fix.** Raw stats live entirely
behind **Details**. Three commitments: (1) **relative before absolute** framing; (2) **confidence
is visible** (the `beta` tag keeps trust when an axis is wrong); (3) the timeline is
**region-weighted** (Visual/Audio/Language), never the debunked flat global average.

---

## 2. The calibration head — the actual ML system

### 2a. Features (X) — use the representation, not the brain tensor

Don't feed the `[T × 20,484]` predicted-fMRI tensor into the head; that's the model's _output_ and
the object shown not to predict engagement in aggregate. Use a **feature hierarchy**:

1. **Fused latent (best).** TRIBE fuses V-JEPA2 + Wav2Vec-BERT + Llama through a transformer
   _before_ projecting to brain space. The per-timestep fused hidden states carry more than what
   survives projection to 20k vertices. Pool (mean/max/attention) for clip-level; keep per-timestep
   for the timeline.
2. **Network-aggregated brain predictions (interpretable).** Roll the ~20k vertices into networks →
   `[networks × T]`. Lower power than the latent, but this powers the explainable "why" axes. This is
   the one rung that ships today: `apps/ml/parcellation.py` reduces the tensor to the five product
   axes of §1a per segment, and the per-axis curves are what the result screen's timeline draws.
3. **Content/pacing metadata (cheap).** `n_events`, cut density, speech rate, loudness, captions,
   duration. A strong baseline on its own (matters — see §2f).

Concatenate pooled-latent + network-time summaries + metadata. Extract at **two granularities**:
clip-level (pooled) for scalar outcomes, per-timestep for the retention curve (the defensible one).

### 2b. Labels (Y) — where it's won or lost

Raw counts are **dominated by confounders**: a 2M-follower creator gets 50k likes on garbage. Train
on raw likes → you learn _follower count_, not _content quality_. Three commitments:

- **(a) Always relative, never absolute.** Model engagement relative to the creator's own baseline:
  engagement-rate = interactions / impressions, or within-creator z-score. Formally, treat the
  creator as a **random effect** (hierarchical model) so the head learns the _residual_ content
  explains after who/when/reach. This is also _why_ the product framing is percentile/relative —
  it falls out of the correct statistics, it's not a UX whim.
- **(b) Retention > likes.** Likes are late, sparse, algorithm-mediated. **Watch-time / completion /
  retention** is content-intrinsic (did it _hold attention_?) and aligns with what TRIBE measures.
  Make retention/completion the **primary** label; likes/saves secondary.
- **(c) The golden label is the temporal retention curve.** YouTube's audience-retention graph (and
  replay heatmaps — the arXiv paper's target) is per-second, aligning **row-for-row** with
  per-timestep features. Core problem becomes a clean sequence regression:
  `retention(t) = f(neuro-features(t))` — exactly the "segment-level, calibrated on real data" path
  the paper said might work. Nail this one thing.

### 2c. Training architecture — two heads, ranking over regression

**Two heads on a shared trunk:**

- **Timeline head:** `features(t) → retention(t)`. Small temporal model (temporal-conv / tiny
  transformer / per-segment MLP with context). Loss = correlation + MSE vs. the real curve. The hero
  feature and the defensible one.
- **Scalar head:** `pooled features → relative engagement-rate`.

**Make the scalar head a ranker, not a regressor.** The product needs "is A better than B?" and
"which moment is weakest?" — not "you'll get 40,231 likes." Train pairwise/listwise **within each
creator's own posts**: A out-retained B ⇒ rank(A) > rank(B). Self-normalizing per creator (kills the
follower confounder for free), robust to the noisy target, maps directly to the A/B feature.
Learning-to-rank is the single highest-leverage modeling decision.

**Personalization = hierarchical.** Global shared trunk + creator-specific adaptation (random effect
or lightweight adapter once a creator has enough posts). **Cold-start:** few-post creators fall back
to global + an _audience-similarity_ cohort (follower profile → nearest creators). Graceful
degradation: global → cohort → personalized as data accrues.

**Multi-task it.** Jointly predict retention, likes-rate, save-rate off the shared trunk — better
data efficiency, plus per-outcome explainability ("high retention, low saves → engaging but not
memorable").

### 2d. The flywheel — mechanically, and why backfill is the unlock

When a user connects IG/TikTok/YouTube:

1. **Backfill is the goldmine.** Pull their last N posts _and_ each post's analytics. 200 posts =
   **200 labeled examples the instant they connect**, before they ever use the predictor. Breaks the
   chicken-and-egg (predictor needs data; data needs users); no waiting for new posts.
2. **Feature extraction:** run each historical post through TRIBE → features. (Real cost: GPU
   inference per post; batch it. A line item: creators × posts × GPU seconds.)
3. **Train/adapt:** update global trunk + fit creator adapter.
4. **Continuous loop:** every new post + realized performance = a fresh (features, label) pair →
   online learning, _and_ a measured predicted-vs-actual accuracy number (model monitoring +
   marketing/fundraising proof in one).

The compounding asset (the moat, stated precisely): a growing corpus of **(neuro-feature,
real-outcome) pairs across creators, niches, and audiences** that nobody without account-connected
creators can assemble.

### 2e. Pitfalls for the design-review slide

- **Confounder domination** → within-creator relative labels + creator random effects.
  Non-negotiable.
- **Label availability & ToS.** YouTube Analytics API gives retention; **TikTok/IG are stingy,
  rate-limited, and ToS-restricted** on analytics. A genuine dependency risk — golden-label quality
  depends on API access you don't fully control. De-risk early; fallback = completion rate +
  engagement counts.
- **Distribution shift.** TRIBE was trained on adults watching _movies in a scanner_. Short-form
  vertical UGC (fast cuts, faces, captions, trending audio) is a different distribution. Encoders may
  transfer; brain-calibration may not. Validate on-domain.
- **Selection bias.** You only see _published_ posts, never the ones creators killed. Label
  distribution is truncated. Within-published ranking mitigates but doesn't erase it.
- **Causality vs. luck.** The algorithm decides _who sees_ a post; identical posts vary 10× on
  timing/luck. You predict a partly-exogenous, noisy target → predict a **propensity/distribution,
  not a guarantee.** Reinforces ranking + percentile over point estimates.
- **Goodhart/feedback.** Once creators optimize to the score, the score↔reality link drifts. Monitor
  calibration over time.
- **Small-n creators.** Most have <50 posts. Personalization must degrade to cohort/global.
- **The axis→network mapping is unvalidated.** Open, and worth stating plainly because everything in
  §1a rests on it: the shipped parcellation asserts the atlas has the expected number of vertices,
  but **its vertex order has never been checked against real anatomy.** A transposed or
  differently-ordered surface would still average to plausible-looking numbers on every axis — the
  failure is silent by construction. The cheap check is a high-motion clip, which should light the
  visual band and little else; until one has run, treat the five axes as wired-up rather than
  verified. Tracked in `CLAUDE.md`'s TODO.

### 2f. How we know it's real — baselines + the killer experiment

**Baselines TRIBE must beat** (or the neuroscience isn't earning its cost): (1) creator's historical
mean; (2) metadata-only (length, hashtags, time, followers); (3) caption/text-only; (4) Opus-style
heuristic. If neuro-features don't beat "metadata + text," know it in week 3, not month 9.

**Metrics:** within-creator Spearman (predicted vs. actual retention/engagement); per-second
correlation for the timeline; top-k precision for "did we pick the better variant?"

**The killer experiment (also the fundraising proof):** hold out each creator's most recent posts,
predict, compare to actual. One honest number — "we rank your next posts' retention at ρ ≈ 0.6
within-creator" — beats any deck slide.

---

## 3. MVP vs. coming-soon

Prioritized by (a) neuro-predictability, (b) label availability, (c) tolerance to model noise.

**Ship in MVP (high confidence):**

- **Attention timeline** — the hero (Visual+Audio+Language), validated against retention. Robust
  even when the absolute score is shaky; "where does attention drop" is defensible + actionable.
- **Variant A/B ranking** — _the tip of the spear._ Ranking is the most defensible use of a noisy
  model and sidesteps absolute calibration entirely.
- **Visual attention** + **Audio engagement** axes — best-predicted regions, direct modality match.
- **Relative Resonance Score** (percentile vs. the creator's backfilled history) — relative, never
  absolute.

**Fast-follow (medium):**

- **Clarity/comprehension** axis — ship for speech-heavy content, suppress for music/non-verbal.
- **Absolute 0–100 score** — only after calibration shows decent cross-cohort within-creator
  correlation.

**Coming-soon / beta (low, honesty-gated):**

- **Emotional pull** — cortical proxy only; reframe as "emotional tone," label beta, validate hard.
- **Memorability** — needs rewatch/replay longitudinal data + hippocampal proxies you don't have on
  the surface. Park it.

**Sequencing logic:** the MVP leans on the axes the literature predicts _best_ (visual/audio) and
the product uses that tolerate model noise _best_ (ranking, relative, timeline). It defers the
neuroscientifically weakest axes (emotion/memory) and the least-defensible framing (absolute scores),
and it's designed to be **useful at low data** — timeline and A/B ranking work off a global/cohort
model before per-creator personalization kicks in — then sharpens as the flywheel spins.
Scientifically honest and product-smart turn out to be the same ordering.

---

## 4. Highest-value next drill-downs

- **Per-platform data contract** — exact fields pullable from YouTube/TikTok/IG APIs, ToS limits,
  and which become the label vs. the fallback.
- **Validation experiment spec** — how to run the "beat the baselines" test on the first cohort to
  produce a real accuracy number for the raise.
