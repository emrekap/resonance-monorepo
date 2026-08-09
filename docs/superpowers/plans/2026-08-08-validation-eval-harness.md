# Validation Eval Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the reproducible eval harness for the pre-registered validation experiment in a new
top-level `research/` directory, against synthetic data with known ground truth, before the cohort
exists.

**Architecture:** One snapshot format is the contract; a synthetic generator produces it today and a
Postgres extract will produce it later, so the harness has exactly one input path. Every leakage
rule in the pre-registration becomes a runtime assertion with a test that proves it fires on a
violation. Negative controls run before the ladder and void the run on failure, and the
Green/Yellow/Red verdict is computed mechanically rather than chosen.

**Tech Stack:** Python ≥ 3.11, numpy, pandas, pyarrow, scipy, scikit-learn, pytest. Deliberately no
torch.

**Design spec:** [`docs/superpowers/specs/2026-08-08-validation-eval-harness-design.md`](../specs/2026-08-08-validation-eval-harness-design.md)

## Global Constraints

- **Do not commit unless Emre asks.** `CLAUDE.md`: "Commit / push only when asked." The commit steps
  below are written out ready to run; they are gated on an explicit request.
- **No torch, anywhere.** `research/requirements.txt` is the whole dependency set. A module-scope
  `import torch` is a defect, same rule as `apps/ml`.
- **`research/` is a Python island.** No `package.json`, so Bun and Turbo ignore the directory. It
  gets its own `.venv`, exactly like `apps/ml`.
- **All randomness is seeded.** Every function that samples takes an explicit `seed` or a
  `numpy.random.Generator`. A run must be byte-reproducible from its manifest.
- **Verdict precedence is Red-first**, per the spec's amendment section: CI-includes-zero → RED,
  before any Green check. Do not reorder.
- **The primary label is `averageViewPercentage`**, carried as the single `label` column. No code
  path may select a different label.
- **Line length 100**, matching the repo's Prettier width. Format Python with the default
  `ruff format` line length of 88 only if ruff is added later — for now, keep lines under 100 by
  hand; there is no Python formatter configured in this repo.

---

## File Structure

| File                         | Responsibility                                                    |
| ---------------------------- | ----------------------------------------------------------------- |
| `research/requirements.txt`  | The entire dependency set                                         |
| `research/pytest.ini`        | `testpaths = tests`, strict markers                               |
| `research/README.md`         | What it is, how to run, the deferred-extract sketch               |
| `research/eval/__init__.py`  | Package marker                                                    |
| `research/eval/snapshot.py`  | Snapshot format: write, load, manifest validation                 |
| `research/eval/synth.py`     | Ground-truth generator — plants a known world                     |
| `research/eval/splits.py`    | Regime 1 + Regime 2, and the leakage assertions                   |
| `research/eval/normalize.py` | Within-creator normalizer with a fit-provenance guard             |
| `research/eval/metrics.py`   | Per-creator Spearman, pairwise accuracy, top-1                    |
| `research/eval/stats.py`     | Bootstrap over creators, paired Wilcoxon, uplift                  |
| `research/eval/ladder.py`    | B0–B4                                                             |
| `research/eval/controls.py`  | Label-shuffle and brain-average negative controls                 |
| `research/eval/verdict.py`   | Prereg §6 thresholds → GREEN/YELLOW/RED                           |
| `research/eval/report.py`    | `results.json` + `report.md`                                      |
| `research/eval/cli.py`       | The pipeline and `python -m eval`                                 |
| `research/tests/*`           | One test module per source module, plus the four-world end-to-end |

---

### Task 1: Scaffold `research/` and the snapshot format

**Files:**

- Create: `research/requirements.txt`
- Create: `research/pytest.ini`
- Create: `research/.gitignore`
- Create: `research/eval/__init__.py`
- Create: `research/eval/snapshot.py`
- Test: `research/tests/test_snapshot.py`

**Interfaces:**

- Consumes: nothing (first task)
- Produces: `SNAPSHOT_VERSION: int`, `SnapshotError(RuntimeError)`,
  `Snapshot` (frozen dataclass with `.posts: pd.DataFrame`, `.text: np.ndarray`,
  `.neuro: np.ndarray`, `.manifest: dict`),
  `write_snapshot(out_dir: Path, posts: pd.DataFrame, text: np.ndarray, neuro: np.ndarray, *, producer: str, seed: int) -> None`,
  `load_snapshot(snapshot_dir: Path) -> Snapshot`,
  `REQUIRED_COLUMNS: tuple[str, ...]`, `METADATA_COLUMNS: tuple[str, ...]`

- [ ] **Step 1: Create the directory scaffolding**

`research/requirements.txt`:

```text
# The eval harness for the pre-registered validation experiment.
#
# One file, not the run/dev split apps/ml needs: nothing here deploys, so there
# is no production install to keep lean. There is deliberately NO torch — this
# package never runs a model, it evaluates predictions.
#
#   python -m venv .venv && ./.venv/bin/pip install -r requirements.txt
#   ./.venv/bin/python -m pytest

numpy>=2.1
pandas>=2.2
pyarrow>=17.0        # parquet
scipy>=1.14          # spearmanr, wilcoxon, expit
scikit-learn>=1.5    # Ridge, StandardScaler
pytest>=8.0
```

`research/pytest.ini`:

```ini
[pytest]
testpaths = tests
addopts = -q --strict-markers
```

`research/.gitignore`:

```text
.venv/
__pycache__/
*.pyc
out/
snapshots/
```

`research/eval/__init__.py`:

```python
"""Eval harness for the pre-registered validation experiment.

See docs/superpowers/specs/2026-08-08-validation-eval-harness-design.md.
"""
```

- [ ] **Step 2: Write the failing test**

`research/tests/test_snapshot.py`:

```python
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd research && ./.venv/bin/python -m pytest tests/test_snapshot.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'eval'`

- [ ] **Step 4: Implement `snapshot.py`**

`research/eval/snapshot.py`:

```python
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd research && ./.venv/bin/python -m pytest tests/test_snapshot.py -v`
Expected: PASS — 5 tests

- [ ] **Step 6: Commit** _(only if Emre has asked)_

```bash
git add research/
git commit -m "feat(research): scaffold eval harness and the snapshot format"
```

---

### Task 2: The synthetic ground-truth generator

**Files:**

- Create: `research/eval/synth.py`
- Test: `research/tests/test_synth.py`

**Interfaces:**

- Consumes: `eval.snapshot.write_snapshot`, `REQUIRED_COLUMNS`
- Produces: `World` (frozen dataclass: `name: str`, `n_creators: int`, `posts_per_creator: int`,
  `neuro_effect: float`, `meta_effect: float`, `text_effect: float`, `noise: float`,
  `contaminate: bool`, `seed: int`),
  `SIGNAL_WORLD`, `NULL_WORLD`, `CONTAMINATED_WORLD` constants,
  `generate(world: World) -> tuple[pd.DataFrame, np.ndarray, np.ndarray]`,
  `write_world(world: World, out_dir: Path) -> None`

The generator plants a **known** effect so tests can assert the harness recovers it. Two details are
load-bearing:

1. The neuro signal direction is made **orthogonal to the all-ones vector**, so the mean across
   neuro dimensions carries almost none of it. That is what makes the brain-average negative control
   faithful — it must fail for the same reason it fails in the literature.
2. Confounders load onto the metadata rung, so B1 is a real baseline rather than noise.

- [ ] **Step 1: Write the failing test**

`research/tests/test_synth.py`:

```python
import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from eval.snapshot import REQUIRED_COLUMNS, load_snapshot
from eval.synth import (
    CONTAMINATED_WORLD,
    NULL_WORLD,
    SIGNAL_WORLD,
    generate,
    write_world,
)


def _within_creator_rho(posts: pd.DataFrame, scores: np.ndarray) -> float:
    rhos = []
    for _, idx in posts.groupby("creator_id").groups.items():
        positions = posts.index.get_indexer(idx)
        if len(positions) < 3:
            continue
        rho = spearmanr(posts["label"].to_numpy()[positions], scores[positions]).statistic
        if np.isfinite(rho):
            rhos.append(rho)
    return float(np.mean(rhos))


def test_generate_emits_every_required_column():
    posts, text, neuro = generate(SIGNAL_WORLD)
    for column in REQUIRED_COLUMNS:
        assert column in posts.columns
    assert len(posts) == text.shape[0] == neuro.shape[0]


def test_generate_is_deterministic_for_a_seed():
    a_posts, a_text, a_neuro = generate(SIGNAL_WORLD)
    b_posts, b_text, b_neuro = generate(SIGNAL_WORLD)
    pd.testing.assert_frame_equal(a_posts, b_posts)
    np.testing.assert_array_equal(a_text, b_text)
    np.testing.assert_array_equal(a_neuro, b_neuro)


def test_signal_world_plants_recoverable_neuro_signal():
    posts, _, neuro = generate(SIGNAL_WORLD)
    # The planted direction is the generator's own; projecting onto it must
    # recover a strong within-creator rank correlation with the label.
    direction = SIGNAL_WORLD_DIRECTION = np.load  # placeholder guard, see below
    del direction, SIGNAL_WORLD_DIRECTION

    from eval.synth import signal_direction

    projected = neuro @ signal_direction(SIGNAL_WORLD)
    assert _within_creator_rho(posts, projected) > 0.30


def test_null_world_plants_no_neuro_signal():
    posts, _, neuro = generate(NULL_WORLD)
    from eval.synth import signal_direction

    projected = neuro @ signal_direction(NULL_WORLD)
    assert abs(_within_creator_rho(posts, projected)) < 0.10


def test_signal_direction_is_orthogonal_to_the_mean():
    # The brain-average control must fail for the right reason: the planted
    # signal is invisible to a naive average across dimensions.
    from eval.synth import signal_direction

    direction = signal_direction(SIGNAL_WORLD)
    assert abs(float(direction.sum())) < 1e-9


def test_contaminated_world_leaks_the_label_into_neuro():
    posts, _, neuro = generate(CONTAMINATED_WORLD)
    # First neuro column IS the label — the label-shuffle control must catch it.
    rho = spearmanr(posts["label"].to_numpy(), neuro[:, 0]).statistic
    assert rho > 0.99


def test_labels_are_a_plausible_completion_percentage():
    posts, _, _ = generate(SIGNAL_WORLD)
    assert posts["label"].between(0.0, 100.0).all()


def test_write_world_round_trips_through_the_snapshot_format(tmp_path):
    write_world(SIGNAL_WORLD, tmp_path)
    snap = load_snapshot(tmp_path)
    assert snap.manifest["producer"] == "synthetic"
    assert snap.manifest["seed"] == SIGNAL_WORLD.seed
    assert len(snap.posts) == SIGNAL_WORLD.n_creators * SIGNAL_WORLD.posts_per_creator
```

