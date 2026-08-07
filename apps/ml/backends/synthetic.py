"""A stand-in for TRIBE that runs anywhere.

TRIBE needs a GPU and ~10 GB of gated weights, so on a laptop the choice is
between testing nothing and testing against a fake. This is the fake — and it is
deliberately not noise.

It plants a known signal into named cortical networks at a known time, which buys
the one assertion worth having: *a visual-heavy clip must peak in the visual
band, in the window it was planted in*. That fails if the atlas mapping breaks,
if `axis_timeline`'s columns drift out of `AXES` order, or if the five timeline
arrays fall out of alignment — three real bugs, caught on a MacBook.

    ML_BACKEND=synthetic python worker.py

Tuning knobs, all optional:

    ML_SYNTH_SCENARIO      visual_burst | talky | flat | mixed   (default mixed)
    ML_SYNTH_SEED          integer                               (default 0)
    ML_SYNTH_DURATION_SEC  float, skips probing the media        (default: probe)
"""

from __future__ import annotations

import logging
import os

import numpy as np

from atlas.axis_map import AXES, axis_masks, n_vertices

logger = logging.getLogger(__name__)

# ─── assumptions about the real model ────────────────────────────────────────
#
# UNVERIFIED. TRIBE has never run against this repo, so the segment spacing and
# the dtype below are inferred, not observed. `backends/recording.py` writes a
# `tribe-shape.json` manifest the first time the real model runs anywhere; when
# that file exists, compare these constants to it. Until then, treat both as
# placeholders that happen to be plausible.
TR_SEC = 1.49
DTYPE = np.float32

DEFAULT_DURATION_SEC = 30.0
DEFAULT_SCENARIO = "mixed"

#: `(axis, start_sec, stop_sec, amplitude_in_sigma)`. Amplitudes are added on top
#: of standard-normal noise, so 3.0 is a burst no averaging can hide.
SCENARIOS: dict[str, tuple[tuple[str, float, float, float], ...]] = {
    # Nothing happened. The honest baseline, and what an unengaging clip is.
    "flat": (),
    # One strong visual event, mid-clip. The fixture the atlas assertions read.
    "visual_burst": (("visual", 10.0, 14.0, 3.0),),
    # Sustained speech, no visual event.
    "talky": (("language", 0.0, 1e9, 2.0),),
    # The default: something to look at early, something to listen to later, so a
    # rendered timeline on the mobile result screen has visible shape rather than
    # reading as static.
    "mixed": (
        ("visual", 2.0, 6.0, 3.0),
        ("language", 12.0, 20.0, 2.5),
    ),
}

#: Spoken over any planted `language` window. Content is irrelevant; that it is
#: word-shaped and time-ordered is not — `engine.segment_text` sorts by start.
_WORDS = (
    "okay",
    "so",
    "here",
    "is",
    "the",
    "part",
    "everybody",
    "asks",
    "about",
    "watch",
    "what",
    "happens",
    "when",
    "the",
    "light",
    "hits",
    "it",
)


#: The real `Segment` and `Word` both require a timeline name; nothing in
#: `engine.py` reads it, but carrying it keeps the stand-ins constructible the
#: same way the real ones are.
DEFAULT_TIMELINE = "default"


class Word:
    """Stand-in for `neuralset.events.etypes.Word` (etypes.py:671).

    `engine.segment_text` dispatches on `type(event).__name__ == "Word"` to prefer
    word events over sentence ones, so the *class name* is part of the contract
    this has to satisfy. `tests/test_neuralset_types.py` checks this stand-in
    against the real class wherever neuralset is installed — that test is what
    established the real required fields (`start`, `timeline`, `text`) rather
    than anyone guessing them.
    """

    __slots__ = ("text", "start", "duration", "timeline")

    def __init__(
        self,
        text: str,
        start: float,
        duration: float = 0.0,
        timeline: str = DEFAULT_TIMELINE,
    ) -> None:
        self.text = text
        self.start = start
        self.duration = duration
        self.timeline = timeline


