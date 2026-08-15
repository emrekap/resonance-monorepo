import numpy as np
import pandas as pd
import pytest

from eval.snapshot import SnapshotError, load_snapshot, write_snapshot

REQUIRED = {
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
}


def _write(tmp_path, extra=None):
    write_snapshot(
        tmp_path,
        pd.DataFrame(REQUIRED),
        np.zeros((2, 4)),
        np.zeros((2, 6)),
        producer="corpus",
        seed=0,
        extra=extra,
    )


def test_extra_keys_survive_the_round_trip(tmp_path):
    _write(tmp_path, {"outcome": "views_at_Nd", "maturation": {"n_days": 14, "phase": 1}})
    manifest = load_snapshot(tmp_path).manifest
    # Two runs at different maturation floors are silently incomparable unless
    # the floor travels with the artifact — the label changed meaning between
    # them, and nothing else in the snapshot records that.
    assert manifest["outcome"] == "views_at_Nd"
    assert manifest["maturation"] == {"n_days": 14, "phase": 1}


def test_extra_cannot_overwrite_a_reserved_key(tmp_path):
    # `checksums` is what makes the snapshot verifiable at all.
    with pytest.raises(SnapshotError):
        _write(tmp_path, {"checksums": {}})


def test_snapshots_without_extra_are_unchanged(tmp_path):
    _write(tmp_path)
    manifest = load_snapshot(tmp_path).manifest
    assert set(manifest) == {"version", "producer", "seed", "rows", "creators", "dims", "checksums"}
