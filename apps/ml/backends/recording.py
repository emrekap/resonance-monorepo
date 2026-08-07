"""Capture what the real model's output actually looks like.

`backends/synthetic.py` has to assume a dtype and a segment spacing for TRIBE's
predictions, because TRIBE has never run against this repo. Those assumptions are
cheap to settle and expensive to leave: if they are wrong, the whole suite stays
green and production still breaks.

So this decorator wraps *any* backend and writes a small manifest describing what
came out of it. Wrap `TribeBackend` on a GPU box once and the guesses become
checked facts:

    ML_RECORD_DIR=./recordings python worker.py

Being a decorator rather than a flag inside `TribeBackend` is what makes it
testable without a GPU — `tests/test_recording.py` records the synthetic backend.
One code path, no GPU-only branch.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

MANIFEST_NAME = "tribe-shape.json"

#: Members of a segment worth recording — the ones `engine.py` reads.
_SEGMENT_ATTRS = ("start", "duration", "stop", "ns_events")


def build_manifest(preds: np.ndarray, segments: list) -> dict:
    """Describe a run in ~1 KB: what shape it was, not what was in it."""
    starts = [float(getattr(segment, "start", 0.0)) for segment in segments]

    # Two segments minimum, or there is no interval to measure. A single-segment
    # clip reports null rather than a number nobody could defend.
    tr_sec = None
    if len(starts) > 1:
        gaps = np.diff(np.asarray(sorted(starts)))
        if gaps.size:
            tr_sec = float(np.median(gaps))

    event_type_names: set[str] = set()
    for segment in segments:
        try:
            for event in segment.ns_events:
                event_type_names.add(type(event).__name__)
        except Exception:
            continue

    present = [
        name for name in _SEGMENT_ATTRS if segments and hasattr(segments[0], name)
    ]

    return {
        "recordedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "dtype": str(preds.dtype),
        "ndim": int(preds.ndim),
        "shape": [int(value) for value in preds.shape],
        "nVertices": int(preds.shape[1]) if preds.ndim == 2 else None,
        "nSegments": len(segments),
        "trSec": tr_sec,
        "segmentAttrs": present,
        "eventTypeNames": sorted(event_type_names),
    }


class RecordingBackend:
    """Wraps a backend and writes a shape manifest for every run."""

    def __init__(self, inner, out_dir: Path) -> None:
        self.inner = inner
        self.out_dir = Path(out_dir)

    @property
    def device(self) -> str:
        return self.inner.device

    def load(self) -> None:
        self.inner.load()

    def unload(self) -> None:
        self.inner.unload()

    def is_loaded(self) -> bool:
        return self.inner.is_loaded()

    def run(self, modality: str, path: str) -> tuple[np.ndarray, list]:
        preds, segments = self.inner.run(modality, path)
        try:
            self.out_dir.mkdir(parents=True, exist_ok=True)
            destination = self.out_dir / MANIFEST_NAME
            destination.write_text(
                json.dumps(build_manifest(preds, segments), indent=2)
            )
            logger.info(f"recorded the run's shape to {destination}")
        except Exception:
            # Never lose a run — least of all a GPU one — because telemetry could
            # not be written.
            logger.warning("could not write the shape manifest", exc_info=True)
        return preds, segments
