import json

import numpy as np
import pandas as pd
import pytest

from eval.snapshot import (
    SNAPSHOT_VERSION,
    SnapshotError,
    load_snapshot,
    write_snapshot,
)


def _posts(n: int = 6) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "post_id": [f"p{i}" for i in range(n)],
            "creator_id": ["c0" if i < 3 else "c1" for i in range(n)],
            "published_at": pd.date_range("2026-01-01", periods=n, freq="D"),
            "label": np.linspace(10.0, 60.0, n),
            "view_count": np.full(n, 5000),
            "format": ["SHORT_FORM"] * n,
            "duration_sec": np.linspace(10.0, 40.0, n),
            "hashtag_count": np.arange(n),
            "published_hour": np.arange(n) % 24,
            "published_dow": np.arange(n) % 7,
            "follower_count": np.full(n, 1000),
        }
    )


def test_round_trip_preserves_rows_and_features(tmp_path):
    posts = _posts()
    text = np.arange(6 * 4, dtype=np.float32).reshape(6, 4)
    neuro = np.arange(6 * 8, dtype=np.float32).reshape(6, 8)

    write_snapshot(tmp_path, posts, text, neuro, producer="synthetic", seed=7)
    snap = load_snapshot(tmp_path)

    assert len(snap.posts) == 6
    assert snap.manifest["version"] == SNAPSHOT_VERSION
    assert snap.manifest["producer"] == "synthetic"
    assert snap.manifest["seed"] == 7
    np.testing.assert_array_equal(snap.text, text)
    np.testing.assert_array_equal(snap.neuro, neuro)


def test_missing_required_column_is_refused(tmp_path):
    posts = _posts().drop(columns=["follower_count"])
    text = np.zeros((6, 4), dtype=np.float32)
    neuro = np.zeros((6, 8), dtype=np.float32)

    with pytest.raises(SnapshotError, match="follower_count"):
        write_snapshot(tmp_path, posts, text, neuro, producer="synthetic", seed=0)


def test_row_count_mismatch_is_refused(tmp_path):
    posts = _posts()
    text = np.zeros((5, 4), dtype=np.float32)  # one short
    neuro = np.zeros((6, 8), dtype=np.float32)

    with pytest.raises(SnapshotError, match="row count"):
        write_snapshot(tmp_path, posts, text, neuro, producer="synthetic", seed=0)


def test_corrupted_feature_file_fails_checksum(tmp_path):
    posts = _posts()
    write_snapshot(
        tmp_path,
        posts,
        np.zeros((6, 4), dtype=np.float32),
        np.zeros((6, 8), dtype=np.float32),
        producer="synthetic",
        seed=0,
    )

    # Silently truncate the neuro array — the failure this guards against is a
    # quietly worse rho, not a crash.
    np.save(tmp_path / "features" / "b3_neuro.npy", np.zeros((6, 7), dtype=np.float32))

    with pytest.raises(SnapshotError, match="checksum"):
        load_snapshot(tmp_path)


def test_version_mismatch_is_refused(tmp_path):
    posts = _posts()
    write_snapshot(
        tmp_path,
        posts,
        np.zeros((6, 4), dtype=np.float32),
        np.zeros((6, 8), dtype=np.float32),
        producer="synthetic",
        seed=0,
    )
    manifest_path = tmp_path / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["version"] = SNAPSHOT_VERSION + 1
    manifest_path.write_text(json.dumps(manifest))

    with pytest.raises(SnapshotError, match="version"):
        load_snapshot(tmp_path)
