import numpy as np
import pandas as pd
import pytest

from eval.ladder import FORBIDDEN_FEATURE_COLUMNS, features_for, metadata_columns
from eval.snapshot import METADATA_COLUMNS, Snapshot

POSTS = pd.DataFrame(
    {
        "post_id": ["p1", "p2"],
        "creator_id": ["c1", "c1"],
        "published_at": pd.to_datetime(["2026-07-01", "2026-07-02"]),
        "label": [0.1, 0.2],
        "view_count": [100, 200],
        "format": ["SHORT_FORM", "SHORT_FORM"],
        "duration_sec": [20.0, 25.0],
        "hashtag_count": [1, 2],
        "published_hour": [12, 13],
        "published_dow": [2, 3],
        "follower_count": [1000, 1000],
        "days_since_publish": [40, 39],
    }
)


def snap(manifest):
    return Snapshot(posts=POSTS, text=np.zeros((2, 4)), neuro=np.zeros((2, 6)), manifest=manifest)


def test_a_snapshot_with_no_extras_keeps_the_prereg_columns():
    assert metadata_columns(snap({})) == METADATA_COLUMNS


def test_a_corpus_snapshot_can_add_a_covariate():
    columns = metadata_columns(snap({"extra_metadata_columns": ["days_since_publish"]}))
    assert columns == METADATA_COLUMNS + ("days_since_publish",)
    assert features_for("B1", snap({"extra_metadata_columns": ["days_since_publish"]})).shape[1] == 6


def test_view_count_can_never_enter_the_feature_matrix():
    # Under the corpus's PRIMARY outcome `view_count` is not a subtle leak but
    # the label's identity, and B1 scoring near-perfectly is the only symptom.
    # Enforced HERE, where the matrix is actually built, rather than only in the
    # producer that happens to write the manifest today.
    with pytest.raises(ValueError, match="view_count"):
        metadata_columns(snap({"extra_metadata_columns": ["view_count"]}))


def test_a_constant_column_can_never_enter_it_either():
    # `format` is required by the contract but constant in a Shorts-only corpus.
    # A zero-variance column is degenerate in a fitted model, not merely useless.
    with pytest.raises(ValueError, match="format"):
        metadata_columns(snap({"extra_metadata_columns": ["format"]}))


def test_an_unknown_column_fails_loudly():
    with pytest.raises(ValueError, match="not in posts"):
        metadata_columns(snap({"extra_metadata_columns": ["nonexistent"]}))


def test_the_prereg_columns_never_overlap_the_forbidden_list():
    assert not set(METADATA_COLUMNS) & set(FORBIDDEN_FEATURE_COLUMNS)
