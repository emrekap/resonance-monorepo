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
    # Sort so per-creator temporal splits are meaningful. Capture the
    # permutation BEFORE resetting the index — reset_index(drop=True) replaces
    # the index with a fresh RangeIndex, so grabbing `.index` after that point
    # would yield the identity permutation instead of the sort order, silently
    # decoupling every feature row from the post it belongs to.
    posts = posts.sort_values(["creator_id", "published_at"])
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