Remove the two placeholder lines flagged inline before running (they exist only to show the import
move); the real assertion is the `signal_direction` one below them.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd research && ./.venv/bin/python -m pytest tests/test_synth.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'eval.synth'`

- [ ] **Step 3: Implement `synth.py`**

`research/eval/synth.py`:

```python
"""A world whose answer is known.

This is not a stopgap for missing data. It is the only window in which the
statistics can be checked against truth at all: with real data nobody knows the
right answer, so a harness that computes the wrong Spearman is indistinguishable
from one that computes the right one.

Two details are load-bearing:

* The neuro signal direction is orthogonal to the all-ones vector, so a naive
  mean across dimensions carries almost none of it. That makes the brain-average
  negative control fail for the same reason it fails in the literature, rather
  than by accident.
* Confounders load onto the metadata columns, so B1 is a genuine baseline.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.special import expit

from eval.snapshot import write_snapshot

TEXT_DIMS = 16
NEURO_DIMS = 32


@dataclass(frozen=True)
class World:
    name: str
    n_creators: int
    posts_per_creator: int
    neuro_effect: float
    meta_effect: float
    text_effect: float
    noise: float
    seed: int
    contaminate: bool = False


#: B3 genuinely beats the cheap rungs. The harness must return GREEN.
SIGNAL_WORLD = World(
    name="signal",
    n_creators=40,
    posts_per_creator=25,
    neuro_effect=1.0,
    meta_effect=0.35,
    text_effect=0.25,
    noise=0.7,
    seed=11,
)

#: B3 carries nothing beyond what metadata already explains. Must return RED.
NULL_WORLD = World(
    name="null",
    n_creators=40,
    posts_per_creator=25,
    neuro_effect=0.0,
    meta_effect=0.35,
    text_effect=0.25,
    noise=0.7,
    seed=12,
)

#: The label is copied into a neuro column. The label-shuffle control must catch
#: it and VOID the run.
CONTAMINATED_WORLD = World(
    name="contaminated",
    n_creators=40,
    posts_per_creator=25,
    neuro_effect=1.0,
    meta_effect=0.35,
    text_effect=0.25,
    noise=0.7,
    seed=13,
    contaminate=True,
)


def signal_direction(world: World) -> np.ndarray:
    """The planted direction in neuro space, orthogonal to the all-ones vector.

    Deterministic for a world, so tests can project onto it.
    """
    rng = np.random.default_rng(world.seed + 9_000)
    direction = rng.normal(size=NEURO_DIMS)
    direction = direction - direction.mean()  # orthogonal to ones
    return direction / np.linalg.norm(direction)


def generate(world: World) -> tuple[pd.DataFrame, np.ndarray, np.ndarray]:
    """Build a world. Returns (posts, text_features, neuro_features)."""
    rng = np.random.default_rng(world.seed)
    n = world.n_creators * world.posts_per_creator

    creator_ids = np.repeat(
        [f"c{i:03d}" for i in range(world.n_creators)], world.posts_per_creator
    )
    # Each creator has their own baseline and their own follower tier. This is
    # the confounder the whole experiment conditions on.
    creator_baseline = rng.normal(0.0, 1.2, size=world.n_creators)
    creator_followers = rng.lognormal(9.0, 1.1, size=world.n_creators)

    neuro = rng.normal(size=(n, NEURO_DIMS))
    text = rng.normal(size=(n, TEXT_DIMS))

    duration_sec = rng.uniform(8.0, 90.0, size=n)
    hashtag_count = rng.integers(0, 12, size=n)
    published_hour = rng.integers(0, 24, size=n)
    published_dow = rng.integers(0, 7, size=n)
    follower_count = np.repeat(creator_followers, world.posts_per_creator)

    neuro_score = neuro @ signal_direction(world)
    # Metadata carries real but weaker signal, standardised so the effect sizes
    # above are comparable.
    meta_raw = -0.6 * duration_sec + 0.4 * hashtag_count
    meta_score = (meta_raw - meta_raw.mean()) / meta_raw.std()
    text_score = text[:, 0]

    latent = (
        world.neuro_effect * neuro_score
        + world.meta_effect * meta_score
        + world.text_effect * text_score
        + world.noise * rng.normal(size=n)
        + np.repeat(creator_baseline, world.posts_per_creator)
    )
    # averageViewPercentage lives in (0, 100). Spearman is rank-based so the
    # monotone squash changes nothing about the recoverable signal.
    label = 100.0 * expit(latent / 2.0)

    published_at = pd.to_datetime("2026-01-01") + pd.to_timedelta(
        rng.integers(0, 720, size=n), unit="D"
    )

    posts = pd.DataFrame(
        {
            "post_id": [f"p{i:06d}" for i in range(n)],
            "creator_id": creator_ids,
            "published_at": published_at,
            "label": label,
            "view_count": rng.integers(2_000, 500_000, size=n),
            "format": "SHORT_FORM",
            "duration_sec": duration_sec,
            "hashtag_count": hashtag_count,
            "published_hour": published_hour,
            "published_dow": published_dow,
            "follower_count": follower_count,
        }
    )
    # Sort so per-creator temporal splits are meaningful, then reset to a clean
    # RangeIndex — every downstream module indexes by integer position.
    posts = posts.sort_values(["creator_id", "published_at"]).reset_index(drop=True)
    order = posts.index.to_numpy()
    neuro = neuro[order]
    text = text[order]
    posts = posts.reset_index(drop=True)

    if world.contaminate:
        # Copy the label straight into a feature. Nothing about this is subtle;
        # the point is that the control catches even the blatant case.
        neuro = neuro.copy()
        neuro[:, 0] = posts["label"].to_numpy()

    return posts, text.astype(np.float32), neuro.astype(np.float32)


def write_world(world: World, out_dir: Path) -> None:
    """Generate a world and write it as a snapshot."""
    posts, text, neuro = generate(world)
    write_snapshot(Path(out_dir), posts, text, neuro, producer="synthetic", seed=world.seed)
```

- [ ] **Step 4: Fix the test's placeholder lines**

Delete these three lines from `test_signal_world_plants_recoverable_neuro_signal`, which exist only
to mark where the import moves:

```python
    direction = SIGNAL_WORLD_DIRECTION = np.load  # placeholder guard, see below
    del direction, SIGNAL_WORLD_DIRECTION
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd research && ./.venv/bin/python -m pytest tests/test_synth.py -v`
Expected: PASS — 8 tests

- [ ] **Step 6: Commit** _(only if Emre has asked)_

```bash
git add research/eval/synth.py research/tests/test_synth.py
git commit -m "feat(research): synthetic ground-truth world generator"
```

---

### Task 3: Splits and the leakage assertions

**Files:**

- Create: `research/eval/splits.py`
- Test: `research/tests/test_splits.py`

**Interfaces:**

- Consumes: nothing beyond pandas/numpy
- Produces: `LeakageError(RuntimeError)`,
  `Split` (frozen dataclass: `name: str`, `train: np.ndarray`, `test: np.ndarray` — both integer
  positions into `posts`),
  `regime1_temporal(posts: pd.DataFrame, *, test_fraction: float = 0.2) -> Split`,
  `regime2_grouped(posts: pd.DataFrame, *, test_fraction: float = 0.2, seed: int = 0) -> Split`,
  `assert_no_creator_overlap(posts: pd.DataFrame, split: Split) -> None`,
  `assert_time_order(posts: pd.DataFrame, split: Split) -> None`

The tests that matter here assert the guards **fire on a deliberately corrupted split**. A test that
a guard passes on clean data proves nothing.

- [ ] **Step 1: Write the failing test**

`research/tests/test_splits.py`:

```python
import numpy as np
import pandas as pd
import pytest

from eval.splits import (
    LeakageError,
    Split,
    assert_no_creator_overlap,
    assert_time_order,
    regime1_temporal,
    regime2_grouped,
)


def _posts(n_creators: int = 5, per_creator: int = 10) -> pd.DataFrame:
    rows = []
    for c in range(n_creators):
        for i in range(per_creator):
            rows.append(
                {
                    "post_id": f"p{c}_{i}",
                    "creator_id": f"c{c}",
                    "published_at": pd.Timestamp("2026-01-01") + pd.Timedelta(days=i),
                }
            )
    return pd.DataFrame(rows)


def test_regime1_holds_out_the_most_recent_posts_per_creator():
    posts = _posts()
    split = regime1_temporal(posts, test_fraction=0.2)

    assert split.name == "regime1_temporal"
    # Every creator appears on both sides — that is the point of Regime 1.
    assert set(posts["creator_id"]) == set(posts["creator_id"].to_numpy()[split.train])
    assert set(posts["creator_id"]) == set(posts["creator_id"].to_numpy()[split.test])
    assert len(split.test) == 5 * 2  # ceil(10 * 0.2) per creator


def test_regime1_respects_time_order():
    posts = _posts()
    split = regime1_temporal(posts)
    assert_time_order(posts, split)  # must not raise


def test_time_order_guard_fires_on_a_corrupted_split():
    posts = _posts()
    good = regime1_temporal(posts)
    # Swap one train and one test position for the same creator, so a training
    # post now post-dates a test post.
    train = good.train.copy()
    test = good.test.copy()
    train[-1], test[0] = test[0], train[-1]
    corrupted = Split(name="corrupted", train=train, test=test)

    with pytest.raises(LeakageError, match="time order"):
        assert_time_order(posts, corrupted)


def test_regime2_holds_out_whole_creators():
    posts = _posts()
    split = regime2_grouped(posts, test_fraction=0.2, seed=0)

    assert split.name == "regime2_grouped"
    train_creators = set(posts["creator_id"].to_numpy()[split.train])
    test_creators = set(posts["creator_id"].to_numpy()[split.test])
    assert train_creators.isdisjoint(test_creators)
    assert len(test_creators) == 1  # ceil(5 * 0.2)


def test_regime2_is_deterministic_for_a_seed():
    posts = _posts()
    a = regime2_grouped(posts, seed=3)
    b = regime2_grouped(posts, seed=3)
    np.testing.assert_array_equal(a.test, b.test)


def test_creator_overlap_guard_fires_on_a_corrupted_split():
    posts = _posts()
    good = regime2_grouped(posts, seed=0)
    # Leak one training row of a train-only creator into test.
    corrupted = Split(
        name="corrupted",
        train=good.train,
        test=np.concatenate([good.test, good.train[:1]]),
    )

    with pytest.raises(LeakageError, match="appear in both"):
        assert_no_creator_overlap(posts, corrupted)


def test_every_split_covers_disjoint_positions():
    posts = _posts()
    for split in (regime1_temporal(posts), regime2_grouped(posts, seed=0)):
        assert set(split.train).isdisjoint(set(split.test))
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd research && ./.venv/bin/python -m pytest tests/test_splits.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'eval.splits'`

- [ ] **Step 3: Implement `splits.py`**

`research/eval/splits.py`:

```python
"""Splits, and the leakage rules turned into assertions.

The pre-registration's §7 rules are prose. Prose does not enforce itself, and
the failure mode is silent: a leaked normalizer or a shuffled time order
produces a BETTER number, not an error. So each rule is a guard here, and the
test that matters for each is the one that corrupts a split on purpose and
proves the guard fires.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd


class LeakageError(RuntimeError):
    """A split violates one of the pre-registered leakage rules."""


@dataclass(frozen=True)
class Split:
    name: str
    train: np.ndarray  # integer positions into posts
    test: np.ndarray


