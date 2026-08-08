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


def fit_predict(rung: str, snap: Snapshot, split: Split, y_train: np.ndarray) -> np.ndarray:
    """Fit a rung on train and predict test. Returns values aligned to split.test.

    `y_train` is aligned to `split.train` by convention only — nothing in its
    type ties the two together. A caller that passes a `y_train` built against
    a different split (or a differently-ordered `posts`) produces a rung that
    silently trains against the wrong rows. The length check below cannot prove
    the *alignment* is correct, but it does turn the most common mistake (a
    `y_train` sized for a different split) into a named error here rather than
    a confusing `IndexError`/`ValueError` raised deep inside `_b0`'s dict
    comprehension or inside sklearn.
    """
    if len(y_train) != len(split.train):
        raise ValueError(
            f"y_train has {len(y_train)} rows but split.train has {len(split.train)}"
        )
    if rung not in RUNGS:
        raise ValueError(f"unknown rung: {rung}")
    if rung == "B0":
        return _b0(snap, split, y_train)

    features = features_for(rung, snap)
    assert features is not None  # B0 is the only None, handled above
    model = make_pipeline(StandardScaler(), Ridge(alpha=RIDGE_ALPHA))
    model.fit(features[split.train], y_train)
    return np.asarray(model.predict(features[split.test]), dtype=float)
