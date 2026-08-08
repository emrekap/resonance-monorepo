"""The negative controls, which run BEFORE the primary result.

Prereg §7: "Negative controls, run before reading the primary result.
Label-shuffle within creator — every model must collapse to chance; if B3 still
'predicts', there is leakage, and the run is void until it is found. Naive
brain-wide-average baseline must fail, replicating the known negative result."

Ordering them before the ladder is what makes them a gate rather than a
footnote. See `cli.run`, which stops on failure and emits no primary result.

A third control, `feature_label_leak_control`, is not in the pre-registration
text above but is required to close a real gap: `label_shuffle_control` is a
PROCEDURAL leakage detector (fit-on-test, train/test overlap, ...). It cannot
detect a feature column that literally *is* the label, because permuting the
label destroys the model's ability to exploit that column exactly as much as
it destroys any genuine signal — the shuffled run lands at chance either way,
by construction, regardless of whether the un-shuffled run was legitimate or
contaminated. See `test_label_shuffle_passes_even_on_a_contaminated_world` in
the test file for the measured proof. `feature_label_leak_control` closes that
gap directly: it looks for a feature that ranks the label near-perfectly,
before any model is fit at all.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

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

#: A single feature that ranks the label near-perfectly is not a feature, it is
#: the label. Genuine synthetic signal tops out near |rho| = 0.27.
FEATURE_LEAK_CEILING = 0.95


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


def _shuffle_labels_within_creator(posts: pd.DataFrame, *, seed: int) -> pd.DataFrame:
    """Return a copy of `posts` with `label` permuted independently per creator.

    `own = labels[mask]` is a boolean-index selection, which numpy always
    copies rather than views — so `rng.shuffle(own)` shuffles that copy in
    place, and the `labels[mask] = own` write-back is what actually gets the
    permutation back into `labels`. Drop that write-back and this becomes a
    silent no-op: the returned frame's labels would be bit-for-bit identical
    to the input's, and `label_shuffle_control` would always "pass" without
    ever having tested anything. See
    `test_shuffle_labels_within_creator_actually_permutes` for the assertion
    that this does not happen.
    """
    rng = np.random.default_rng(seed)
    shuffled = posts.copy()
    labels = shuffled["label"].to_numpy().copy()
    creators = shuffled["creator_id"].to_numpy()
    for creator in np.unique(creators):
        mask = creators == creator
        own = labels[mask]
        rng.shuffle(own)
        labels[mask] = own
    shuffled["label"] = labels
    return shuffled


def label_shuffle_control(
    snap: Snapshot, split: Split, *, seed: int = 0
) -> ControlResult:
    """Shuffle labels within each creator; B3 must collapse to chance.

    This is a PROCEDURAL leakage detector, not a feature-content detector. It
    catches a normalizer fit on test rows, train/test overlap, or any other
    "the pipeline peeked" bug — because those bugs all rely on the true
    label/feature pairing surviving into the fit. It structurally cannot catch
    a feature column that literally *is* the label: permuting the label
    breaks the feature<->label association for the model to exploit just as
    much whether or not that association was a real leak, so the shuffled run
    lands at chance in both worlds. That leak class is
    `feature_label_leak_control`'s job. Do not "fix" this control to also
    catch it — see `test_label_shuffle_passes_even_on_a_contaminated_world`.
    """
    shuffled = _shuffle_labels_within_creator(snap.posts, seed=seed)

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

    # `np.isfinite` first: an unmeasurable control (e.g. every creator excluded
    # because it has fewer than two test posts, so `per_creator_spearman`
    # returns {} and `mean_over_creators` returns NaN) must BLOCK the run, not
    # wave it through — the same "a gate that opens when it can't be
    # evaluated" failure class this harness exists to catch. `abs(...)` rather
    # than a one-sided `rho < ceiling`: a strongly *anti*-predictive average
    # (rho = -0.5) is just as exploitable as a positive one, since flipping
    # its sign recovers the predictive direction, and a rank metric with a
    # flipped sign is trivially fixable, not safe.
    passed = bool(np.isfinite(rho)) and abs(rho) < BRAIN_AVERAGE_CEILING
    detail = (
        f"naive brain-wide average scored rho={rho:.3f}; "
        f"expected |rho| < {BRAIN_AVERAGE_CEILING}. "
        + (
            "Failed as the literature predicts."
            if passed
            else "The naive average PREDICTS (or is unmeasurable), which contradicts "
            "the known negative result and means the setup is not measuring what it "
            "claims."
        )
    )
    return ControlResult(name="brain_average", passed=passed, detail=detail, value=float(rho))


def feature_label_leak_control(snap: Snapshot, split: Split) -> ControlResult:
    """No single [text | neuro] feature may rank the label near-perfectly.

    Computed over TRAIN rows only, consistent with every other fit-on-train-
    only rule in this harness (the ladder trains on `split.train`;
    `WithinCreatorNormalizer` fits on `split.train`). This is the control that
    catches a feature column that literally *is* the label — the leak class
    `label_shuffle_control` cannot see, because a permutation destroys the
    feature<->label association (and so the model's ability to exploit it)
    regardless of whether that association was legitimate or a leak.
    """
    label = snap.posts["label"].to_numpy()[split.train]
    features = np.hstack(
        [np.asarray(snap.text, dtype=float), np.asarray(snap.neuro, dtype=float)]
    )[split.train]

    worst_value = 0.0
    worst_column = -1
    for column in range(features.shape[1]):
        values = features[:, column]
        if np.all(values == values[0]):
            continue  # a constant column has no rank correlation; spearmanr gives NaN
        rho = spearmanr(values, label).statistic
        if not np.isfinite(rho):
            continue
        if abs(rho) > worst_value:
            worst_value = abs(float(rho))
            worst_column = column

    passed = bool(np.isfinite(worst_value)) and worst_value < FEATURE_LEAK_CEILING
    detail = (
        f"max |rho(feature, label)| over {features.shape[1]} [text | neuro] "
        f"columns (train rows only) = {worst_value:.3f}; expected < "
        f"{FEATURE_LEAK_CEILING}. "
        + (
            "No single feature explains the label."
            if passed
            else f"column {worst_column} of the concatenated [text | neuro] matrix "
            "ranks the label almost perfectly — that is not a feature, it is the "
            "label. The run is void until this leak is found."
        )
    )
    return ControlResult(
        name="feature_label_leak", passed=passed, detail=detail, value=float(worst_value)
    )


def run_controls(snap: Snapshot, split: Split, *, seed: int = 0) -> list[ControlResult]:
    return [
        label_shuffle_control(snap, split, seed=seed),
        brain_average_control(snap, split),
        feature_label_leak_control(snap, split),
    ]