def regime1_temporal(posts: pd.DataFrame, *, test_fraction: float = 0.2) -> Split:
    """Regime 1 — new post, known creator.

    Per creator, train on the older posts and test on the most recent
    `test_fraction`. Mirrors production ("score my next post") and blocks
    temporal leakage.
    """
    train_parts: list[np.ndarray] = []
    test_parts: list[np.ndarray] = []

    positions = np.arange(len(posts))
    for _, group in posts.groupby("creator_id", sort=True):
        ordered = positions[group.index.to_numpy()]
        ordered = ordered[np.argsort(posts["published_at"].to_numpy()[ordered], kind="stable")]
        n_test = max(1, math.ceil(len(ordered) * test_fraction))
        if n_test >= len(ordered):
            n_test = len(ordered) - 1
        train_parts.append(ordered[: len(ordered) - n_test])
        test_parts.append(ordered[len(ordered) - n_test :])

    return Split(
        name="regime1_temporal",
        train=np.sort(np.concatenate(train_parts)),
        test=np.sort(np.concatenate(test_parts)),
    )


def regime2_grouped(
    posts: pd.DataFrame, *, test_fraction: float = 0.2, seed: int = 0
) -> Split:
    """Regime 2 — new creator. Entire creators are held out of training."""
    creators = np.array(sorted(posts["creator_id"].unique()))
    rng = np.random.default_rng(seed)
    n_test = max(1, math.ceil(len(creators) * test_fraction))
    if n_test >= len(creators):
        n_test = len(creators) - 1
    test_creators = set(rng.choice(creators, size=n_test, replace=False).tolist())

    is_test = posts["creator_id"].isin(test_creators).to_numpy()
    positions = np.arange(len(posts))
    return Split(
        name="regime2_grouped",
        train=positions[~is_test],
        test=positions[is_test],
    )


def assert_no_creator_overlap(posts: pd.DataFrame, split: Split) -> None:
    """Prereg §7: no creator appears in both train and test in Regime 2."""
    creators = posts["creator_id"].to_numpy()
    overlap = set(creators[split.train]) & set(creators[split.test])
    if overlap:
        sample = ", ".join(sorted(overlap)[:5])
        raise LeakageError(
            f"{len(overlap)} creator(s) appear in both train and test: {sample}"
        )


def assert_time_order(posts: pd.DataFrame, split: Split) -> None:
    """Prereg §7: never train on a post published after the test post."""
    creators = posts["creator_id"].to_numpy()
    published = posts["published_at"].to_numpy()

    train_by_creator: dict[str, np.ndarray] = {}
    for creator in set(creators[split.train]):
        train_by_creator[creator] = published[split.train][creators[split.train] == creator]

    for creator in set(creators[split.test]):
        if creator not in train_by_creator:
            continue  # held-out creator: Regime 2, nothing to order against
        latest_train = train_by_creator[creator].max()
        earliest_test = published[split.test][creators[split.test] == creator].min()
        if latest_train > earliest_test:
            raise LeakageError(
                f"time order violated for {creator}: a training post "
                f"({latest_train}) post-dates a test post ({earliest_test})"
            )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd research && ./.venv/bin/python -m pytest tests/test_splits.py -v`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit** _(only if Emre has asked)_

```bash
git add research/eval/splits.py research/tests/test_splits.py
git commit -m "feat(research): splits and leakage assertions"
```

---

### Task 4: The within-creator normalizer and its fit-provenance guard

**Files:**

- Create: `research/eval/normalize.py`
- Test: `research/tests/test_normalize.py`

**Interfaces:**

- Consumes: `eval.splits.LeakageError`
- Produces: `WithinCreatorNormalizer` with
  `fit(posts: pd.DataFrame, index: np.ndarray) -> WithinCreatorNormalizer`,
  `transform(posts: pd.DataFrame, index: np.ndarray) -> np.ndarray`,
  `assert_fit_disjoint_from(index: np.ndarray) -> None`

This is the rule most likely to be broken by a refactor, because breaking it improves the number.
The normalizer records the exact row positions its statistics came from, and
`assert_fit_disjoint_from` is what the pipeline calls to prove they never touched test.

- [ ] **Step 1: Write the failing test**

`research/tests/test_normalize.py`:

```python
import numpy as np
import pandas as pd
import pytest

from eval.normalize import WithinCreatorNormalizer
from eval.splits import LeakageError


def _posts() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "creator_id": ["a"] * 5 + ["b"] * 5,
            "label": [10.0, 20.0, 30.0, 40.0, 50.0, 100.0, 200.0, 300.0, 400.0, 500.0],
        }
    )


def test_z_scores_within_each_creator():
    posts = _posts()
    index = np.arange(10)
    z = WithinCreatorNormalizer().fit(posts, index).transform(posts, index)

    # Each creator's own rows are centred on that creator, not on the pool.
    assert abs(float(z[:5].mean())) < 1e-9
    assert abs(float(z[5:].mean())) < 1e-9
    # Both creators' top post maps to the same z despite 10x different scale.
    assert z[4] == pytest.approx(z[9])


def test_unseen_creator_falls_back_to_global_statistics():
    posts = _posts()
    normalizer = WithinCreatorNormalizer().fit(posts, np.arange(5))  # creator "a" only
    z = normalizer.transform(posts, np.arange(5, 10))  # creator "b", cold start
    assert np.isfinite(z).all()


def test_fit_provenance_guard_fires_when_fit_touched_test_rows():
    posts = _posts()
    train = np.arange(0, 8)
    test = np.arange(6, 10)  # deliberately overlaps train
    normalizer = WithinCreatorNormalizer().fit(posts, train)

    with pytest.raises(LeakageError, match="fit on 2 row"):
        normalizer.assert_fit_disjoint_from(test)


def test_fit_provenance_guard_passes_on_a_clean_split():
    posts = _posts()
    normalizer = WithinCreatorNormalizer().fit(posts, np.arange(0, 7))
    normalizer.assert_fit_disjoint_from(np.arange(7, 10))  # must not raise


def test_transform_before_fit_is_an_error():
    posts = _posts()
    with pytest.raises(RuntimeError, match="not fitted"):
        WithinCreatorNormalizer().transform(posts, np.arange(3))


def test_zero_variance_creator_does_not_produce_nan():
    posts = pd.DataFrame({"creator_id": ["a"] * 4, "label": [7.0, 7.0, 7.0, 7.0]})
    index = np.arange(4)
    z = WithinCreatorNormalizer().fit(posts, index).transform(posts, index)
    assert np.isfinite(z).all()
    assert np.allclose(z, 0.0)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd research && ./.venv/bin/python -m pytest tests/test_normalize.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'eval.normalize'`

- [ ] **Step 3: Implement `normalize.py`**

`research/eval/normalize.py`:

```python
"""Within-creator label normalisation, with the fit provenance recorded.

Prereg §7: "Within-creator normalization statistics are fit on train only and
applied to test." Fitting them on everything leaks the outcome distribution and
makes the number BETTER, which is why the rule needs a guard rather than a
convention. This class records the exact row positions its statistics came from,
so `assert_fit_disjoint_from` can prove they never saw test.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from eval.splits import LeakageError


class WithinCreatorNormalizer:
    """Z-scores the label within each creator, using train rows only."""

    def __init__(self) -> None:
        self._stats: dict[str, tuple[float, float]] = {}
        self._global: tuple[float, float] | None = None
        self._fit_positions: frozenset[int] | None = None

    def fit(self, posts: pd.DataFrame, index: np.ndarray) -> "WithinCreatorNormalizer":
        index = np.asarray(index)
        self._fit_positions = frozenset(int(i) for i in index)

        labels = posts["label"].to_numpy()[index]
        creators = posts["creator_id"].to_numpy()[index]

        self._global = (float(labels.mean()), float(labels.std()) or 1.0)
        self._stats = {}
        for creator in np.unique(creators):
            own = labels[creators == creator]
            std = float(own.std())
            self._stats[str(creator)] = (float(own.mean()), std if std > 0.0 else 1.0)
        return self

    def transform(self, posts: pd.DataFrame, index: np.ndarray) -> np.ndarray:
        if self._fit_positions is None or self._global is None:
            raise RuntimeError("WithinCreatorNormalizer is not fitted")

        index = np.asarray(index)
        labels = posts["label"].to_numpy()[index]
        creators = posts["creator_id"].to_numpy()[index]

        out = np.empty(len(index), dtype=float)
        for position, (label, creator) in enumerate(zip(labels, creators)):
            # A creator with no train rows is Regime 2's cold start, which is a
            # legitimate case, not a leak — fall back to the global statistics.
            mean, std = self._stats.get(str(creator), self._global)
            out[position] = (label - mean) / std
        return out

    def assert_fit_disjoint_from(self, index: np.ndarray) -> None:
        """Prereg §7: the statistics must not have been fit on any test row."""
        if self._fit_positions is None:
            raise RuntimeError("WithinCreatorNormalizer is not fitted")
        overlap = self._fit_positions & {int(i) for i in np.asarray(index)}
        if overlap:
            raise LeakageError(
                f"normalizer was fit on {len(overlap)} row(s) that are in the test set"
            )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd research && ./.venv/bin/python -m pytest tests/test_normalize.py -v`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit** _(only if Emre has asked)_

```bash
git add research/eval/normalize.py research/tests/test_normalize.py
git commit -m "feat(research): within-creator normalizer with fit-provenance guard"
```

---

### Task 5: Metrics — per-creator Spearman, pairwise accuracy, top-1

**Files:**

- Create: `research/eval/metrics.py`
- Test: `research/tests/test_metrics.py`

**Interfaces:**

- Consumes: nothing beyond scipy/numpy/pandas
- Produces:
  `per_creator_spearman(posts, index, y_true, y_pred) -> dict[str, float]`,
  `per_creator_pairwise_accuracy(posts, index, y_true, y_pred) -> dict[str, float]`,
  `per_creator_top1(posts, index, y_true, y_pred) -> dict[str, float]`,
  `mean_over_creators(per_creator: dict[str, float]) -> float`.
  In all three, `index` is the integer positions the predictions correspond to, and `y_true`/`y_pred`
  are arrays **aligned to `index`**, not to `posts`.

Creators with fewer than two test posts cannot have a rank correlation and are **excluded**, not
scored as zero. Prereg §8 makes the creator the unit of analysis, so a creator who cannot produce
the statistic contributes nothing rather than a fabricated value.

- [ ] **Step 1: Write the failing test**

`research/tests/test_metrics.py`:

```python
import numpy as np
import pandas as pd
import pytest

from eval.metrics import (
    mean_over_creators,
    per_creator_pairwise_accuracy,
    per_creator_spearman,
    per_creator_top1,
)


def _posts() -> pd.DataFrame:
    return pd.DataFrame({"creator_id": ["a", "a", "a", "b", "b", "b"]})


def test_perfect_ranking_scores_one_per_creator():
    posts = _posts()
    index = np.arange(6)
    y_true = np.array([1.0, 2.0, 3.0, 10.0, 20.0, 30.0])
    rho = per_creator_spearman(posts, index, y_true, y_true.copy())
    assert rho == {"a": pytest.approx(1.0), "b": pytest.approx(1.0)}


def test_reversed_ranking_scores_minus_one():
    posts = _posts()
    index = np.arange(6)
    y_true = np.array([1.0, 2.0, 3.0, 10.0, 20.0, 30.0])
    rho = per_creator_spearman(posts, index, y_true, -y_true)
    assert rho["a"] == pytest.approx(-1.0)


def test_creator_with_one_test_post_is_excluded_not_zeroed():
    posts = pd.DataFrame({"creator_id": ["a", "a", "b"]})
    index = np.arange(3)
    y_true = np.array([1.0, 2.0, 5.0])
    rho = per_creator_spearman(posts, index, y_true, y_true.copy())
    assert set(rho) == {"a"}  # "b" cannot have a rank correlation


def test_mean_over_creators_averages_creators_not_posts():
    # "a" has many posts and "b" has few; both must count equally.
    assert mean_over_creators({"a": 1.0, "b": 0.0}) == pytest.approx(0.5)


def test_mean_over_creators_of_nothing_is_nan():
    assert np.isnan(mean_over_creators({}))


def test_pairwise_accuracy_counts_correctly_ordered_pairs():
    posts = pd.DataFrame({"creator_id": ["a", "a", "a"]})
    index = np.arange(3)
    y_true = np.array([1.0, 2.0, 3.0])
    # Predictions get one of the three pairs backwards.
    y_pred = np.array([1.0, 3.0, 2.0])
    acc = per_creator_pairwise_accuracy(posts, index, y_true, y_pred)
    assert acc["a"] == pytest.approx(2.0 / 3.0)


def test_top1_is_one_when_the_best_post_is_picked():
    posts = pd.DataFrame({"creator_id": ["a", "a", "a"]})
    index = np.arange(3)
    y_true = np.array([1.0, 5.0, 3.0])
    y_pred = np.array([0.0, 9.0, 1.0])
    assert per_creator_top1(posts, index, y_true, y_pred)["a"] == pytest.approx(1.0)


def test_top1_is_zero_when_the_best_post_is_missed():
    posts = pd.DataFrame({"creator_id": ["a", "a", "a"]})
    index = np.arange(3)
    y_true = np.array([1.0, 5.0, 3.0])
    y_pred = np.array([9.0, 0.0, 1.0])
    assert per_creator_top1(posts, index, y_true, y_pred)["a"] == pytest.approx(0.0)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd research && ./.venv/bin/python -m pytest tests/test_metrics.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'eval.metrics'`

- [ ] **Step 3: Implement `metrics.py`**

`research/eval/metrics.py`:

```python
"""Task A metrics, always computed per creator.

