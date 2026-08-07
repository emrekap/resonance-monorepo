"""Build the checked-in cortical atlas that turns TRIBE's vertex tensor into product axes.

Run this once; commit the artifact. Nothing at runtime downloads anything.

    python scripts/build_atlas.py

Source: the **Schaefer 2018 400-parcel / 17-network** parcellation on the
fsaverage5 surface (Yeo lab, CBIG). Two reasons it is the source rather than the
raw Yeo-17 annot:

1. Every parcel name carries its 17-network assignment (`17Networks_LH_SomMotB_Aud_1`),
   so `atlas/axis_map.py` is auditable against the data instead of against a
   separate lookup table nobody can check.
2. It is *sub-parcelled*. The audio axis needs auditory cortex specifically
   (`SomMotB_Aud` — Heschl's / STG), not the whole somatomotor network, which
   also covers hand and foot motor cortex. At the 17-network level that
   distinction does not exist, and the audio band would be mostly dilution.
   This is the same reason the design doc chose 17 networks over 7.

The artifact stores **parcel ids**, not axis ids: the mapping to product axes is
a runtime concern in `axis_map.py`, so changing it is a code review rather than a
regenerated binary.
"""

from __future__ import annotations

import sys
import tempfile
import urllib.request
from pathlib import Path

import numpy as np

# fsaverage5 has exactly this many vertices per hemisphere. Asserted rather than
# inferred: a mismatch means the source moved to a different surface, and every
# downstream number would be silently wrong rather than loudly broken.
VERTICES_PER_HEMISPHERE = 10_242

_CBIG_BASE = (
    "https://raw.githubusercontent.com/ThomasYeoLab/CBIG/master/stable_projects"
    "/brain_parcellation/Schaefer2018_LocalGlobal/Parcellations/FreeSurfer5.3"
    "/fsaverage5/label"
)
_ANNOT = "{hemi}.Schaefer2018_400Parcels_17Networks_order.annot"

OUTPUT = Path(__file__).resolve().parent.parent / "atlas" / "schaefer400_17networks_fsaverage5.npz"


def _read_hemisphere(directory: Path, hemi: str) -> tuple[np.ndarray, list[str]]:
    """Download one hemisphere's annotation and return (labels, parcel names)."""
    import nibabel.freesurfer.io as fsio

    destination = directory / f"{hemi}.annot"
    url = f"{_CBIG_BASE}/{_ANNOT.format(hemi=hemi)}"
    print(f"  fetching {hemi} … ", end="", flush=True)
    urllib.request.urlopen(url, timeout=120)  # fail fast on a 404 before writing
    urllib.request.urlretrieve(url, destination)

    labels, _ctab, raw_names = fsio.read_annot(destination)
    names = [name.decode() for name in raw_names]

    if labels.shape != (VERTICES_PER_HEMISPHERE,):
        raise SystemExit(
            f"{hemi}: expected {VERTICES_PER_HEMISPHERE} vertices, got {labels.shape[0]}. "
            "The source is not fsaverage5 and would not align with TRIBE's output."
        )

    # nibabel marks unlabelled vertices -1; fold them into the medial wall (0),
    # which axis_map already excludes.
    labels = np.where(labels < 0, 0, labels)
    print(f"{len(names) - 1} parcels")
    return labels.astype(np.int16), names


def build() -> None:
    with tempfile.TemporaryDirectory(prefix="resonance-atlas-") as tmp:
        directory = Path(tmp)
        left_labels, left_names = _read_hemisphere(directory, "lh")
        right_labels, right_names = _read_hemisphere(directory, "rh")

    n_left = len(left_names) - 1  # names[0] is the medial wall, not a parcel

    # Hemisphere-local ids collide (both run 1..200 over *different* parcels), so
    # the right hemisphere is offset. Vertex order is left-then-right, matching
    # how fsaverage5 surfaces are concatenated everywhere downstream.
    right_shifted = np.where(right_labels > 0, right_labels + n_left, 0)
    labels = np.concatenate([left_labels, right_shifted]).astype(np.int16)
    names = [left_names[0], *left_names[1:], *right_names[1:]]

    expected_vertices = VERTICES_PER_HEMISPHERE * 2
    if labels.shape != (expected_vertices,):
        raise SystemExit(f"expected {expected_vertices} vertices, built {labels.shape[0]}")
    if labels.max() != len(names) - 1:
        raise SystemExit(f"highest parcel id {labels.max()} does not match {len(names) - 1} names")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    # Names go in as a native unicode array, never dtype=object: an object array
    # would make the artifact a pickle, and loading it would be arbitrary code
    # execution on a file fetched off the internet.
    np.savez_compressed(OUTPUT, labels=labels, names=np.array(names, dtype=np.str_))

    covered = int((labels > 0).sum())
    print(
        f"\nwrote {OUTPUT.relative_to(OUTPUT.parent.parent)} — "
        f"{expected_vertices} vertices, {len(names) - 1} parcels, "
        f"{covered} covered ({covered / expected_vertices:.1%}), "
        f"{OUTPUT.stat().st_size / 1024:.0f} KB"
    )


if __name__ == "__main__":
    try:
        build()
    except urllib.error.URLError as exc:  # noqa: F821 — urllib.error is imported via urllib
        raise SystemExit(f"could not reach the CBIG atlas source: {exc}") from exc
    sys.exit(0)
