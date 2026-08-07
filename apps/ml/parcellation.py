"""Reduce TRIBE's vertex tensor to the five product axes.

`MODEL.predict` returns `[n_segments x ~20484]` predicted BOLD on the fsaverage5
surface. That is not something a creator can be shown — and the *brain-wide*
average of it is the one summary independent work has shown does NOT predict
engagement (docs/resonance-model-design.md §0). The signal lives in specific
networks, so this module averages within them instead of across all of them.

Everything here is pure and depends only on the checked-in atlas, so it is fully
testable without a GPU or a model — see `tests/test_parcellation.py`.
"""

from __future__ import annotations

import numpy as np

from atlas.axis_map import AXES, axis_masks, n_vertices


def axis_bands(preds: np.ndarray) -> np.ndarray:
    """`[n_segments x n_vertices]` predicted BOLD -> `[n_segments x len(AXES)]`.

    Each column is the mean predicted activation across that axis's vertices, in
    `AXES` order. Values stay in the model's own z-scored BOLD units: they are
    never shown to anyone, only ranked against the same creator's other clips,
    so rescaling here would add a step without adding meaning.
    """
    if preds.ndim != 2:
        raise ValueError(f"expected a 2-D [segments x vertices] array, got shape {preds.shape}")

    expected = n_vertices()
    if preds.shape[1] != expected:
        # A different surface (or a transposed array) would still average to
        # plausible-looking numbers, so this is checked rather than assumed.
        raise ValueError(
            f"expected {expected} vertices per segment (fsaverage5), got {preds.shape[1]}. "
            "The atlas and the model are on different surfaces; every band would be wrong."
        )

    masks = axis_masks()
    bands = np.empty((preds.shape[0], len(AXES)), dtype=np.float64)
    for axis_index in range(len(AXES)):
        bands[:, axis_index] = preds[:, masks[axis_index]].mean(axis=1)
    return bands


#: Fraction of segments the `peak` statistic averages over.
#: A quarter rather than the single highest segment: one TR of a 20 k-vertex
#: prediction is noisy, and a clip should not out-rank another on one lucky
#: frame.
PEAK_FRACTION = 0.25


def clip_summary(bands: np.ndarray) -> dict[str, dict[str, float]]:
    """Collapse the per-segment bands to a few scalars per axis for the clip.

    **Three statistics, not one, and deliberately.** `apps/worker` ranks one of
    them against the creator's history to produce the score, and which one is the
    right choice is an empirical question nobody has answered yet — there is no
    calibration data. Sending all three makes that choice a one-line constant in
    `scoring.ts` (`BAND_SUMMARY`) rather than a change to this file, the queue
    contract and the ML deploy.

    What each one means, and why `mean` alone was not enough:

    ``mean``
        Average response across the clip. TRIBE predicts *z-scored* BOLD, so this
        sits near zero by construction — the same objection
        `docs/resonance-model-design.md` §0 raises against the brain-wide
        average, which is why it is no longer the only thing on the wire.
        Within a network it is less degenerate than brain-wide, but it still
        measures baseline more than content.
    ``std``
        How much the network's response *varied*. The design doc's own
        "dynamism" proxy — a network being driven by the content swings; one
        that is not, does not. Blind to whether the swing was up or down.
    ``peak``
        Mean of the top quarter of segments — how strongly the
        network responded at its best moments. The closest of the three to "did
        the hook land", and robust to a single noisy segment in a way `max` is
        not.

    An empty clip yields zeros rather than NaN: a NaN would propagate into a
    percentile and land in the database as a null nobody could explain.
    """
    if bands.size == 0:
        return {axis: {"mean": 0.0, "std": 0.0, "peak": 0.0} for axis in AXES}

    n_peak = max(1, int(round(bands.shape[0] * PEAK_FRACTION)))

    summary: dict[str, dict[str, float]] = {}
    for index, axis in enumerate(AXES):
        curve = bands[:, index]
        # Partition rather than a full sort — only the top slice is needed.
        top = np.partition(curve, -n_peak)[-n_peak:]
        summary[axis] = {
            "mean": float(curve.mean()),
            "std": float(curve.std()),
            "peak": float(top.mean()),
        }
    return summary