Prereg §8: the unit of analysis is the creator, not the post. Posts within a
creator are correlated, and treating them as independent inflates significance.
So every function here returns a dict keyed by creator, and aggregation happens
once, explicitly, in `mean_over_creators`.

A creator with fewer than two test posts is EXCLUDED rather than scored zero. A
rank correlation over one point does not exist, and inventing a value for it
would quietly drag the mean toward zero.
"""

from __future__ import annotations

from itertools import combinations

import numpy as np
import pandas as pd
from scipy.stats import spearmanr


def _by_creator(
    posts: pd.DataFrame, index: np.ndarray
) -> dict[str, np.ndarray]:
    """Map creator -> positions WITHIN the aligned arrays (not into posts)."""
    creators = posts["creator_id"].to_numpy()[np.asarray(index)]
    groups: dict[str, list[int]] = {}
    for position, creator in enumerate(creators):
        groups.setdefault(str(creator), []).append(position)
    return {creator: np.array(positions) for creator, positions in groups.items()}


def per_creator_spearman(
    posts: pd.DataFrame, index: np.ndarray, y_true: np.ndarray, y_pred: np.ndarray
) -> dict[str, float]:
    out: dict[str, float] = {}
    for creator, positions in _by_creator(posts, index).items():
        if len(positions) < 2:
            continue
        rho = spearmanr(y_true[positions], y_pred[positions]).statistic
        if np.isfinite(rho):
            out[creator] = float(rho)
    return out


def per_creator_pairwise_accuracy(
    posts: pd.DataFrame, index: np.ndarray, y_true: np.ndarray, y_pred: np.ndarray
) -> dict[str, float]:
    """"Given two of a creator's posts, do we pick the higher performer?"."""
    out: dict[str, float] = {}
    for creator, positions in _by_creator(posts, index).items():
        if len(positions) < 2:
            continue
        correct = 0
        total = 0
        for i, j in combinations(positions, 2):
            if y_true[i] == y_true[j]:
                continue  # an unordered pair cannot be got right or wrong
            total += 1
            true_order = y_true[i] > y_true[j]
            pred_order = y_pred[i] > y_pred[j]
            correct += int(true_order == pred_order)
        if total:
            out[creator] = correct / total
    return out


def per_creator_top1(
    posts: pd.DataFrame, index: np.ndarray, y_true: np.ndarray, y_pred: np.ndarray
) -> dict[str, float]:
    """Did the highest-predicted post turn out to be the best one?"""
    out: dict[str, float] = {}
    for creator, positions in _by_creator(posts, index).items():
        if len(positions) < 2:
            continue
        best_predicted = positions[int(np.argmax(y_pred[positions]))]
        best_actual = y_true[positions].max()
        out[creator] = float(y_true[best_predicted] == best_actual)
    return out


def mean_over_creators(per_creator: dict[str, float]) -> float:
    """Average the metric across creators. NaN when nothing was measurable."""
    if not per_creator:
        return float("nan")
    return float(np.mean(list(per_creator.values())))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd research && ./.venv/bin/python -m pytest tests/test_metrics.py -v`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit** _(only if Emre has asked)_

```bash
git add research/eval/metrics.py research/tests/test_metrics.py
git commit -m "feat(research): per-creator Task A metrics"
```

---

### Task 6: Statistics — bootstrap over creators, paired Wilcoxon, uplift

**Files:**

- Create: `research/eval/stats.py`
- Test: `research/tests/test_stats.py`

**Interfaces:**

- Consumes: nothing beyond scipy/numpy
- Produces: `Interval` (frozen dataclass: `point: float`, `lo: float`, `hi: float`),
  `bootstrap_over_creators(per_creator: dict[str, float], *, n_boot: int = 2000, seed: int = 0) -> Interval`,
  `paired_uplift(treatment: dict[str, float], baseline: dict[str, float]) -> dict[str, float]`,
  `paired_wilcoxon(treatment: dict[str, float], baseline: dict[str, float]) -> float`,
  `Interval.includes_zero() -> bool`

- [ ] **Step 1: Write the failing test**

`research/tests/test_stats.py`:

```python
import numpy as np
import pytest

from eval.stats import (
    Interval,
    bootstrap_over_creators,
    paired_uplift,
    paired_wilcoxon,
)


def test_bootstrap_point_estimate_is_the_mean():
    values = {f"c{i}": float(i) for i in range(10)}
    interval = bootstrap_over_creators(values, n_boot=500, seed=0)
    assert interval.point == pytest.approx(4.5)


def test_bootstrap_interval_brackets_the_point():
    values = {f"c{i}": float(i) for i in range(30)}
    interval = bootstrap_over_creators(values, n_boot=1000, seed=0)
    assert interval.lo < interval.point < interval.hi


def test_bootstrap_is_deterministic_for_a_seed():
    values = {f"c{i}": float(i % 7) for i in range(25)}
    a = bootstrap_over_creators(values, n_boot=500, seed=3)
    b = bootstrap_over_creators(values, n_boot=500, seed=3)
    assert (a.point, a.lo, a.hi) == (b.point, b.lo, b.hi)


def test_bootstrap_resamples_creators_not_posts():
    # A single creator cannot produce a non-degenerate interval: resampling one
    # creator with replacement always yields that creator.
    interval = bootstrap_over_creators({"only": 2.0}, n_boot=200, seed=0)
    assert interval.lo == pytest.approx(2.0)
    assert interval.hi == pytest.approx(2.0)


def test_includes_zero_detects_a_straddling_interval():
    assert Interval(point=0.02, lo=-0.05, hi=0.09).includes_zero()
    assert not Interval(point=0.20, lo=0.11, hi=0.29).includes_zero()


def test_paired_uplift_uses_only_creators_present_in_both():
    treatment = {"a": 0.5, "b": 0.4, "c": 0.9}
    baseline = {"a": 0.2, "b": 0.4}
    assert paired_uplift(treatment, baseline) == {"a": pytest.approx(0.3), "b": pytest.approx(0.0)}


def test_wilcoxon_finds_a_consistent_difference_significant():
    treatment = {f"c{i}": 0.5 for i in range(20)}
    baseline = {f"c{i}": 0.2 for i in range(20)}
    assert paired_wilcoxon(treatment, baseline) < 0.05


def test_wilcoxon_of_identical_inputs_is_not_significant():
    same = {f"c{i}": 0.3 for i in range(20)}
    assert paired_wilcoxon(same, dict(same)) == pytest.approx(1.0)


def test_wilcoxon_needs_enough_creators():
    assert np.isnan(paired_wilcoxon({"a": 0.5}, {"a": 0.2}))
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd research && ./.venv/bin/python -m pytest tests/test_stats.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'eval.stats'`

- [ ] **Step 3: Implement `stats.py`**

`research/eval/stats.py`:

```python
"""Creator-level statistics.

Prereg §7: "Bootstrap over creators for 95% CIs on each metric and on the
uplift. Paired Wilcoxon signed-rank across creators on per-creator uplift."
Resampling POSTS instead of creators is the classic way to manufacture
significance out of within-creator correlation, so the resampling unit is
explicit here and tested.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.stats import wilcoxon


@dataclass(frozen=True)
class Interval:
    point: float
    lo: float
    hi: float

    def includes_zero(self) -> bool:
        return self.lo <= 0.0 <= self.hi


def bootstrap_over_creators(
    per_creator: dict[str, float], *, n_boot: int = 2000, seed: int = 0
) -> Interval:
    """Percentile bootstrap CI, resampling CREATORS with replacement."""
    values = np.array(list(per_creator.values()), dtype=float)
    if values.size == 0:
        return Interval(point=float("nan"), lo=float("nan"), hi=float("nan"))

    rng = np.random.default_rng(seed)
    draws = rng.integers(0, values.size, size=(n_boot, values.size))
    means = values[draws].mean(axis=1)
    return Interval(
        point=float(values.mean()),
        lo=float(np.percentile(means, 2.5)),
        hi=float(np.percentile(means, 97.5)),
    )


def paired_uplift(
    treatment: dict[str, float], baseline: dict[str, float]
) -> dict[str, float]:
    """Per-creator (treatment - baseline), over creators measurable in both."""
    shared = sorted(set(treatment) & set(baseline))
    return {creator: treatment[creator] - baseline[creator] for creator in shared}


