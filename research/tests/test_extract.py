from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from eval.extract import (
    FIXED_AGE_TOLERANCE_DAYS,
    PRIMARY_OUTCOME,
    SECONDARY_OUTCOME,
    SECONDARY_VIEW_FLOOR,
    CorpusRow,
    Observation,
    build_snapshot,
    detrend_within_creator,
    resolve_at_age,
)
from eval.ladder import metadata_columns
from eval.snapshot import METADATA_COLUMNS, REQUIRED_COLUMNS, Snapshot

NOW = datetime(2026, 12, 1, tzinfo=timezone.utc)
MATURATION = {"n_days": 14, "phase": 1}


def snapshots(*pairs):
    """(age_days, views) -> the snapshot tuples the extract reads."""
    return [(NOW - timedelta(days=200 - age), views, 100, 10) for age, views in pairs]


def row(post_id, creator_id, *, published_days_ago=200, series=((14, 5000),), likes=100, **kw):
    published_at = NOW - timedelta(days=published_days_ago)
    return CorpusRow(
        post_id=post_id,
        creator_id=creator_id,
        published_at=published_at,
        duration_sec=kw.get("duration_sec", 20.0),
        hashtag_count=kw.get("hashtag_count", 2),
        follower_count=kw.get("follower_count", 10_000),
        transcript=kw.get("transcript", "watch this"),
        axis_bands=kw.get(
            "axis_bands",
            {
                axis: {"mean": 0.0, "std": 0.1, "peak": 0.2}
                for axis in ("visual", "audio", "language", "emotional", "memorability")
            },
        ),
        composite=kw.get("composite", 0.2),
        snapshots=[
            (published_at + timedelta(days=age), views, likes, 10) for age, views in series
        ],
    )


def cohort(n_creators=3, n_posts=6):
    return [
        row(f"p{c}{i}", f"c{c}", published_days_ago=200 - i, series=((14, 1000 * (i + 1)),))
        for c in range(n_creators)
        for i in range(n_posts)
    ]


class TestFixedAge:
    def test_reads_the_snapshot_at_age_n_not_the_latest_one(self):
        # A post polled for months has a much larger latest view count. Falling
        # back to "most recent" would silently measure different posts at
        # different ages — the exact confound fixed-age measurement removes.
        published_at = NOW - timedelta(days=200)
        series = [
            (published_at + timedelta(days=age), views, 10, 1)
            for age, views in [(1, 100), (14, 5_000), (180, 90_000)]
        ]
        found = resolve_at_age(series, published_at, 14, FIXED_AGE_TOLERANCE_DAYS)
        assert found is not None
        assert found.views == 5_000

    def test_resolves_the_nearest_snapshot_when_polling_was_interrupted(self):
        published_at = NOW - timedelta(days=200)
        series = [
            (published_at + timedelta(days=age), views, 10, 1) for age, views in [(1, 100), (13, 4_800)]
        ]
        found = resolve_at_age(series, published_at, 14, FIXED_AGE_TOLERANCE_DAYS)
        assert found is not None and found.views == 4_800

    def test_returns_nothing_rather_than_falling_back(self):
        # Only a day-40 observation exists. There is no honest reading of this
        # post's views at day 14, so it drops out and is COUNTED.
        published_at = NOW - timedelta(days=200)
        series = [(published_at + timedelta(days=40), 30_000, 10, 1)]
        assert resolve_at_age(series, published_at, 14, FIXED_AGE_TOLERANCE_DAYS) is None


class TestDetrending:
    def test_removes_a_within_creator_growth_trend(self):
        # A growing channel gives its LATER posts more baseline reach — a trend
        # inside each creator that within-creator z-scoring leaves untouched.
        import pandas as pd

        posts = pd.DataFrame(
            {
                "creator_id": ["c1"] * 5,
                "published_at": pd.to_datetime(
                    ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01"]
                ),
                "raw_label": [1.0, 2.0, 3.0, 4.0, 5.0],
            }
        )
        residual = detrend_within_creator(posts)
        assert np.allclose(residual, 0.0, atol=1e-9)

    def test_leaves_variation_that_is_not_a_trend(self):
        import pandas as pd

        posts = pd.DataFrame(
            {
                "creator_id": ["c1"] * 5,
                "published_at": pd.to_datetime(
                    ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01"]
                ),
                "raw_label": [1.0, 5.0, 2.0, 6.0, 3.0],
            }
        )
        assert np.std(detrend_within_creator(posts)) > 0.5


