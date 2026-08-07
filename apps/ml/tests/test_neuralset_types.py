"""Are the stand-ins actually shaped like the real thing?

`backends/synthetic.py` fakes `neuralset`'s `Segment` and `Word` because
importing the real package pulls torch, mne and scikit-learn — far too heavy for
CI. That fake encodes an assumption, and an assumption nothing checks is just a
bug with a delay on it.

`apps/ml/.venv` *does* have neuralset, so on a developer's machine this runs on
every `pytest` and compares the two directly. In CI it skips. The assumption is
therefore re-verified continuously where it can be, rather than deferred to a GPU
run that has not happened yet.
"""

from __future__ import annotations

import dataclasses

import pytest

import engine
from backends.synthetic import Segment as FakeSegment
from backends.synthetic import Word as FakeWord

SKIP_REASON = (
    "neuralset is not installed (expected in CI) — the Segment/Word stand-ins "
    "in backends/synthetic.py go unverified in this run."
)


@pytest.fixture(scope="module")
def etypes():
    return pytest.importorskip("neuralset.events.etypes", reason=SKIP_REASON)


@pytest.fixture(scope="module")
def segments():
    return pytest.importorskip("neuralset.segments", reason=SKIP_REASON)


def test_fake_word_carries_every_field_the_real_one_requires(etypes):
    """The stand-in must be constructible the way the real class is.

    Discovered here rather than assumed: the real `Word` requires `timeline`
    alongside `start` and `text`, which the first version of the stand-in did not
    carry.
    """
    required = {
        name
        for name, field in etypes.Word.model_fields.items()
        if field.is_required()
    }
    assert required <= set(FakeWord.__slots__), (
        f"real Word requires {sorted(required)}; the stand-in has "
        f"{sorted(FakeWord.__slots__)}"
    )


def test_the_real_word_has_the_sentence_attribute_segment_text_relies_on(etypes):
    """`engine.segment_text` prefers `Word` over `Sentence` events, and its
    comment justifies that by saying only `Word` carries `sentence`. Checked
    rather than trusted, because taking both would duplicate every sentence
    across its own words."""
    assert "sentence" in etypes.Word.model_fields
    assert "sentence" not in etypes.Sentence.model_fields


def test_fake_word_is_named_what_segment_text_dispatches_on(etypes):
    """`engine.segment_text` branches on `type(event).__name__ == "Word"`, so the
    class *name* is part of the contract, not an implementation detail."""
    assert etypes.Word.__name__ == FakeWord.__name__ == "Word"


def test_fake_segment_matches_the_real_members(segments):
    """The real `Segment` is a dataclass, so its fields are in
    `__dataclass_fields__`, not `dir()` — fields without defaults never become
    class attributes. `stop` and `ns_events` are properties and *are* in `dir()`.
    """
    real_members = {
        field.name for field in dataclasses.fields(segments.Segment)
    } | set(dir(segments.Segment))
    fake = FakeSegment(0.0, 1.49, [])
    for name in ("start", "duration", "stop", "ns_events", "timeline"):
        assert name in real_members, f"real Segment has no {name!r}"
        assert hasattr(fake, name), f"the stand-in has no {name!r}"


def test_stop_is_start_plus_duration_in_both(segments):
    """The real `stop` is a property returning `start + duration`
    (segments.py:239). The stand-in must agree, or every `duration_sec` is wrong.
    """
    assert "stop" in dir(segments.Segment)
    fake = FakeSegment(start=3.0, duration=1.49, ns_events=[])
    assert fake.stop == pytest.approx(4.49)


def test_segment_text_reads_real_word_events(etypes):
    """The end-to-end point: `engine.segment_text` must handle real events.

    A real `Segment`'s `ns_events` comes from a shared event store and cannot be
    constructed directly, so this builds a segment-shaped object carrying *real*
    `Word` instances — which is the half that matters, since `segment_text` only
    ever reads `type(e).__name__`, `e.text` and `e.start`.
    """
    words = [
        etypes.Word(text="second", start=1.0, timeline="t"),
        etypes.Word(text="first", start=0.0, timeline="t"),
    ]
    segment = FakeSegment(start=0.0, duration=1.49, ns_events=words)
    assert engine.segment_text(segment) == "first second"


def test_the_fake_produces_the_same_text_as_the_real_events(etypes):
    real_word = etypes.Word(text="hello", start=0.0, timeline="t")
    with_real = FakeSegment(0.0, 1.49, [real_word])
    with_fake = FakeSegment(0.0, 1.49, [FakeWord(text="hello", start=0.0)])
    assert engine.segment_text(with_real) == engine.segment_text(with_fake) == "hello"
