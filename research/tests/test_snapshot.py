import json

import numpy as np
import pandas as pd
import pytest

from eval.snapshot import (
    MANIFEST_FILE,
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
    # Ledger minor #3: the round trip must preserve `published_at`'s dtype, not
    # just its values. `assert_time_order` (eval.splits) compares it with `>`
    # and `regime1_temporal` sorts on it — both depend on it staying a genuine
    # datetime64 column through a parquet write/read, not silently degrading to
    # object dtype (which would still compare, just not the way either
    # assumes).
    assert pd.api.types.is_datetime64_any_dtype(snap.posts["published_at"])
    assert snap.posts["published_at"].dtype == posts["published_at"].dtype


def test_null_published_at_is_refused(tmp_path):
    # F1: `regime1_temporal`'s `np.argsort` sorts NaT last (into the *test*
    # slice) and `assert_time_order`'s `latest_train > earliest_test` is False
    # against NaT either way it's compared — so a null-dated post used to sail
    # through the leakage guard instead of tripping it. `synth.py` never emits
    # NaT, but the documented second producer (a Postgres extract, where
    # `published_at` is nullable) could. Closing this in `_validate` means no
    # producer can ever hand the pipeline a snapshot with the hole open.
    posts = _posts()
    posts.loc[0, "published_at"] = pd.NaT
    text = np.zeros((6, 4), dtype=np.float32)
    neuro = np.zeros((6, 8), dtype=np.float32)

    with pytest.raises(SnapshotError, match="published_at"):
        write_snapshot(tmp_path, posts, text, neuro, producer="synthetic", seed=0)


def test_a_null_published_at_that_used_to_fail_open_now_raises_before_any_split(tmp_path):
    """Pin the fail-open behaviour closed, on the exact shape that used to slip through.

    Before the `_validate` fix, this frame did not raise anywhere: `write_snapshot`
    wrote it, `load_snapshot` loaded it, `regime1_temporal` placed creator "a"'s
    null-dated post in the *test* slice (NaT sorts last), and `assert_time_order`
    then approved the split because every NaT comparison is False. Now the first
    of those steps — `write_snapshot` — refuses the frame outright, so a split
    with this shape can never be produced by the documented input path at all.
    """
    posts = _posts()
    # Creator "a" is rows 0-2; give its LATEST-by-position post (which
    # `regime1_temporal` would otherwise place in train, since NaT sorts last
    # and would instead land it in test) a null date, so the corrupted split
    # this used to slip into is the split a fixed guard must never produce.
    posts.loc[2, "published_at"] = pd.NaT
    text = np.zeros((6, 4), dtype=np.float32)
    neuro = np.zeros((6, 8), dtype=np.float32)

    with pytest.raises(SnapshotError, match="published_at"):
        write_snapshot(tmp_path, posts, text, neuro, producer="synthetic", seed=0)

    # And the snapshot directory must be left as if nothing had been written —
    # no partial artifact for a caller to accidentally load and treat as valid.
    assert not (tmp_path / MANIFEST_FILE).exists()


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