def paired_wilcoxon(
    treatment: dict[str, float], baseline: dict[str, float]
) -> float:
    """Paired Wilcoxon signed-rank across creators. NaN when underpowered."""
    uplift = paired_uplift(treatment, baseline)
    values = np.array(list(uplift.values()), dtype=float)
    if values.size < 5:
        return float("nan")
    if np.allclose(values, 0.0):
        return 1.0  # scipy raises on an all-zero difference vector
    return float(wilcoxon(values).pvalue)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd research && ./.venv/bin/python -m pytest tests/test_stats.py -v`
Expected: PASS — 9 tests

- [ ] **Step 5: Commit** _(only if Emre has asked)_

```bash
git add research/eval/stats.py research/tests/test_stats.py
git commit -m "feat(research): creator-level bootstrap and paired Wilcoxon"
```

---

### Task 7: The model ladder B0–B4

**Files:**

- Create: `research/eval/ladder.py`
- Test: `research/tests/test_ladder.py`

**Interfaces:**

- Consumes: `eval.snapshot.Snapshot`, `eval.snapshot.METADATA_COLUMNS`, `eval.splits.Split`
- Produces: `RUNGS: tuple[str, ...] = ("B0", "B1", "B2", "B3", "B4")`,
  `BASELINE_RUNGS: tuple[str, ...] = ("B1", "B2")`,
  `fit_predict(rung: str, snap: Snapshot, split: Split, y_train: np.ndarray) -> np.ndarray`
  returning predictions aligned to `split.test`,
  `features_for(rung: str, snap: Snapshot) -> np.ndarray | None` (None for B0)

`y_train` is the within-creator normalised target from Task 4, aligned to `split.train`.

- [ ] **Step 1: Write the failing test**

`research/tests/test_ladder.py`:

```python
import numpy as np
import pytest

from eval.ladder import RUNGS, features_for, fit_predict
from eval.normalize import WithinCreatorNormalizer
from eval.snapshot import Snapshot
from eval.splits import regime1_temporal, regime2_grouped
from eval.synth import SIGNAL_WORLD, generate


@pytest.fixture(scope="module")
def snap() -> Snapshot:
    posts, text, neuro = generate(SIGNAL_WORLD)
    return Snapshot(posts=posts, text=text, neuro=neuro, manifest={})


def test_every_rung_predicts_one_value_per_test_row(snap):
    split = regime1_temporal(snap.posts)
    y_train = WithinCreatorNormalizer().fit(snap.posts, split.train).transform(
        snap.posts, split.train
    )
    for rung in RUNGS:
        predictions = fit_predict(rung, snap, split, y_train)
        assert predictions.shape == (len(split.test),)
        assert np.isfinite(predictions).all()


def test_b0_predicts_a_constant_per_creator(snap):
    split = regime1_temporal(snap.posts)
    y_train = WithinCreatorNormalizer().fit(snap.posts, split.train).transform(
        snap.posts, split.train
    )
    predictions = fit_predict("B0", snap, split, y_train)
    creators = snap.posts["creator_id"].to_numpy()[split.test]
    for creator in np.unique(creators):
        own = predictions[creators == creator]
        assert np.allclose(own, own[0])


def test_b0_survives_a_cold_start_creator(snap):
    split = regime2_grouped(snap.posts, seed=0)
    y_train = WithinCreatorNormalizer().fit(snap.posts, split.train).transform(
        snap.posts, split.train
    )
    predictions = fit_predict("B0", snap, split, y_train)
    assert np.isfinite(predictions).all()


def test_features_for_selects_the_right_matrix(snap):
    assert features_for("B0", snap) is None
    assert features_for("B1", snap).shape[1] == 5
    assert features_for("B2", snap).shape[1] == snap.text.shape[1]
    assert features_for("B3", snap).shape[1] == snap.neuro.shape[1]
    assert features_for("B4", snap).shape[1] == 5 + snap.text.shape[1] + snap.neuro.shape[1]


def test_unknown_rung_is_an_error(snap):
    split = regime1_temporal(snap.posts)
    y_train = np.zeros(len(split.train))
    with pytest.raises(ValueError, match="unknown rung"):
        fit_predict("B9", snap, split, y_train)


def test_fit_predict_is_deterministic(snap):
    split = regime1_temporal(snap.posts)
    y_train = WithinCreatorNormalizer().fit(snap.posts, split.train).transform(
        snap.posts, split.train
    )
    a = fit_predict("B3", snap, split, y_train)
    b = fit_predict("B3", snap, split, y_train)
    np.testing.assert_array_equal(a, b)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd research && ./.venv/bin/python -m pytest tests/test_ladder.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'eval.ladder'`

- [ ] **Step 3: Implement `ladder.py`**

`research/eval/ladder.py`:

```python
"""The model ladder from prereg §5.

B0  creator historical mean          null floor
B1  metadata only                    cheap confounders
B2  caption/title text embedding     language-only baseline
B3  TRIBE neuro-features             THE TREATMENT
B4  all three                        ceiling

The models are deliberately boring. Ridge on standardised features is enough to
answer "do these features carry orthogonal signal", and a fancier learner would
add tuning choices that the pre-registration does not cover.
"""

from __future__ import annotations

import numpy as np
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from eval.snapshot import METADATA_COLUMNS, Snapshot
from eval.splits import Split

RUNGS: tuple[str, ...] = ("B0", "B1", "B2", "B3", "B4")

#: The baseline to beat is max(B1, B2), fixed in advance by prereg §5.
BASELINE_RUNGS: tuple[str, ...] = ("B1", "B2")

RIDGE_ALPHA = 1.0


def features_for(rung: str, snap: Snapshot) -> np.ndarray | None:
    """The feature matrix for a rung, or None for B0 which uses no features."""
    metadata = snap.posts[list(METADATA_COLUMNS)].to_numpy(dtype=float)
    if rung == "B0":
        return None
    if rung == "B1":
        return metadata
    if rung == "B2":
        return np.asarray(snap.text, dtype=float)
    if rung == "B3":
        return np.asarray(snap.neuro, dtype=float)
    if rung == "B4":
        return np.hstack(
            [metadata, np.asarray(snap.text, dtype=float), np.asarray(snap.neuro, dtype=float)]
        )
    raise ValueError(f"unknown rung: {rung}")


def _b0(snap: Snapshot, split: Split, y_train: np.ndarray) -> np.ndarray:
    """Predict each creator's own training mean; global mean if unseen."""
    creators = snap.posts["creator_id"].to_numpy()
    train_creators = creators[split.train]
    means = {
        str(creator): float(y_train[train_creators == creator].mean())
        for creator in np.unique(train_creators)
    }
    fallback = float(y_train.mean())
    return np.array([means.get(str(c), fallback) for c in creators[split.test]])


def fit_predict(
    rung: str, snap: Snapshot, split: Split, y_train: np.ndarray
) -> np.ndarray:
    """Fit a rung on train and predict test. Returns values aligned to split.test."""
    if rung not in RUNGS:
        raise ValueError(f"unknown rung: {rung}")
    if rung == "B0":
        return _b0(snap, split, y_train)

    features = features_for(rung, snap)
    assert features is not None  # B0 is the only None, handled above
    model = make_pipeline(StandardScaler(), Ridge(alpha=RIDGE_ALPHA))
    model.fit(features[split.train], y_train)
    return np.asarray(model.predict(features[split.test]), dtype=float)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd research && ./.venv/bin/python -m pytest tests/test_ladder.py -v`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit** _(only if Emre has asked)_

```bash
git add research/eval/ladder.py research/tests/test_ladder.py
git commit -m "feat(research): model ladder B0-B4"
```

---

### Task 8: The negative controls that gate the run

**Files:**

- Create: `research/eval/controls.py`
- Test: `research/tests/test_controls.py`

**Interfaces:**

- Consumes: `eval.snapshot.Snapshot`, `eval.splits.Split`, `eval.normalize.WithinCreatorNormalizer`,
  `eval.ladder.fit_predict`, `eval.metrics.*`, `eval.stats.*`
- Produces: `ControlResult` (frozen dataclass: `name: str`, `passed: bool`, `detail: str`,
  `value: float`),
  `label_shuffle_control(snap, split, *, seed: int = 0) -> ControlResult`,
  `brain_average_control(snap, split) -> ControlResult`,
  `run_controls(snap, split, *, seed: int = 0) -> list[ControlResult]`

- [ ] **Step 1: Write the failing test**

`research/tests/test_controls.py`:

```python
import numpy as np
import pytest

from eval.controls import brain_average_control, label_shuffle_control, run_controls
from eval.snapshot import Snapshot
from eval.splits import regime1_temporal
from eval.synth import CONTAMINATED_WORLD, SIGNAL_WORLD, generate


def _snapshot(world) -> Snapshot:
    posts, text, neuro = generate(world)
    return Snapshot(posts=posts, text=text, neuro=neuro, manifest={})


@pytest.fixture(scope="module")
def clean() -> Snapshot:
    return _snapshot(SIGNAL_WORLD)


@pytest.fixture(scope="module")
def contaminated() -> Snapshot:
    return _snapshot(CONTAMINATED_WORLD)


def test_label_shuffle_passes_on_clean_data(clean):
    split = regime1_temporal(clean.posts)
    result = label_shuffle_control(clean, split, seed=0)
    assert result.passed, result.detail


def test_label_shuffle_catches_a_leaked_label(contaminated):
    # The contaminated world copies the label into a neuro column. Shuffling the
    # labels must destroy the correlation; if it does not, the features already
    # contain the answer.
    split = regime1_temporal(contaminated.posts)
    result = label_shuffle_control(contaminated, split, seed=0)
    assert not result.passed
    assert "shuffle" in result.detail.lower()


def test_brain_average_control_fails_to_predict_on_clean_data(clean):
    # Replicating the known negative result: a naive average across neuro
    # dimensions must NOT clear the Green bar.
    split = regime1_temporal(clean.posts)
    result = brain_average_control(clean, split)
    assert result.passed, result.detail
    assert abs(result.value) < 0.10


def test_run_controls_returns_one_result_per_control(clean):
    split = regime1_temporal(clean.posts)
    results = run_controls(clean, split, seed=0)
    assert {r.name for r in results} == {"label_shuffle", "brain_average"}