class Segment:
    """Stand-in for `neuralset.segments.Segment` (segments.py:180).

    The real one is a dataclass over a shared `_EventStore` and is explicitly "not
    meant to be instantiated directly" — building one requires pandas and a
    `list_segments` call, and importing the package that owns it pulls torch, mne
    and scikit-learn. This exposes the members `engine.py` actually reads:
    `start`, `duration`, `stop` and `ns_events`, plus the `timeline` the real
    dataclass requires.
    """

    __slots__ = ("start", "duration", "ns_events", "timeline")

    def __init__(
        self,
        start: float,
        duration: float,
        ns_events: list[Word],
        timeline: str = DEFAULT_TIMELINE,
    ) -> None:
        self.start = start
        self.duration = duration
        self.ns_events = ns_events
        self.timeline = timeline

    @property
    def stop(self) -> float:
        return self.start + self.duration


def _probe_duration(path: str) -> float:
    """How long the clip is, in seconds.

    Reads the real media when PyAV is available, because a synthetic run over a
    real upload should produce a timeline as long as the video actually is. Falls
    back quietly: CI has no PyAV and passes paths that do not exist.
    """
    override = os.getenv("ML_SYNTH_DURATION_SEC")
    if override:
        return float(override)

    try:
        import av

        with av.open(path) as container:
            if container.duration:
                return float(container.duration) / 1_000_000.0  # AV_TIME_BASE
    except Exception:
        logger.debug(f"could not probe {path} for duration; using the default")

    return DEFAULT_DURATION_SEC


class SyntheticBackend:
    """Plausible brain data, deterministically, without a GPU."""

    def __init__(
        self,
        scenario: str | None = None,
        seed: int | None = None,
        duration_sec: float | None = None,
    ) -> None:
        self.device = "synthetic"
        self.scenario = (
            (scenario or os.getenv("ML_SYNTH_SCENARIO") or DEFAULT_SCENARIO)
            .strip()
            .lower()
        )
        if self.scenario not in SCENARIOS:
            raise ValueError(
                f"unknown ML_SYNTH_SCENARIO {self.scenario!r} — "
                f"expected one of {', '.join(sorted(SCENARIOS))}"
            )
        self.seed = int(seed if seed is not None else os.getenv("ML_SYNTH_SEED", "0"))
        self.duration_sec = duration_sec
        self._loaded = False

    def load(self) -> None:
        self._loaded = True
        logger.warning(
            f"ML_BACKEND=synthetic — TRIBE is NOT running. Scenario "
            f"{self.scenario!r}, seed {self.seed}. Results are fabricated and "
            f"will be stored with device='synthetic'."
        )

    def unload(self) -> None:
        self._loaded = False

    def is_loaded(self) -> bool:
        return self._loaded

    def run(self, modality: str, path: str) -> tuple[np.ndarray, list]:
        seconds = (
            self.duration_sec
            if self.duration_sec is not None
            else _probe_duration(path)
        )
        n_segments = max(1, int(seconds // TR_SEC))

        rng = np.random.default_rng(self.seed)
        preds = rng.standard_normal((n_segments, n_vertices()), dtype=DTYPE)

        masks = axis_masks()
        spoken: set[int] = set()

        for axis, start_sec, stop_sec, amplitude in SCENARIOS[self.scenario]:
            lo = max(0, int(start_sec // TR_SEC))
            hi = min(n_segments, int(np.ceil(stop_sec / TR_SEC)))
            if lo >= hi:
                continue
            preds[lo:hi, masks[AXES.index(axis)]] += DTYPE(amplitude)
            if axis == "language":
                spoken.update(range(lo, hi))

        segments = [
            Segment(
                start=index * TR_SEC,
                duration=TR_SEC,
                ns_events=self._events(index) if index in spoken else [],
            )
            for index in range(n_segments)
        ]
        return preds, segments

    def _events(self, index: int) -> list[Word]:
        """Two words per speaking segment, cycling the canned list."""
        start = index * TR_SEC
        return [
            Word(
                text=_WORDS[(index * 2 + offset) % len(_WORDS)],
                start=start + offset * (TR_SEC / 2),
            )
            for offset in (0, 1)
        ]
