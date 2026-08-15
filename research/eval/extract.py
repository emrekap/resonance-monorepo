"""The corpus extract — a second producer of the snapshot format.

This is not an extension of the harness; it is the thing `snapshot.py` was
written anticipating, in its own words: *"Two producers emit this: `synth.py`
today, a Postgres extract later."* It reads the `corpus` schema and emits
`posts.parquet`, the feature sidecars and `manifest.json`, after which
everything downstream — splits, leakage assertions, the B0-B4 ladder, bootstrap,
negative controls, verdict, report — runs **unmodified**, already tested against
worlds with known answers.

**This is not the pre-registered experiment (spec §1a).** The prereg locks
`averageViewPercentage`, which comes from the YouTube *Analytics* API and is
available only to a channel owner, so no public poller can obtain it. Every
snapshot this module writes declares itself a secondary exploratory analysis in
its own manifest, and `cli.run` copies that declaration into the report — a
structural separation rather than an editorial one, because a pre-registration
constrains researcher degrees of freedom only if the constraint survives contact
with a second, easier dataset.

    Sayable:     "we backtested the shipped ranking on N historical Shorts;
                  within-creator rho = X."
    Not sayable: "validated per our pre-registration."
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import HashingVectorizer

from eval.snapshot import write_snapshot

#: The primary outcome, fixed in writing before any data existed (spec §1b).
PRIMARY_OUTCOME = "views_at_Nd"

#: The secondary. Both are computed on every run; the primary does not move.
SECONDARY_OUTCOME = "engagement_rate"

#: How far from age N a snapshot may sit and still be read as "at age N".
#: A post whose polling was interrupted resolves to its nearest observation
#: within this window, or to nothing at all — never to "most recent".
FIXED_AGE_TOLERANCE_DAYS = 2

#: Denominator floor for the SECONDARY outcome only. A ratio over 40 views is
#: noise; a ratio over 1,000 is a rate. Applied when computing the secondary and
#: nowhere else, because a view-count floor on a VIEWS label is selection on the
#: outcome variable — the flaw that disqualifies Instagram's `top_media` (§2).
SECONDARY_VIEW_FLOOR = 1000

AXES = ("visual", "audio", "language", "emotional", "memorability")
AXIS_STATS = ("mean", "std", "peak")

TEXT_DIMS = 128

#: Stamped into every corpus manifest. `cli.run` copies it into the payload and
#: `report.render_report` titles the artifact with it.
SECONDARY_ANALYSIS = {
    "kind": "secondary-exploratory",
    "title": "Secondary exploratory analysis — corpus backtest",
    "note": (
        "This is **not** the pre-registered experiment. The pre-registration locks "
        "`averageViewPercentage`, a YouTube Analytics metric available only to a channel "
        "owner and therefore unobtainable by any public poller. This report backtests the "
        "shipped ranking against a different, publicly observable label on a corpus of "
        "historical Shorts. It does not, and cannot, produce a pre-registration verdict."
    ),
}


@dataclass(frozen=True)
class Observation:
    age_days: float
    views: int
    likes: int | None
    comments: int | None


@dataclass(frozen=True)
class CorpusRow:
    """One `corpus.posts` row with everything the extract needs beside it."""

    post_id: str
    creator_id: str
    published_at: datetime
    duration_sec: float
    hashtag_count: int
    follower_count: int
    transcript: str
    axis_bands: dict
    composite: float
    #: `(captured_at, views, likes, comments)` per snapshot, any order.
    snapshots: list[tuple[datetime, int | None, int | None, int | None]] = field(
        default_factory=list
    )


@dataclass(frozen=True)
class Built:
    posts: pd.DataFrame
    text: np.ndarray
    neuro: np.ndarray
    extra: dict


def resolve_at_age(
    snapshots: list[tuple[datetime, int | None, int | None, int | None]],
    published_at: datetime,
    n_days: int,
    tolerance: int = FIXED_AGE_TOLERANCE_DAYS,
) -> Observation | None:
    """The observation nearest age `n_days`, or None.

    **Never falls back to the most recent snapshot.** That fallback is the whole
    confound fixed-age measurement exists to remove: a post polled for six
    months would contribute its six-month view count while a fresh one
    contributes two weeks', and the resulting correlation would be substantially
    a restatement of how long each post has been up.
    """
    candidates: list[Observation] = []
    for captured_at, views, likes, comments in snapshots:
        if views is None:
            continue
        age = (captured_at - published_at).total_seconds() / 86400.0
        if abs(age - n_days) <= tolerance:
            candidates.append(Observation(age, int(views), likes, comments))

    if not candidates:
        return None
    return min(candidates, key=lambda obs: abs(obs.age_days - n_days))


def detrend_within_creator(posts: pd.DataFrame) -> np.ndarray:
    """Residual of `raw_label` on within-creator publish order (spec §1b).

    Within-creator normalisation does NOT remove channel growth: a growing
    channel gives its later posts more baseline reach, and that is a time trend
    living *inside* each creator, which z-scoring against the creator's own mean
    leaves entirely intact. Regressing the label on publish RANK (not on the
    date, so an irregular posting cadence does not distort the slope) and
    keeping the residual removes it.

    A creator with fewer than three posts gets mean-centring instead: a line
    through two points has no residual, and fitting one would zero the label.
    """
    out = np.zeros(len(posts), dtype=float)
    values = posts["raw_label"].to_numpy(dtype=float)

    for creator in posts["creator_id"].unique():
        mask = (posts["creator_id"] == creator).to_numpy()
        own = values[mask]
        if len(own) < 3:
            out[mask] = own - own.mean()
            continue
        # Rank by publish time, oldest first.
        order = np.argsort(posts["published_at"].to_numpy()[mask], kind="stable")
        rank = np.empty(len(own), dtype=float)
        rank[order] = np.arange(len(own), dtype=float)
        slope, intercept = np.polyfit(rank, own, 1)
        out[mask] = own - (slope * rank + intercept)

    return out


def _axis_vector(axis_bands: dict) -> list[float]:
    return [float(axis_bands[axis][stat]) for axis in AXES for stat in AXIS_STATS]


def build_snapshot(
    rows: list[CorpusRow],
    *,
    outcome: str,
    maturation: dict,
    now: datetime,
) -> Built:
    """Assemble one outcome's snapshot, with its own exclusion set.

    **Exclusions are per-outcome (spec §5b).** The primary takes no view-based
    exclusion of any kind; the secondary adds a hidden-likes drop and a
    denominator floor, both counted and reported. That asymmetry is why the two
    are never mixed inside one parquet, and why the report states two Ns.
    """
    if outcome not in (PRIMARY_OUTCOME, SECONDARY_OUTCOME):
        raise ValueError(f"unknown outcome {outcome!r}")

    n_days = int(maturation["n_days"])
    exclusions: dict[str, int] = {"below_maturation_floor": 0, "no_snapshot_at_age": 0}
    if outcome == SECONDARY_OUTCOME:
        exclusions["likes_hidden"] = 0
        exclusions["views_below_floor"] = 0

    records: list[dict] = []
    neuro: list[list[float]] = []
    transcripts: list[str] = []

    for row in rows:
        age_now = (now - row.published_at).total_seconds() / 86400.0
        observation = resolve_at_age(row.snapshots, row.published_at, n_days)

        if observation is None:
            # Two different facts, kept apart: a post that is simply too young
            # is expected attrition that resolves itself next week, while a
            # polling gap is an operational problem worth seeing.
            if age_now < n_days:
                exclusions["below_maturation_floor"] += 1
            else:
                exclusions["no_snapshot_at_age"] += 1
            continue

        if outcome == SECONDARY_OUTCOME:
            if observation.likes is None:
                # Counted, not silently dropped: hiding likes is not independent
                # of how a post performed, so this is a selection effect rather
                # than missing data, and the report says how large it is.
                exclusions["likes_hidden"] += 1
                continue
            if observation.views < SECONDARY_VIEW_FLOOR:
                exclusions["views_below_floor"] += 1
                continue
            raw_label = (observation.likes + (observation.comments or 0)) / observation.views
        else:
            # log1p for the LADDER's benefit only. The headline metric is
            # Spearman rho, which is rank-based, so the transform changes
            # nothing about the primary number — heavy tails and viral outliers
            # are already handled by ranking. Recorded here so it is not later
            # "fixed" in one place and not the other.
            raw_label = float(np.log1p(observation.views))

        records.append(
            {
                "post_id": row.post_id,
                "creator_id": row.creator_id,
                "published_at": row.published_at,
                "raw_label": raw_label,
                "view_count": observation.views,
                "format": "SHORT_FORM",
                "duration_sec": row.duration_sec,
                "hashtag_count": row.hashtag_count,
                "published_hour": row.published_at.hour,
                "published_dow": row.published_at.weekday(),
                "follower_count": row.follower_count,
                # The covariate §1b asks for. NOT the age at which the label was
                # read (that is `n_days` for every post, by construction, and a
                # constant column is degenerate in a fitted model) but the
                # post's age at extraction — which varies, and is the axis
                # channel growth runs along.
                "days_since_publish": float(age_now),
                "composite": row.composite,
            }
        )
        neuro.append(_axis_vector(row.axis_bands))
        transcripts.append(row.transcript or "")

    posts = pd.DataFrame(records)
    if posts.empty:
        raise ValueError(
            f"no posts survived the {outcome} exclusion set: {exclusions} — "
            "the corpus is not ready to extract"
        )

    posts["label"] = detrend_within_creator(posts)
    posts = posts.drop(columns=["raw_label"])

    vectorizer = HashingVectorizer(n_features=TEXT_DIMS, alternate_sign=False, norm="l2")
    text = vectorizer.transform(transcripts).toarray()

    extra = {
        "outcome": outcome,
        "maturation": maturation,
        "exclusions": exclusions,
        "detrended_within_creator": True,
        "extra_metadata_columns": ["days_since_publish"],
        "analysis": SECONDARY_ANALYSIS,
    }

    return Built(posts=posts, text=text, neuro=np.asarray(neuro, dtype=float), extra=extra)


def write_corpus_snapshot(
    rows: list[CorpusRow],
    out_dir: Path,
    *,
    outcome: str,
    maturation: dict,
    now: datetime,
) -> Built:
    built = build_snapshot(rows, outcome=outcome, maturation=maturation, now=now)
    write_snapshot(
        Path(out_dir),
        built.posts,
        built.text,
        built.neuro,
        producer="corpus",
        seed=0,
        extra=built.extra,
    )
    return built
