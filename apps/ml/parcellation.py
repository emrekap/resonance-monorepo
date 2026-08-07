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


def clip_means(bands: np.ndarray) -> dict[str, float]:
    """Collapse the per-segment bands to one scalar per axis for the whole clip.

    These are what `apps/worker` ranks against the creator's history. An empty
    clip yields zeros rather than NaN — a NaN would propagate into a percentile
    and land in the database as a null nobody could explain.
    """
    if bands.size == 0:
        return {axis: 0.0 for axis in AXES}
    return {axis: float(bands[:, index].mean()) for index, axis in enumerate(AXES)}
