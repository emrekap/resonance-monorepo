"""Which cortical parcels feed which product axis.

This is the one file where neuroscience becomes product, so it is written to be
*checked* rather than trusted: the keys below are the network names that appear
verbatim in the Schaefer 2018 17-network parcel labels, and
`scripts/build_atlas.py` explains where those come from.

Grounding (docs/resonance-model-design.md §1a) — the defensibility of each axis
is not uniform, and the mapping is where that shows:

    visual        Visual + Dorsal Attention. Best-predicted cortex in brain
                  encoding, and a direct match for the video encoder. HIGH.
    audio         Auditory cortex only (`SomMotB_Aud` — Heschl's / STG), NOT the
                  whole somatomotor network, which also covers hand and foot
                  motor. Direct match for the audio encoder. HIGH.
    language      Temporo-parietal + Default-B, the closest surface proxy for the
                  language network. Solid for speech, meaningless without it —
                  which is why apps/worker downgrades CLARITY to BETA when the
                  transcript is empty. MEDIUM.
    emotional     Limbic (OFC, temporal pole). The actual reward circuitry is
                  subcortical and **absent from this surface entirely**; this is
                  a cortical shadow of it. LOW — ships labelled BETA.
    memorability  Default Mode core. Memory encoding needs hippocampus, also not
                  on the surface. LOW — ships labelled BETA.

The two LOW axes still get computed numbers. Having a number does not make a
cortical proxy for a subcortical structure defensible — the BETA label is the
honesty, not the absence of data.
"""

from __future__ import annotations

import functools
from pathlib import Path

import numpy as np

ATLAS_PATH = Path(__file__).resolve().parent / "schaefer400_17networks_fsaverage5.npz"

#: Axis order is load-bearing. It matches `analysis_axis_scores.position` and the
#: `axisBands` field order in `queue_contract.py` / `packages/queue`, so a
#: reordering here silently relabels every axis in the product. Append only.
AXES: tuple[str, ...] = ("visual", "audio", "language", "emotional", "memorability")

#: Axis -> the 17-network names (or sub-parcel prefixes) that compose it.
#: A prefix matches a parcel when it is followed by `_` or ends the name, so
#: `SomMotB_Aud` picks up `SomMotB_Aud_1` and leaves `SomMotB_Cent_1` alone.
AXIS_NETWORKS: dict[str, tuple[str, ...]] = {
    "visual": ("VisCent", "VisPeri", "DorsAttnA", "DorsAttnB"),
    "audio": ("SomMotB_Aud",),
    "language": ("TempPar", "DefaultB"),
    "emotional": ("LimbicA", "LimbicB"),
    "memorability": ("DefaultA", "DefaultC"),
}

_HEMISPHERE_PREFIXES = ("17Networks_LH_", "17Networks_RH_")


def _strip_hemisphere(parcel_name: str) -> str | None:
    """`17Networks_LH_SomMotB_Aud_1` -> `SomMotB_Aud_1`; None for the medial wall."""
    for prefix in _HEMISPHERE_PREFIXES:
        if parcel_name.startswith(prefix):
            return parcel_name[len(prefix) :]
    return None


def _matches(local_name: str, network: str) -> bool:
    return local_name == network or local_name.startswith(f"{network}_")


@functools.lru_cache(maxsize=1)
def load_atlas() -> tuple[np.ndarray, list[str]]:
    """The checked-in parcellation: (int16 labels per vertex, parcel names)."""
    if not ATLAS_PATH.exists():
        raise FileNotFoundError(
            f"atlas missing at {ATLAS_PATH}. Build it once with "
            "`python scripts/build_atlas.py` (it is normally committed)."
        )
    # allow_pickle stays off (the default): the artifact holds only an int16 array
    # and a unicode string array, both natively supported. Anything that needed
    # pickle to load would be a tampered file, and should fail rather than run.
    with np.load(ATLAS_PATH) as data:
        return data["labels"].astype(np.int16), [str(name) for name in data["names"]]


@functools.lru_cache(maxsize=1)
def axis_masks() -> np.ndarray:
    """Boolean `[len(AXES) x n_vertices]` selecting each axis's vertices.

    Built once per process and cached — it depends only on the checked-in atlas.
    """
    labels, names = load_atlas()
    masks = np.zeros((len(AXES), labels.shape[0]), dtype=bool)

    for axis_index, axis in enumerate(AXES):
        networks = AXIS_NETWORKS[axis]
        parcel_ids = [
            parcel_id
            for parcel_id, name in enumerate(names)
            if parcel_id > 0  # 0 is the medial wall
            and (local := _strip_hemisphere(name)) is not None
            and any(_matches(local, network) for network in networks)
        ]
        if not parcel_ids:
            raise ValueError(
                f"axis '{axis}' matched no parcels from {networks}. The atlas and this "
                "mapping have drifted; every score on that axis would be a NaN."
            )
        masks[axis_index] = np.isin(labels, parcel_ids)

    return masks


def n_vertices() -> int:
    return int(load_atlas()[0].shape[0])
