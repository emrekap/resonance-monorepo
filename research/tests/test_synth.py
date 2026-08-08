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
