import numpy as np
import pandas as pd
import pytest

from eval.snapshot import Snapshot
from eval.zeroshot import zero_shot


def snap(composite, label, creators=None, manifest=None):
    n = len(label)
    posts = pd.DataFrame(
        {
            "post_id": [f"p{i}" for i in range(n)],
            "creator_id": creators or ["c1"] * n,
            "published_at": pd.date_range("2026-01-01", periods=n, freq="D"),
            "label": label,
            "composite": composite,
        }
    )
    return Snapshot(
        posts=posts, text=np.zeros((n, 2)), neuro=np.zeros((n, 2)), manifest=manifest or {}
    )


def test_returns_nothing_without_a_composite_column():
    # A synthetic world has no shipped composite to correlate, so the section
    # must be absent rather than zero — absent reads as "not applicable",
    # zero reads as "the product predicts nothing".
    with_composite = snap([1, 2, 3], [1, 2, 3])
    assert zero_shot(with_composite, seed=0) is not None

    bare = Snapshot(
        posts=with_composite.posts.drop(columns=["composite"]),
        text=with_composite.text,
        neuro=with_composite.neuro,
        manifest={},
    )
    assert zero_shot(bare, seed=0) is None


def test_a_perfectly_ordering_composite_scores_one():
    # `approx`, not `==`: scipy's spearmanr returns 0.9999999999999999 for a
    # perfect five-point ordering. The claim under test is that the ranking is
    # perfect, not that a correlation statistic lands on an exact float.
    result = zero_shot(snap([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]), seed=0)
    assert result["rho"] == pytest.approx(1.0)
    assert result["posts"] == 5
    assert result["creators"] == 1


def test_ranks_within_creator_only():
    # Across creators, reach is dominated by audience size, so a pooled
    # correlation would be mostly a restatement of subscriber count. Creator B's
    # labels are an order of magnitude larger and inversely ordered; a pooled
    # Spearman would be dragged negative, a within-creator one stays at 1.
    result = zero_shot(
        snap(
            [1, 2, 3, 1, 2, 3],
            [1, 2, 3, 100, 200, 300],
            creators=["a", "a", "a", "b", "b", "b"],
        ),
        seed=0,
    )
    assert result["rho"] == pytest.approx(1.0)
    assert result["creators"] == 2


def test_carries_a_confidence_interval():
    rng = np.random.default_rng(0)
    n = 200
    composite = rng.normal(size=n)
    result = zero_shot(
        snap(composite, composite + rng.normal(scale=0.5, size=n), creators=[f"c{i % 20}" for i in range(n)]),
        seed=0,
    )
    assert result["lo"] < result["rho"] < result["hi"]