def test_controls_are_deterministic(clean):
    split = regime1_temporal(clean.posts)
    a = label_shuffle_control(clean, split, seed=5)
    b = label_shuffle_control(clean, split, seed=5)
    assert a.value == b.value
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd research && ./.venv/bin/python -m pytest tests/test_controls.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'eval.controls'`

- [ ] **Step 3: Implement `controls.py`**

`research/eval/controls.py`:

```python
"""The negative controls, which run BEFORE the primary result.

Prereg §7: "Negative controls, run before reading the primary result.
Label-shuffle within creator — every model must collapse to chance; if B3 still
'predicts', there is leakage, and the run is void until it is found. Naive
brain-wide-average baseline must fail, replicating the known negative result."

Ordering them before the ladder is what makes them a gate rather than a
footnote. See `cli.run`, which stops on failure and emits no primary result.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from eval.ladder import fit_predict
from eval.metrics import mean_over_creators, per_creator_spearman
from eval.normalize import WithinCreatorNormalizer
from eval.snapshot import Snapshot
from eval.splits import Split

#: A shuffled-label run must land inside this band around zero. Wider than a
#: point test, because a finite cohort will not produce exactly 0.000.
SHUFFLE_TOLERANCE = 0.10

#: The naive brain-wide average must not clear the pre-registered Green bar.
BRAIN_AVERAGE_CEILING = 0.10


@dataclass(frozen=True)
class ControlResult:
    name: str
    passed: bool
    detail: str
    value: float


def _rho_for(snap: Snapshot, split: Split, predictions: np.ndarray) -> float:
    y_true = snap.posts["label"].to_numpy()[split.test]
    return mean_over_creators(
        per_creator_spearman(snap.posts, split.test, y_true, predictions)
    )


def label_shuffle_control(
    snap: Snapshot, split: Split, *, seed: int = 0
) -> ControlResult:
    """Shuffle labels within each creator; B3 must collapse to chance."""
    rng = np.random.default_rng(seed)
    shuffled = snap.posts.copy()
    labels = shuffled["label"].to_numpy().copy()
    creators = shuffled["creator_id"].to_numpy()
    for creator in np.unique(creators):
        mask = creators == creator
        own = labels[mask]
        rng.shuffle(own)
        labels[mask] = own
    shuffled["label"] = labels

    shuffled_snap = Snapshot(
        posts=shuffled, text=snap.text, neuro=snap.neuro, manifest=snap.manifest
    )
    normalizer = WithinCreatorNormalizer().fit(shuffled, split.train)
    y_train = normalizer.transform(shuffled, split.train)
    predictions = fit_predict("B3", shuffled_snap, split, y_train)
    rho = _rho_for(shuffled_snap, split, predictions)

    passed = bool(np.isfinite(rho)) and abs(rho) < SHUFFLE_TOLERANCE
    detail = (
        f"B3 on shuffled labels scored rho={rho:.3f}; "
        f"expected |rho| < {SHUFFLE_TOLERANCE}. "
        + (
            "Collapsed to chance as required."
            if passed
            else "Label shuffle did NOT destroy the signal — the features contain "
            "the answer. The run is void until the leak is found."
        )
    )
    return ControlResult(name="label_shuffle", passed=passed, detail=detail, value=float(rho))


def brain_average_control(snap: Snapshot, split: Split) -> ControlResult:
    """The naive brain-wide average must fail (arXiv 2607.01400)."""
    average = np.asarray(snap.neuro, dtype=float).mean(axis=1)
    rho = _rho_for(snap, split, average[split.test])

    passed = not (np.isfinite(rho) and rho >= BRAIN_AVERAGE_CEILING)
    detail = (
        f"naive brain-wide average scored rho={rho:.3f}; "
        f"expected < {BRAIN_AVERAGE_CEILING}. "
        + (
            "Failed as the literature predicts."
            if passed
            else "The naive average PREDICTS, which contradicts the known negative "
            "result and means the setup is not measuring what it claims."
        )
    )
    return ControlResult(name="brain_average", passed=passed, detail=detail, value=float(rho))


def run_controls(snap: Snapshot, split: Split, *, seed: int = 0) -> list[ControlResult]:
    return [
        label_shuffle_control(snap, split, seed=seed),
        brain_average_control(snap, split),
    ]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd research && ./.venv/bin/python -m pytest tests/test_controls.py -v`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit** _(only if Emre has asked)_

```bash
git add research/eval/controls.py research/tests/test_controls.py
git commit -m "feat(research): label-shuffle and brain-average negative controls"
```

---

### Task 9: The verdict, computed with Red-first precedence

**Files:**

- Create: `research/eval/verdict.py`
- Test: `research/tests/test_verdict.py`

**Interfaces:**

- Consumes: `eval.stats.Interval`
- Produces: `GREEN`, `YELLOW`, `RED`, `VOID` string constants,
  `DELTA_RHO_THRESHOLD = 0.10`, `ALPHA = 0.05`,
  `verdict(uplift: Interval, p_value: float) -> str`,
  `explain(uplift: Interval, p_value: float) -> str`

- [ ] **Step 1: Write the failing test**

`research/tests/test_verdict.py`:

```python
import numpy as np

from eval.stats import Interval
from eval.verdict import GREEN, RED, YELLOW, explain, verdict


def test_clear_win_is_green():
    assert verdict(Interval(point=0.18, lo=0.11, hi=0.25), p_value=0.001) == GREEN


def test_no_lift_is_red():
    assert verdict(Interval(point=0.01, lo=-0.06, hi=0.08), p_value=0.7) == RED


def test_positive_but_under_threshold_is_yellow():
    assert verdict(Interval(point=0.06, lo=0.02, hi=0.10), p_value=0.01) == YELLOW


def test_over_threshold_but_not_significant_is_yellow():
    assert verdict(Interval(point=0.14, lo=0.01, hi=0.27), p_value=0.09) == YELLOW


def test_red_takes_precedence_over_yellow_when_bands_overlap():
    # THE ambiguity the spec's amendment resolves: a positive point estimate
    # below threshold whose CI includes zero satisfies both Yellow and Red.
    # Red wins, decided before any data existed.
    assert verdict(Interval(point=0.04, lo=-0.02, hi=0.10), p_value=0.30) == RED


def test_red_takes_precedence_even_over_a_green_sized_point_estimate():
    # A big point estimate with a CI through zero is not a demonstrated lift.
    assert verdict(Interval(point=0.22, lo=-0.03, hi=0.47), p_value=0.06) == RED


def test_nan_p_value_cannot_be_green():
    assert verdict(Interval(point=0.20, lo=0.10, hi=0.30), p_value=float("nan")) == YELLOW


def test_explain_names_the_deciding_rule():
    assert "confidence interval" in explain(
        Interval(point=0.01, lo=-0.06, hi=0.08), p_value=0.7
    )
    assert "threshold" in explain(Interval(point=0.06, lo=0.02, hi=0.10), p_value=0.01)


def test_nan_interval_is_red():
    nan = float("nan")
    assert verdict(Interval(point=nan, lo=nan, hi=nan), p_value=nan) == RED
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd research && ./.venv/bin/python -m pytest tests/test_verdict.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'eval.verdict'`

- [ ] **Step 3: Implement `verdict.py`**

`research/eval/verdict.py`:

```python
"""The go/no-go call, computed rather than chosen.

The pre-registration commits to a threshold. A human applying that threshold
after seeing the numbers is the failure mode the document exists to prevent, so
the band is computed here and the report renders whatever it says.

PRECEDENCE IS RED-FIRST, and that is not arbitrary. Prereg §6's three bands are
not mutually exclusive as written: a positive point estimate below 0.10 whose
95% CI includes zero satisfies BOTH Yellow ("positive but sub-threshold") and
Red ("CI includes 0"). Resolved in the design spec, before any data existed:

  1. RED    if the CI on the uplift includes zero  (no demonstrated lift)
  2. GREEN  if uplift >= 0.10 and p < 0.05
  3. YELLOW otherwise

Do not reorder these. The ordering is the commitment.
"""

from __future__ import annotations

import math

from eval.stats import Interval

GREEN = "GREEN"
YELLOW = "YELLOW"
RED = "RED"
VOID = "VOID"

DELTA_RHO_THRESHOLD = 0.10
ALPHA = 0.05


def verdict(uplift: Interval, p_value: float) -> str:
    # An unmeasurable result is not a pass. NaN anywhere means RED.
    if math.isnan(uplift.point) or math.isnan(uplift.lo) or math.isnan(uplift.hi):
        return RED
    if uplift.includes_zero():
        return RED
    if (
        uplift.point >= DELTA_RHO_THRESHOLD
        and not math.isnan(p_value)
        and p_value < ALPHA
    ):
        return GREEN
    return YELLOW


def explain(uplift: Interval, p_value: float) -> str:
    """One sentence naming the rule that decided the band."""
    band = verdict(uplift, p_value)
    if band == RED:
        if math.isnan(uplift.point):
            return "RED: the uplift could not be measured."
        return (
            f"RED: the 95% confidence interval on the uplift "
            f"[{uplift.lo:.3f}, {uplift.hi:.3f}] includes zero, so no lift is demonstrated."
        )
    if band == GREEN:
        return (
            f"GREEN: uplift {uplift.point:.3f} clears the {DELTA_RHO_THRESHOLD:.2f} "
            f"threshold at p={p_value:.4f}."
        )
    if uplift.point < DELTA_RHO_THRESHOLD:
        return (
            f"YELLOW: uplift {uplift.point:.3f} is positive but below the "
            f"{DELTA_RHO_THRESHOLD:.2f} threshold."
        )
    return (
        f"YELLOW: uplift {uplift.point:.3f} clears the threshold but is not "
        f"significant (p={p_value:.4f}, alpha={ALPHA})."
    )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd research && ./.venv/bin/python -m pytest tests/test_verdict.py -v`
Expected: PASS — 9 tests

- [ ] **Step 5: Commit** _(only if Emre has asked)_

```bash
git add research/eval/verdict.py research/tests/test_verdict.py
git commit -m "feat(research): mechanical verdict with Red-first precedence"
```

---

### Task 10: The report

**Files:**

- Create: `research/eval/report.py`
- Test: `research/tests/test_report.py`

**Interfaces:**

- Consumes: nothing beyond stdlib/numpy
- Produces: `write_results(out_dir: Path, payload: dict) -> None`,
  `render_report(payload: dict) -> str`

The payload shape is fixed here and consumed by Task 11:

```python
{
  "snapshot": {...},                  # the snapshot's manifest verbatim
  "seed": int,
  "voided": bool,
  "controls": [{"name","passed","detail","value"}, ...],
  "regimes": {
     "<regime name>": {
        "rungs": {"B0": {"rho": float, "lo": float, "hi": float}, ...},
        "baseline_rung": "B1" | "B2",
        "uplift": {"point": float, "lo": float, "hi": float},
        "p_value": float,
        "pairwise_accuracy": float,
        "top1": float,
        "verdict": "GREEN" | "YELLOW" | "RED",
        "explanation": str,
     }, ...
  },
  "verdict": "GREEN" | "YELLOW" | "RED" | "VOID",
}
```

- [ ] **Step 1: Write the failing test**

`research/tests/test_report.py`:

```python
import json

from eval.report import render_report, write_results

PAYLOAD = {
    "snapshot": {"producer": "synthetic", "rows": 1000, "creators": 40},
    "seed": 0,
    "voided": False,
    "controls": [
        {"name": "label_shuffle", "passed": True, "detail": "collapsed", "value": 0.01},
        {"name": "brain_average", "passed": True, "detail": "failed as expected", "value": 0.02},
    ],
    "regimes": {
        "regime1_temporal": {
            "rungs": {
                "B0": {"rho": 0.01, "lo": -0.02, "hi": 0.04},
                "B1": {"rho": 0.12, "lo": 0.08, "hi": 0.16},
                "B2": {"rho": 0.09, "lo": 0.05, "hi": 0.13},
                "B3": {"rho": 0.31, "lo": 0.26, "hi": 0.36},
                "B4": {"rho": 0.34, "lo": 0.29, "hi": 0.39},
            },
            "baseline_rung": "B1",
            "uplift": {"point": 0.19, "lo": 0.14, "hi": 0.24},
            "p_value": 0.0001,
            "pairwise_accuracy": 0.68,
            "top1": 0.42,
            "verdict": "GREEN",
            "explanation": "GREEN: uplift 0.190 clears the 0.10 threshold at p=0.0001.",
        }
    },
    "verdict": "GREEN",
}


def test_write_results_emits_readable_json(tmp_path):
    write_results(tmp_path, PAYLOAD)
    loaded = json.loads((tmp_path / "results.json").read_text())
    assert loaded["verdict"] == "GREEN"
    assert loaded["regimes"]["regime1_temporal"]["uplift"]["point"] == 0.19


def test_write_results_also_writes_the_markdown_report(tmp_path):
    write_results(tmp_path, PAYLOAD)
    assert (tmp_path / "report.md").exists()


def test_report_leads_with_the_verdict():
    report = render_report(PAYLOAD)
    assert report.splitlines()[0].startswith("# ")
    assert "GREEN" in report


def test_report_shows_every_rung_and_the_uplift():
    report = render_report(PAYLOAD)
    for rung in ("B0", "B1", "B2", "B3", "B4"):
        assert rung in report
    assert "0.190" in report or "0.19" in report


def test_voided_report_says_so_and_shows_no_verdict_band():
    voided = dict(PAYLOAD)
    voided["voided"] = True
    voided["verdict"] = "VOID"
    voided["regimes"] = {}
    voided["controls"] = [
        {"name": "label_shuffle", "passed": False, "detail": "still predicts", "value": 0.44}
    ]
    report = render_report(voided)
    assert "VOID" in report
    assert "still predicts" in report
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd research && ./.venv/bin/python -m pytest tests/test_report.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'eval.report'`

- [ ] **Step 3: Implement `report.py`**

`research/eval/report.py`:

```python
"""The diligence artifact: results.json plus a one-page Markdown report.

