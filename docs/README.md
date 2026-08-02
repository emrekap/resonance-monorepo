# Resonance — Docs Index

Product and technical notes for **Resonance**, the content-resonance prediction product built on
the TRIBE v2 brain-encoding API in this repo ([../apps/ml/main.py](../apps/ml/main.py)). Start with the one-pager
for the pitch; the three technical notes form a design appendix that reads in order.

## Investor-facing

- **[investor-one-pager.md](investor-one-pager.md)** — the pitch: problem, solution, market, model,
  and the $600K pre-seed ask. Creator-led / brand-monetized, usage-based credits.
- **[investor-one-pager.html](investor-one-pager.html)** — same content, styled single-page layout;
  open in a browser and Print → Save as PDF for an investor-ready one-pager.

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

## Status

All docs are **design/research notes, pre-implementation** (dated 2026-08-02), grounded in the
current TRIBE v2 API prototype. Placeholders (team, final product name) are marked `[FILL IN]`.
