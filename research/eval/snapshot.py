"""The snapshot format — the contract between producers and the harness.

Two producers emit this: `synth.py` today, a Postgres extract later. The harness
has exactly one input path, which is what lets it be written before the cohort
exists.

Wide float features sit beside the parquet rather than inside it, ordered to
match its row order and checksummed in the manifest. That mirrors the app
schema, where `FeatureArtifact` is a pointer carrying shape/dtype/checksum while
the tensor lives in object storage.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

SNAPSHOT_VERSION = 1

POSTS_FILE = "posts.parquet"
MANIFEST_FILE = "manifest.json"
FEATURES_DIR = "features"
TEXT_FILE = "b2_text.npy"
NEURO_FILE = "b3_neuro.npy"

#: Every column a snapshot must carry. `label` is averageViewPercentage, the
#: single primary label fixed by the pre-registration.
REQUIRED_COLUMNS: tuple[str, ...] = (
    "post_id",
    "creator_id",
    "published_at",
    "label",
    "view_count",
    "format",
    "duration_sec",
    "hashtag_count",
    "published_hour",
    "published_dow",
    "follower_count",
)

#: The B1 rung's features. `view_count` is NOT here: it exists only to apply the
#: inclusion threshold, and using it as a feature would be a post-publication
#: leak.
METADATA_COLUMNS: tuple[str, ...] = (
    "duration_sec",
    "hashtag_count",
    "published_hour",
    "published_dow",
    "follower_count",
)


class SnapshotError(RuntimeError):
    """A snapshot is malformed, inconsistent, or does not match its manifest."""


@dataclass(frozen=True)
class Snapshot:
    posts: pd.DataFrame
    text: np.ndarray
    neuro: np.ndarray
    manifest: dict


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    digest.update(path.read_bytes())
    return digest.hexdigest()


def _validate(posts: pd.DataFrame, text: np.ndarray, neuro: np.ndarray) -> None:
    missing = [c for c in REQUIRED_COLUMNS if c not in posts.columns]
    if missing:
        raise SnapshotError(f"posts is missing required columns: {', '.join(missing)}")

    # A null in any required column is a malformed snapshot, not something a
    # downstream consumer should have to guard against. `published_at` is the
    # sharp case: `regime1_temporal`'s `np.argsort` sorts NaT last (so a
    # null-dated post lands in the *test* slice, the most recent one) and
    # `assert_time_order`'s `latest_train > earliest_test` is False against
    # NaT in both directions, so a null-dated post used to sail through the
    # leakage guard rather than trip it — the fail-open failure class this
    # harness exists to catch. Rejecting every required column's nulls here,
    # once, at the one input path every producer shares (see the module
    # docstring), closes that hole for `published_at` and for whichever other
    # column the next producer (the Postgres extract) leaves nullable, without
    # inventing any schema rule beyond "required columns contain no nulls".
    null_columns = [c for c in REQUIRED_COLUMNS if posts[c].isna().any()]
    if null_columns:
        raise SnapshotError(
            f"posts has null values in required column(s): {', '.join(null_columns)}"
        )

    n = len(posts)
    if text.shape[0] != n or neuro.shape[0] != n:
        raise SnapshotError(
            f"feature row count does not match posts: posts={n} "
            f"text={text.shape[0]} neuro={neuro.shape[0]}"
        )
    if text.ndim != 2 or neuro.ndim != 2:
        raise SnapshotError("feature arrays must be 2-D [rows x dims]")
    if posts["post_id"].duplicated().any():
        raise SnapshotError("post_id must be unique")


def write_snapshot(
    out_dir: Path,
    posts: pd.DataFrame,
    text: np.ndarray,
    neuro: np.ndarray,
    *,
    producer: str,
    seed: int,
) -> None:
    """Write a validated snapshot. Refuses to write anything malformed."""
    out_dir = Path(out_dir)
    _validate(posts, text, neuro)

    features_dir = out_dir / FEATURES_DIR
    features_dir.mkdir(parents=True, exist_ok=True)

    posts_path = out_dir / POSTS_FILE
    text_path = features_dir / TEXT_FILE
    neuro_path = features_dir / NEURO_FILE

    posts.to_parquet(posts_path, index=False)
    np.save(text_path, text)
    np.save(neuro_path, neuro)

    manifest = {
        "version": SNAPSHOT_VERSION,
        "producer": producer,
        "seed": seed,
        "rows": int(len(posts)),
        "creators": int(posts["creator_id"].nunique()),
        "dims": {"text": int(text.shape[1]), "neuro": int(neuro.shape[1])},
        "checksums": {
            POSTS_FILE: _sha256(posts_path),
            f"{FEATURES_DIR}/{TEXT_FILE}": _sha256(text_path),
            f"{FEATURES_DIR}/{NEURO_FILE}": _sha256(neuro_path),
        },
    }
    (out_dir / MANIFEST_FILE).write_text(json.dumps(manifest, indent=2) + "\n")


def load_snapshot(snapshot_dir: Path) -> Snapshot:
    """Load and validate a snapshot against its manifest."""
    snapshot_dir = Path(snapshot_dir)
    manifest_path = snapshot_dir / MANIFEST_FILE
    if not manifest_path.exists():
        raise SnapshotError(f"no {MANIFEST_FILE} in {snapshot_dir}")

    manifest = json.loads(manifest_path.read_text())
    if manifest.get("version") != SNAPSHOT_VERSION:
        raise SnapshotError(
            f"snapshot version {manifest.get('version')} != expected {SNAPSHOT_VERSION}"
        )

    for relative, expected in manifest["checksums"].items():
        actual = _sha256(snapshot_dir / relative)
        if actual != expected:
            raise SnapshotError(
                f"checksum mismatch for {relative}: manifest says {expected}, file is {actual}"
            )

    posts = pd.read_parquet(snapshot_dir / POSTS_FILE)
    text = np.load(snapshot_dir / FEATURES_DIR / TEXT_FILE)
    neuro = np.load(snapshot_dir / FEATURES_DIR / NEURO_FILE)
    _validate(posts, text, neuro)

    return Snapshot(posts=posts, text=text, neuro=neuro, manifest=manifest)