The report renders whatever `verdict.py` decided. There is no path here that
lets a human choose a different headline, which is the point.
"""

from __future__ import annotations

import json
from pathlib import Path

RESULTS_FILE = "results.json"
REPORT_FILE = "report.md"


def write_results(out_dir: Path, payload: dict) -> None:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / RESULTS_FILE).write_text(json.dumps(payload, indent=2, default=str) + "\n")
    (out_dir / REPORT_FILE).write_text(render_report(payload))


def _rung_table(rungs: dict) -> list[str]:
    lines = [
        "| Rung | within-creator rho | 95% CI |",
        "| ---- | ------------------ | ------ |",
    ]
    for name, values in rungs.items():
        lines.append(
            f"| {name} | {values['rho']:.3f} | "
            f"[{values['lo']:.3f}, {values['hi']:.3f}] |"
        )
    return lines


def render_report(payload: dict) -> str:
    verdict = payload.get("verdict", "VOID")
    lines: list[str] = [
        f"# Validation result — {verdict}",
        "",
        f"Snapshot: `{payload['snapshot'].get('producer', 'unknown')}` · "
        f"{payload['snapshot'].get('rows', '?')} posts · "
        f"{payload['snapshot'].get('creators', '?')} creators · seed {payload.get('seed')}",
        "",
        "## Negative controls",
        "",
    ]
    for control in payload.get("controls", []):
        mark = "PASS" if control["passed"] else "FAIL"
        lines.append(f"- **{control['name']}** — {mark}. {control['detail']}")

    if payload.get("voided"):
        lines += [
            "",
            "## VOID",
            "",
            "A negative control failed, so the primary result was not computed. "
            "Per the pre-registration the run is void until the cause is found.",
            "",
        ]
        return "\n".join(lines) + "\n"

    for name, regime in payload.get("regimes", {}).items():
        lines += [
            "",
            f"## {name}",
            "",
            *_rung_table(regime["rungs"]),
            "",
            f"**Baseline to beat:** {regime['baseline_rung']} (max of B1, B2)",
            "",
            f"**Uplift B3 − baseline:** {regime['uplift']['point']:.3f} "
            f"[{regime['uplift']['lo']:.3f}, {regime['uplift']['hi']:.3f}], "
            f"p = {regime['p_value']:.4g}",
            "",
            f"**Pairwise accuracy (secondary):** {regime['pairwise_accuracy']:.3f} · "
            f"**Top-1:** {regime['top1']:.3f}",
            "",
            f"**Verdict:** {regime['explanation']}",
        ]

    return "\n".join(lines) + "\n"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd research && ./.venv/bin/python -m pytest tests/test_report.py -v`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit** _(only if Emre has asked)_

```bash
git add research/eval/report.py research/tests/test_report.py
git commit -m "feat(research): results.json and the markdown report"
```

---

### Task 11: The pipeline, the CLI, and the four-world end-to-end tests

**Files:**

- Create: `research/eval/cli.py`
- Create: `research/eval/__main__.py`
- Create: `research/README.md`
- Test: `research/tests/test_end_to_end.py`

**Interfaces:**

- Consumes: every module above
- Produces: `run(snapshot_dir: Path, out_dir: Path, *, seed: int = 0) -> dict` (the payload from
  Task 10), `main(argv: list[str] | None = None) -> int`

This is where the ordering commitment lives: controls run before the ladder, and a failure returns a
voided payload without computing a primary result.

- [ ] **Step 1: Write the failing test**

`research/tests/test_end_to_end.py`:

```python
import json

import pytest

from eval.cli import run
from eval.synth import CONTAMINATED_WORLD, NULL_WORLD, SIGNAL_WORLD, write_world
from eval.verdict import GREEN, RED, VOID


@pytest.fixture(scope="module")
def signal_snapshot(tmp_path_factory):
    path = tmp_path_factory.mktemp("signal")
    write_world(SIGNAL_WORLD, path)
    return path


@pytest.fixture(scope="module")
def null_snapshot(tmp_path_factory):
    path = tmp_path_factory.mktemp("null")
    write_world(NULL_WORLD, path)
    return path


@pytest.fixture(scope="module")
def contaminated_snapshot(tmp_path_factory):
    path = tmp_path_factory.mktemp("contaminated")
    write_world(CONTAMINATED_WORLD, path)
    return path


def test_signal_world_returns_green(signal_snapshot, tmp_path):
    payload = run(signal_snapshot, tmp_path, seed=0)
    assert payload["verdict"] == GREEN
    assert not payload["voided"]


def test_null_world_returns_red(null_snapshot, tmp_path):
    payload = run(null_snapshot, tmp_path, seed=0)
    assert payload["verdict"] == RED


def test_contaminated_world_voids_the_run(contaminated_snapshot, tmp_path):
    payload = run(contaminated_snapshot, tmp_path, seed=0)
    assert payload["verdict"] == VOID
    assert payload["voided"]
    # The gate is upstream: no primary result is computed at all.
    assert payload["regimes"] == {}


def test_run_writes_both_artifacts(signal_snapshot, tmp_path):
    run(signal_snapshot, tmp_path, seed=0)
    assert (tmp_path / "results.json").exists()
    assert (tmp_path / "report.md").exists()


def test_run_reports_both_regimes(signal_snapshot, tmp_path):
    payload = run(signal_snapshot, tmp_path, seed=0)
    assert set(payload["regimes"]) == {"regime1_temporal", "regime2_grouped"}


def test_run_is_reproducible_from_the_same_seed(signal_snapshot, tmp_path):
    a = run(signal_snapshot, tmp_path / "a", seed=0)
    b = run(signal_snapshot, tmp_path / "b", seed=0)
    assert json.dumps(a, default=str, sort_keys=True) == json.dumps(
        b, default=str, sort_keys=True
    )


def test_baseline_is_the_stronger_of_b1_and_b2(signal_snapshot, tmp_path):
    payload = run(signal_snapshot, tmp_path, seed=0)
    for regime in payload["regimes"].values():
        rungs = regime["rungs"]
        stronger = "B1" if rungs["B1"]["rho"] >= rungs["B2"]["rho"] else "B2"
        assert regime["baseline_rung"] == stronger
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd research && ./.venv/bin/python -m pytest tests/test_end_to_end.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'eval.cli'`

- [ ] **Step 3: Implement `cli.py`**

`research/eval/cli.py`:

```python
"""The pipeline, in the order the pre-registration requires.

    load -> split -> assemble features
         -> CONTROLS  -- fail --> VOID, stop, emit nothing further
         -> fit/predict ladder -> metrics -> stats -> verdict -> report

Controls sit BEFORE the ladder because prereg §7 requires them to run before the
primary result is read. Ordering them later would mean computing the number
first and deciding afterwards whether we were allowed to look at it.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

from eval.controls import run_controls
from eval.ladder import BASELINE_RUNGS, RUNGS, fit_predict
from eval.metrics import (
    mean_over_creators,
    per_creator_pairwise_accuracy,
    per_creator_spearman,
    per_creator_top1,
)
from eval.normalize import WithinCreatorNormalizer
from eval.report import write_results
from eval.snapshot import Snapshot, load_snapshot
from eval.splits import (
    Split,
    assert_no_creator_overlap,
    assert_time_order,
    regime1_temporal,
    regime2_grouped,
)
from eval.stats import bootstrap_over_creators, paired_uplift, paired_wilcoxon
from eval.synth import CONTAMINATED_WORLD, NULL_WORLD, SIGNAL_WORLD, write_world
from eval.verdict import VOID, explain, verdict

WORLDS = {
    "signal": SIGNAL_WORLD,
    "null": NULL_WORLD,
    "contaminated": CONTAMINATED_WORLD,
}


def _evaluate_regime(snap: Snapshot, split: Split, *, seed: int) -> dict:
    # The leakage rules, enforced rather than trusted.
    assert_time_order(snap.posts, split)
    if split.name == "regime2_grouped":
        assert_no_creator_overlap(snap.posts, split)

    normalizer = WithinCreatorNormalizer().fit(snap.posts, split.train)
    normalizer.assert_fit_disjoint_from(split.test)
    y_train = normalizer.transform(snap.posts, split.train)

    y_true = snap.posts["label"].to_numpy()[split.test]

    per_creator: dict[str, dict[str, float]] = {}
    predictions: dict[str, np.ndarray] = {}
    rungs: dict[str, dict[str, float]] = {}
    for rung in RUNGS:
        predictions[rung] = fit_predict(rung, snap, split, y_train)
        rho_by_creator = per_creator_spearman(
            snap.posts, split.test, y_true, predictions[rung]
        )
        per_creator[rung] = rho_by_creator
        interval = bootstrap_over_creators(rho_by_creator, seed=seed)
        rungs[rung] = {"rho": interval.point, "lo": interval.lo, "hi": interval.hi}

    # The baseline to beat is max(B1, B2), decided by which scores higher here.
    baseline_rung = max(BASELINE_RUNGS, key=lambda r: rungs[r]["rho"])
    uplift_by_creator = paired_uplift(per_creator["B3"], per_creator[baseline_rung])
    uplift = bootstrap_over_creators(uplift_by_creator, seed=seed)
    p_value = paired_wilcoxon(per_creator["B3"], per_creator[baseline_rung])

    return {
        "rungs": rungs,
        "baseline_rung": baseline_rung,
        "uplift": {"point": uplift.point, "lo": uplift.lo, "hi": uplift.hi},
        "p_value": p_value,
        "pairwise_accuracy": mean_over_creators(
            per_creator_pairwise_accuracy(
                snap.posts, split.test, y_true, predictions["B3"]
            )
        ),
        "top1": mean_over_creators(
            per_creator_top1(snap.posts, split.test, y_true, predictions["B3"])
        ),
        "verdict": verdict(uplift, p_value),
        "explanation": explain(uplift, p_value),
    }


