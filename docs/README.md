# Resonance — Docs Index

Product and technical notes for **Resonance**, the content-resonance prediction product built on
the TRIBE v2 brain-encoding service in this repo ([../apps/ml/](../apps/ml/)). Start with the
one-pager for the pitch; the four technical notes form a design appendix that reads in order.

## Investor-facing

- **[investor-one-pager.md](investor-one-pager.md)** — the pitch: problem, solution, market, model,
  and the $600K pre-seed ask. Creator-led / brand-monetized, usage-based credits.
- **[investor-one-pager.html](investor-one-pager.html)** — the same content in a styled single-page
  layout; open in a browser and Print → Save as PDF for an investor-ready one-pager. It is a
  **hand-maintained twin**, not generated from the Markdown — nothing checks that the two agree, so
  **change one, change the other.**

## Technical appendix (read in this order)

1. **[resonance-model-design.md](resonance-model-design.md)** — how we turn raw TRIBE brain-encoding
   output into a trustworthy product: what the model actually emits, the axis→brain-network mapping,
   the result-screen UX, and the calibration head (features, labels, training, data flywheel,
   pitfalls, MVP vs. coming-soon).
2. **[platform-data-contract.md](platform-data-contract.md)** — exactly which fields YouTube /
   Instagram / TikTok expose, which become the training **label** vs. **fallback**, and the
   access/ToS constraints. Headline: the temporal golden label (retention curve) is YouTube-only.
3. **[validation-experiment-spec.md](validation-experiment-spec.md)** — the pre-registered experiment
   to prove neuro-features beat cheap baselines and produce one honest accuracy number for the raise.
4. **[validation-prereg.md](validation-prereg.md)** — the dated pre-registration the spec's §2
   requires: metric, baseline, threshold and splits, locked before any test-set result is seen. The
   spec is the method; this is the commitment.

## Build records

`superpowers/` holds the dated design + implementation records for work that has since shipped.
These are **archival**: each captures a decision at a point in time and is deliberately not updated
as the code moves on. Read them for _why_ something is shaped the way it is; read the code and the
app READMEs for what it does today.

- `superpowers/specs/` — design docs (mobile design system, analysis history, realtime, insights,
  ml TDD)
- `superpowers/plans/` — the implementation plans executed from them

The one that most often matters: **[`superpowers/specs/2026-08-07-analysis-insights-design.md`](superpowers/specs/2026-08-07-analysis-insights-design.md)**
settles the atlas (Schaefer-2018 17-network) and the axis→network mapping, amending §1a of the model
design note.

## Status

The first three technical notes were written **pre-implementation (2026-08-02)** and remain the
design rationale rather than a description of the running system; the pre-registration is later
(**2026-08-08**) and is a live commitment, not a design note. Where a note has been overtaken, it
says so inline. Two things have since shipped and are worth reading against the code:

- **§1a's atlas** is now Schaefer-2018 17-network, not the Yeo-7/17 the note first proposed —
  see `apps/ml/atlas/axis_map.py`.
- **§2's calibration head does not exist.** The shipped `resonanceScore` is a rank against the
  workspace's own prior analyses (`apps/worker/src/scoring.ts`), which needs no calibration and makes
  no absolute claim. The head in §2 is still the plan; the validation that would justify it is
  specified in the experiment spec and pre-registered in
  [`validation-prereg.md`](validation-prereg.md).

**Two different placeholder conventions, so don't go looking for the wrong one.**

- `[FILL IN]` appears only in the **results table** of
  [`validation-prereg.md`](validation-prereg.md) §8. Those are meant to stay empty until the
  experiment runs — an unfilled row there is the point, not an oversight.
- The one-pager marks its open item in **HTML only**, as a dashed amber chip
  (`<span class="fill">`). Exactly one is left: the **final product name** in the subline. Every
  other surface — this repo, the app, the model design note — already says "Resonance", so the chip
  is a decision to confirm rather than a blank. The Markdown twin has no equivalent marker; if you
  edit one, edit both.

The **team** section is one founder and no hires, and now reads as written rather than as a
placeholder.
