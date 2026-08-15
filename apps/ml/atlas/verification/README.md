# Atlas verification record — 2026-08-15

The `analysis.succeeded` queue payloads from the run that verified the atlas's
vertex order against real anatomy (the check `docs/resonance-model-design.md`
§2e and `docs/validation-prereg.md` Amendment 5 describe). Committed because
they are the evidence behind a claim the product now stands on, and an
evidence file in a gitignored `out/` directory rots.

Three stimuli, all synthetic or open-licence, run on the deployed
`facebook/tribev2` checkpoint (HF Space, L4) through the production
`[analysis]` → `[analysis-results]` queue path:

| file                 | stimulus                                                                   |
| -------------------- | -------------------------------------------------------------------------- |
| `motion-queue.json`  | 8 Hz drifting checkerboard, silent audio track                             |
| `speech-queue.json`  | black screen, macOS `say` narration                                        |
| `natural-queue.json` | Big Buck Bunny 6:00–6:48, audio silenced (© Blender Foundation, CC-BY 3.0) |

Re-derive the verdict without a GPU:

```bash
cd apps/ml && python scripts/check_atlas_anatomy.py --from-queue atlas/verification
```

The verdict is a cross-stimulus double dissociation on per-clip-centered
bands: visual is the top band only on the visually-rich clip; audio is the top
band on the speech clip and the bottom band on the silenced one. A permuted
vertex order cannot produce it — permuted masks all average the same mixture,
so every band moves together across clips. The checkerboard is retained as the
record of a finding, not a passing arm: it scored below baseline on every band,
because a movie-trained encoder scores stimulus typicality, not physiology.