def run(snapshot_dir: Path, out_dir: Path, *, seed: int = 0) -> dict:
    snap = load_snapshot(Path(snapshot_dir))

    # Controls run on Regime 1, which is the regime with a per-creator history
    # to shuffle within.
    gate_split = regime1_temporal(snap.posts)
    controls = run_controls(snap, gate_split, seed=seed)

    payload: dict = {
        "snapshot": snap.manifest,
        "seed": seed,
        "voided": False,
        "controls": [
            {
                "name": c.name,
                "passed": c.passed,
                "detail": c.detail,
                "value": c.value,
            }
            for c in controls
        ],
        "regimes": {},
        "verdict": VOID,
    }

    if not all(c.passed for c in controls):
        payload["voided"] = True
        write_results(Path(out_dir), payload)
        return payload

    regimes = {
        "regime1_temporal": gate_split,
        "regime2_grouped": regime2_grouped(snap.posts, seed=seed),
    }
    for name, split in regimes.items():
        payload["regimes"][name] = _evaluate_regime(snap, split, seed=seed)

    # Regime 1 is the production-mirroring regime, so its band is the headline.
    payload["verdict"] = payload["regimes"]["regime1_temporal"]["verdict"]
    write_results(Path(out_dir), payload)
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="eval")
    sub = parser.add_subparsers(dest="command", required=True)

    run_cmd = sub.add_parser("run", help="evaluate a snapshot")
    run_cmd.add_argument("--snapshot", required=True, type=Path)
    run_cmd.add_argument("--out", required=True, type=Path)
    run_cmd.add_argument("--seed", type=int, default=0)

    synth_cmd = sub.add_parser("synth", help="write a synthetic snapshot")
    synth_cmd.add_argument("--world", choices=sorted(WORLDS), default="signal")
    synth_cmd.add_argument("--out", required=True, type=Path)

    args = parser.parse_args(argv)

    if args.command == "synth":
        write_world(WORLDS[args.world], args.out)
        print(f"wrote {args.world} snapshot to {args.out}")
        return 0

    payload = run(args.snapshot, args.out, seed=args.seed)
    print(f"{payload['verdict']} — see {args.out / 'report.md'}")
    return 0
```

`research/eval/__main__.py`:

```python
import sys

from eval.cli import main

sys.exit(main())
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd research && ./.venv/bin/python -m pytest tests/test_end_to_end.py -v`
Expected: PASS — 7 tests

- [ ] **Step 5: Run the whole suite**

Run: `cd research && ./.venv/bin/python -m pytest`
Expected: PASS — all tests across every module

- [ ] **Step 6: Verify the CLI end to end by hand**

```bash
cd research
./.venv/bin/python -m eval synth --world signal --out /tmp/snap-signal
./.venv/bin/python -m eval run --snapshot /tmp/snap-signal --out /tmp/out-signal
cat /tmp/out-signal/report.md
```

Expected: prints `GREEN — see /tmp/out-signal/report.md`, and the report shows five rungs, the
uplift with a CI, and both regimes.

```bash
./.venv/bin/python -m eval synth --world contaminated --out /tmp/snap-bad
./.venv/bin/python -m eval run --snapshot /tmp/snap-bad --out /tmp/out-bad
```

Expected: prints `VOID`, and `report.md` names the failed control and shows no rung table.

- [ ] **Step 7: Write `research/README.md`**

````markdown
# research/

The eval harness for the pre-registered validation experiment. **Nothing here deploys** — that is
why it sits beside `apps/` rather than inside it.

Design: [`docs/superpowers/specs/2026-08-08-validation-eval-harness-design.md`](../docs/superpowers/specs/2026-08-08-validation-eval-harness-design.md)
Commitment: [`docs/validation-prereg.md`](../docs/validation-prereg.md)

## Why it exists before the data does

The pre-registration locks one metric, one label, one baseline and a Δρ ≥ 0.10 bar. That is prose,
and prose does not enforce itself. This package turns each of its leakage rules into an assertion,
runs the negative controls as a gate rather than a footnote, and computes the Green/Yellow/Red band
mechanically so nobody picks it after seeing the numbers.

Writing it now is also the only chance to test the statistics against a known answer. With real data
nobody knows the right result, so a harness that computes the wrong Spearman looks exactly like one
that computes the right one.

## Run it

```bash
python -m venv .venv && ./.venv/bin/pip install -r requirements.txt
./.venv/bin/python -m pytest

./.venv/bin/python -m eval synth --world signal --out ./snapshots/signal
./.venv/bin/python -m eval run --snapshot ./snapshots/signal --out ./out/signal
```

`--world` is one of `signal` (must return GREEN), `null` (must return RED) or `contaminated` (must
VOID the run).

## The snapshot format is the contract

```text
snapshot/
  posts.parquet            post_id, creator_id, published_at, label, view_count, format,
                           duration_sec, hashtag_count, published_hour, published_dow,
                           follower_count
  features/b2_text.npy     [rows x dims], row-aligned to posts.parquet
  features/b3_neuro.npy    [rows x dims], row-aligned to posts.parquet
  manifest.json            version, producer, seed, rows, creators, dims, checksums
```

`label` is **`averageViewPercentage`** — the single primary label. `view_count` exists only to apply
the inclusion threshold and is never a feature.

## The deferred Postgres extract

Only the synthetic producer exists today. The extract is deliberately not written: the research
tables have never held a row, so anything written against them now is guesswork that gets rewritten
once real backfill exists. When it is written, it becomes a second producer of the format above —
the harness does not change.

Sketch, for whoever writes it:

- `posts.parquet` ← `posts` joined to `post_metric_snapshots` (latest per post) and `channels` for
  `follower_count`; `label` ← `post_labels.raw_value` where `kind = 'COMPLETION_RATE'`.
- `features/b3_neuro.npy` ← `feature_artifacts` rows for the post, fetched from object storage by
  `storage_bucket`/`storage_path` and verified against `checksum`.
- Inclusion (view threshold, ≥ 20 posts per creator) is applied in the extract, so a snapshot is
  always already eligible.
- `post_labels.split_tag` exists so the train/test rule is checkable in SQL. Once both exist,
  reconcile this package's splits against it rather than letting them disagree silently.

## Conventions

- **No torch.** This package evaluates predictions; it never runs a model.
- **Everything is seeded.** A run must be reproducible from its manifest.
- **Red-first precedence** in `verdict.py` is a commitment, not a style choice. Do not reorder it.
````

- [ ] **Step 8: Commit** _(only if Emre has asked)_

```bash
git add research/
git commit -m "feat(research): pipeline, CLI, README and four-world end-to-end tests"
```

---

### Task 12: Wire `research/` into the monorepo

**Files:**

- Modify: `package.json` (add `test:research`, extend `test`)
- Modify: `README.md` (Layout section)
- Modify: `CLAUDE.md` (Layout section, Commands section, TODO)
- Modify: `docs/README.md` (point at the harness from the validation notes)

**Interfaces:**

- Consumes: the finished `research/` package
- Produces: `bun run test:research`, and `bun run test` covering it

- [ ] **Step 1: Add the test scripts**

In `package.json`, mirror the existing `test:ml` pattern exactly — it fails with a pointer rather
than a confusing traceback when the venv is missing:

```json
"test": "turbo run test && bun run test:ml && bun run test:research",
"test:research": "cd research && sh -c '[ -x .venv/bin/python ] || { echo \"research/.venv is missing — see research/README.md\"; exit 1; }; .venv/bin/python -m pytest'",
```

- [ ] **Step 2: Verify the script works**

Run: `bun run test:research`
Expected: the full pytest suite passes.

Run: `bun run test`
Expected: turbo tasks, then `apps/ml` pytest, then `research` pytest — all green.

- [ ] **Step 3: Update the root `README.md` Layout block**

Add the directory to the tree in the Layout section:

```text
├── infra/              Docker (local Redis + bull-board), deploy
└── research/           Eval harness for the validation experiment (Python island; never deploys)
```

And add to the "From a fresh clone" section, after the `apps/ml` venv step:

```bash
# 4b. the second Python island — only needed to run the eval harness
cd research && python -m venv .venv && ./.venv/bin/pip install -r requirements.txt
```

- [ ] **Step 4: Update `CLAUDE.md`**

In the Layout section, add the line:

```text
research/ eval harness for the pre-registered validation experiment (Python island, never deploys)
```

In Commands, add:

```bash
bun run test:research       # the eval harness suite (needs research/.venv)
```

In the TODO's "Decisions still open" block, replace the validation-cohort bullet's opening so it
records what now exists:

```markdown
- **Validation cohort acquisition** — the gating dependency for the whole experiment. The _analysis_
  is no longer a dependency: `research/` implements it against synthetic ground truth, so the day a
  cohort lands the harness runs. What remains is acquisition. See
  `docs/validation-experiment-spec.md` §11a: YouTube gives no source video files, so the corpus
  needs a paid or design-partner motion, not an ask.
```

- [ ] **Step 5: Update `docs/README.md`**

In the technical-appendix list, after the pre-registration entry, add:

```markdown
The analysis those two describe is implemented in [`research/`](../research/) — built against
synthetic data with known ground truth so the statistics could be tested before any real result
existed. It enforces the prereg's leakage rules as assertions and computes the Green/Yellow/Red band
mechanically.
```

- [ ] **Step 6: Run the full verification**

```bash
bun run format
bunx turbo run typecheck lint
bun run test
```

Expected: all green. (The `research/` directory has no TypeScript, so turbo is unaffected; this
confirms nothing was broken by the `package.json` edit.)

- [ ] **Step 7: Commit** _(only if Emre has asked)_

```bash
git add package.json README.md CLAUDE.md docs/README.md
git commit -m "docs: wire research/ into the monorepo docs and test scripts"
```

---

## Self-Review

**Spec coverage.** Every section of the design spec maps to a task:

| Spec section                                                              | Task |
| ------------------------------------------------------------------------- | ---- |
| Snapshot layout + manifest validation                                     | 1    |
| Ground-truth generator, orthogonal signal direction                       | 2    |
| Regimes 1 & 2, creator-overlap and time-order rules                       | 3    |
| Normalizer fit-on-train-only rule                                         | 4    |
| Within-creator Spearman, pairwise accuracy, top-1                         | 5    |
| Bootstrap over creators, paired Wilcoxon                                  | 6    |
| Ladder B0–B4, baseline = max(B1,B2)                                       | 7    |
| Label-shuffle and brain-average controls                                  | 8    |
| Red-first verdict precedence                                              | 9    |
| results.json + report.md                                                  | 10   |
| Controls-gate ordering, four worlds, CLI, README, deferred-extract sketch | 11   |
| `research/` as a documented top-level island                              | 12   |

The spec's "features are pre-publication only" rule is covered structurally rather than by a runtime
guard: `METADATA_COLUMNS` in Task 1 excludes `view_count` and `label`, `features_for` in Task 7 reads
only from that tuple, and Task 7's `test_features_for_selects_the_right_matrix` pins the B1 width at 5. That is the "absent by construction" enforcement the spec describes.

**Placeholder scan.** One deliberate placeholder existed in Task 2's test (the two lines marking
where the `signal_direction` import moves); Task 2 Step 4 removes them explicitly. No other TBDs,
no "handle errors appropriately", every code step carries real code.

**Type consistency.** Checked across tasks: `Split.train`/`Split.test` are integer positions
everywhere; `y_true`/`y_pred` in `metrics.py` are aligned to `index`, not to `posts`, and Task 11
passes `split.test` with arrays built from `[split.test]` accordingly; `Interval` is constructed
only by `stats.py` and consumed by `verdict.py` and Task 11; `ControlResult` fields
(`name`/`passed`/`detail`/`value`) match the payload dict Task 10's report reads; `RUNGS` and
`BASELINE_RUNGS` are defined once in Task 7 and imported by Task 11.