class TestPrimarySnapshot:
    def test_emits_every_required_column(self):
        built = build_snapshot(cohort(), outcome=PRIMARY_OUTCOME, maturation=MATURATION, now=NOW)
        for column in REQUIRED_COLUMNS:
            assert column in built.posts.columns

    def test_carries_no_view_based_exclusion(self):
        # THE guard against selecting on the outcome variable. It is invisible
        # in the output: a snapshot built the wrong way looks entirely normal
        # and simply reports a better rho. Asserted against the tallies, not
        # inferred from row counts.
        rows = cohort() + [row("tiny", "c0", series=((14, 3),), likes=None)]
        built = build_snapshot(rows, outcome=PRIMARY_OUTCOME, maturation=MATURATION, now=NOW)
        assert "views_below_floor" not in built.extra["exclusions"]
        assert "likes_hidden" not in built.extra["exclusions"]
        assert "tiny" in set(built.posts["post_id"])

    def test_view_count_is_present_but_never_a_feature(self):
        built = build_snapshot(cohort(), outcome=PRIMARY_OUTCOME, maturation=MATURATION, now=NOW)
        assert "view_count" in built.posts.columns
        assert "view_count" not in METADATA_COLUMNS
        columns = metadata_columns(
            Snapshot(posts=built.posts, text=built.text, neuro=built.neuro, manifest=built.extra)
        )
        assert "view_count" not in columns
        assert "format" not in columns

    def test_records_the_maturation_value_and_phase(self):
        built = build_snapshot(cohort(), outcome=PRIMARY_OUTCOME, maturation=MATURATION, now=NOW)
        assert built.extra["maturation"] == MATURATION
        assert built.extra["outcome"] == PRIMARY_OUTCOME

    def test_declares_itself_a_secondary_exploratory_analysis(self):
        built = build_snapshot(cohort(), outcome=PRIMARY_OUTCOME, maturation=MATURATION, now=NOW)
        assert built.extra["analysis"]["kind"] == "secondary-exploratory"
        assert "pre-registration" in built.extra["analysis"]["note"]

    def test_counts_a_post_below_the_floor_separately_from_a_polling_gap(self):
        rows = cohort() + [
            row("young", "c0", published_days_ago=3, series=((1, 10),)),
            row("gap", "c0", series=((40, 30_000),)),
        ]
        built = build_snapshot(rows, outcome=PRIMARY_OUTCOME, maturation=MATURATION, now=NOW)
        assert built.extra["exclusions"]["below_maturation_floor"] == 1
        assert built.extra["exclusions"]["no_snapshot_at_age"] == 1


class TestSecondarySnapshot:
    def test_drops_hidden_likes_and_counts_them(self):
        rows = cohort() + [row("hidden", "c0", likes=None)]
        built = build_snapshot(rows, outcome=SECONDARY_OUTCOME, maturation=MATURATION, now=NOW)
        assert built.extra["exclusions"]["likes_hidden"] == 1
        assert "hidden" not in set(built.posts["post_id"])

    def test_applies_the_denominator_floor_only_here(self):
        rows = cohort() + [row("tiny", "c0", series=((14, SECONDARY_VIEW_FLOOR - 1),))]
        built = build_snapshot(rows, outcome=SECONDARY_OUTCOME, maturation=MATURATION, now=NOW)
        assert built.extra["exclusions"]["views_below_floor"] == 1

    def test_the_primary_runs_on_strictly_more_posts(self):
        rows = cohort() + [row("hidden", "c0", likes=None)]
        primary = build_snapshot(rows, outcome=PRIMARY_OUTCOME, maturation=MATURATION, now=NOW)
        secondary = build_snapshot(rows, outcome=SECONDARY_OUTCOME, maturation=MATURATION, now=NOW)
        assert len(primary.posts) > len(secondary.posts)


class TestFeatures:
    def test_neuro_features_are_the_five_axes_by_three_statistics(self):
        built = build_snapshot(cohort(), outcome=PRIMARY_OUTCOME, maturation=MATURATION, now=NOW)
        assert built.neuro.shape == (len(built.posts), 15)

    def test_text_features_come_from_the_transcript(self):
        rows = [
            row("a", "c1", transcript="a completely different sentence"),
            row("b", "c1", transcript="watch this"),
        ] + cohort()
        built = build_snapshot(rows, outcome=PRIMARY_OUTCOME, maturation=MATURATION, now=NOW)
        assert built.text.shape[0] == len(built.posts)
        assert built.text.shape[1] > 0
        # Two different transcripts must not produce the same row.
        index = {pid: i for i, pid in enumerate(built.posts["post_id"])}
        assert not np.allclose(built.text[index["a"]], built.text[index["b"]])

    def test_features_stay_row_aligned_with_posts(self):
        built = build_snapshot(cohort(), outcome=PRIMARY_OUTCOME, maturation=MATURATION, now=NOW)
        assert built.text.shape[0] == len(built.posts) == built.neuro.shape[0]


def test_the_snapshot_validator_accepts_what_the_extract_emits(tmp_path):
    # The seam most likely to drift, and the one that silently invalidates
    # everything downstream if it does.
    from eval.extract import write_corpus_snapshot
    from eval.snapshot import load_snapshot

    write_corpus_snapshot(
        cohort(), tmp_path, outcome=PRIMARY_OUTCOME, maturation=MATURATION, now=NOW
    )
    loaded = load_snapshot(tmp_path)
    assert loaded.manifest["producer"] == "corpus"
    assert loaded.manifest["outcome"] == PRIMARY_OUTCOME
