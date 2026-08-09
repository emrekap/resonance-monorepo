import copy
import json

import numpy as np
import pytest

from eval.report import _fmt, _json_safe, render_report, write_results

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


def _reject_bare_constant(constant):
    # json's `parse_constant` hook fires only for the bare (non-string) tokens
    # NaN / Infinity / -Infinity -- exactly the ones a strict parser (jq,
    # JSON.parse, ...) would choke on. A file with none of those round-trips
    # through a normal json.loads without ever calling this.
    raise ValueError(f"bare non-JSON constant in output: {constant}")


# --- from the brief, Step 1 (unmodified) ---------------------------------


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


# --- Defect 1: the void branch, actually pinned ---------------------------
#
# The brief's version of this test passes even with the entire
# `if payload.get("voided"):` early-return deleted: "VOID" comes from the
# `# Validation result — {verdict}` header (the payload sets `verdict` itself,
# independent of the branch), and "still predicts" comes from the controls
# list, which renders ABOVE where the branch would go. And because the brief
# sets `regimes = {}`, the loop the branch exists to suppress has nothing to
# emit regardless of whether the branch is there. Neither assertion, nor the
# fixture, exercises the thing being tested.
#
# Fixed by (a) asserting on text that ONLY the void branch itself produces,
# and (b) a second test with non-empty `regimes` -- the realistic case, since
# a pipeline can compute a regime's numbers and only then have a control fail
# -- asserting the headline uplift number and the regime section are absent.


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
    # Text only the void branch itself emits -- not derivable from the header
    # or the controls list, so this fails if the branch is deleted.
    assert "was not computed" in report


def test_voided_report_with_regimes_hides_the_uplift_and_regime_section():
    voided = dict(PAYLOAD)
    voided["voided"] = True
    voided["verdict"] = "VOID"
    voided["controls"] = [
        {"name": "label_shuffle", "passed": False, "detail": "still predicts", "value": 0.44}
    ]
    # Deliberately NON-empty, unlike the brief's test: this is the realistic
    # shape (a regime's numbers get computed, then a control fails), and it's
    # exactly the case an unguarded loop would leak the headline uplift into a
    # report titled VOID.
    assert voided["regimes"]  # sanity: still the PAYLOAD's populated regimes

    report = render_report(voided)
    assert "was not computed" in report
    assert "0.190" not in report
    assert "regime1_temporal" not in report


# --- Defect 2: results.json must be valid JSON even with NaN --------------
#
# `json.dumps` emits bare `NaN`/`Infinity` by default. Python's own
# `json.loads` accepts it (a leniency), so a plain round-trip test can't see
# the bug -- `jq`, `JSON.parse`, and most other parsers reject it outright.
# NaN is not a corner case in this payload: B0's rung legitimately produces
# `mean_over_creators({}) == nan`, and a VOID run carries NaN uplift
# throughout.


def test_results_json_is_strictly_valid_even_with_non_finite_values(tmp_path):
    payload = copy.deepcopy(PAYLOAD)
    payload["regimes"]["regime1_temporal"]["rungs"]["B0"] = {
        "rho": float("nan"),
        "lo": float("nan"),
        "hi": float("nan"),
    }
    payload["regimes"]["regime1_temporal"]["uplift"]["hi"] = float("inf")
    payload["regimes"]["regime1_temporal"]["p_value"] = float("nan")

    write_results(tmp_path, payload)
    text = (tmp_path / "results.json").read_text()

    # A strict parse must NOT hit a bare constant anywhere in the file.
    loaded = json.loads(text, parse_constant=_reject_bare_constant)
    assert loaded["regimes"]["regime1_temporal"]["rungs"]["B0"]["rho"] is None
    assert loaded["regimes"]["regime1_temporal"]["uplift"]["hi"] is None
    assert loaded["regimes"]["regime1_temporal"]["p_value"] is None


# --- Defect 3: numpy scalars must round-trip as real JSON types -----------
#
# np.float64 IS a `float` subclass so it survives `default=str` untouched,
# which is exactly what made this bug invisible on a casual read: the fields
# a human would spot-check (rho, uplift, p-values -- all floats) come out
# fine, and the ones they would not (row/creator counts, booleans) come out
# as quoted strings. Measured: `json.dumps({"i": np.int64(1000)},
# default=str)` -> `{"i": "1000"}`.


def test_json_safe_converts_numpy_integer_and_bool_to_native_types():
    sanitized = _json_safe({"i": np.int64(1000), "b": np.bool_(True)})
    assert sanitized == {"i": 1000, "b": True}
    assert type(sanitized["i"]) is int
    assert type(sanitized["b"]) is bool


def test_json_safe_preserves_numpy_float_as_native_float():
    sanitized = _json_safe(np.float64(0.19))
    assert sanitized == 0.19
    assert type(sanitized) is float


def test_json_safe_converts_non_finite_floats_to_none():
    assert _json_safe(float("nan")) is None
    assert _json_safe(float("inf")) is None
    assert _json_safe(float("-inf")) is None
    assert _json_safe(np.float64("nan")) is None


def test_json_safe_recurses_through_nested_dicts_lists_and_arrays():
    nested = {
        "a": [
            {"b": np.int64(3), "c": float("nan")},
            np.array([1.0, 2.0, float("nan")]),
        ],
    }
    assert _json_safe(nested) == {"a": [{"b": 3, "c": None}, [1.0, 2.0, None]]}


def test_json_safe_raises_instead_of_stringifying_an_unserializable_object():
    class Unserializable:
        pass

    with pytest.raises(TypeError):
        _json_safe(Unserializable())


def test_write_results_round_trips_numpy_scalars_as_real_json_types(tmp_path):
    payload = copy.deepcopy(PAYLOAD)
    payload["snapshot"]["rows"] = np.int64(1000)
    payload["snapshot"]["creators"] = np.int64(40)
    payload["voided"] = np.bool_(False)

    write_results(tmp_path, payload)
    text = (tmp_path / "results.json").read_text()

    assert '"1000"' not in text  # the measured Defect 3 failure mode
    loaded = json.loads(text)
    assert loaded["snapshot"]["rows"] == 1000
    assert isinstance(loaded["snapshot"]["rows"], int)
    assert isinstance(loaded["voided"], bool)


# --- Same family: report.md must render "n/a", not the literal "nan" ------


def test_rung_table_and_uplift_render_n_a_for_non_finite_values():
    payload = copy.deepcopy(PAYLOAD)
    nan = float("nan")
    payload["regimes"]["regime1_temporal"]["rungs"]["B0"] = {"rho": nan, "lo": nan, "hi": nan}
    payload["regimes"]["regime1_temporal"]["uplift"] = {"point": nan, "lo": nan, "hi": nan}
    payload["regimes"]["regime1_temporal"]["p_value"] = nan

    report = render_report(payload)
    assert "n/a" in report
    assert "nan" not in report.lower()


def test_pairwise_accuracy_and_top1_render_n_a_for_non_finite_values():
    payload = copy.deepcopy(PAYLOAD)
    payload["regimes"]["regime1_temporal"]["pairwise_accuracy"] = float("nan")
    payload["regimes"]["regime1_temporal"]["top1"] = float("nan")

    report = render_report(payload)
    assert "n/a" in report
    assert "nan" not in report.lower()


def test_fmt_formats_finite_values_and_falls_back_to_n_a():
    assert _fmt(0.19) == "0.190"
    assert _fmt(0.0001, ".4g") == "0.0001"
    assert _fmt(float("nan")) == "n/a"
    assert _fmt(float("inf")) == "n/a"
    assert _fmt(None) == "n/a"
