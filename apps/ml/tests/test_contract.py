"""The api↔ml boundary, checked from the Python side.

`packages/queue/src/contract.ts` and `queue_contract.py` are mirrored **by hand**
— there is no codegen between them, so nothing but a test notices when one side
moves. These two files share a single fixture:

    packages/queue/src/__fixtures__/analysis-succeeded.json

This module asserts Pydantic still produces exactly that; `contract.test.ts`
asserts zod still accepts it. Drift on either side fails somebody's test run
instead of the first real job.

Regenerate after an intentional contract change:

    pytest tests/test_contract.py --regenerate-fixture
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from queue_contract import AnalysisSucceeded

FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "queue"
    / "src"
    / "__fixtures__"
    / "analysis-succeeded.json"
)


@pytest.fixture(scope="module")
def payload() -> dict:
    assert FIXTURE.exists(), f"contract fixture missing at {FIXTURE}"
    return json.loads(FIXTURE.read_text())


class TestAnalysisSucceeded:
    def test_reproduces_the_fixture_field_for_field(self, payload, request):
        """Pydantic must reproduce the fixture the TypeScript side is tested against.

        This catches *shape* drift in both directions — a field added to or
        removed from `queue_contract.py` no longer round-trips. It deliberately
        does not police the fixture's values: a different clip is still a valid
        payload, and pinning numbers here would make the test noisy without
        making the contract safer.
        """
        rebuilt = AnalysisSucceeded(**payload).model_dump(mode="json")

        if request.config.getoption("--regenerate-fixture", default=False):
            FIXTURE.write_text(json.dumps(rebuilt, indent=2) + "\n")
            pytest.skip("fixture regenerated")

        assert rebuilt == payload, (
            "queue_contract.py no longer reproduces the shared fixture. If the contract "
            "changed on purpose, change packages/queue/src/contract.ts too and rerun with "
            "--regenerate-fixture."
        )

    def test_carries_every_field_the_worker_reads(self, payload):
        parsed = AnalysisSucceeded(**payload)
        assert parsed.axisBands is not None
        assert parsed.transcript is not None
        assert parsed.durationSec is not None

    def test_all_five_timeline_arrays_agree_in_length(self, payload):
        timeline = AnalysisSucceeded(**payload).timeline
        lengths = {
            len(timeline.startSec),
            len(timeline.attention),
            len(timeline.visual or []),
            len(timeline.audio or []),
            len(timeline.language or []),
        }
        # analysis_results_timeline_len_chk rejects a row where these disagree.
        assert len(lengths) == 1

    def test_transcript_stays_row_aligned_with_the_curve(self, payload):
        parsed = AnalysisSucceeded(**payload)
        assert parsed.transcript is not None
        assert [entry.startSec for entry in parsed.transcript] == parsed.timeline.startSec
        # Silent segments are kept, or every later caption slides onto the wrong moment.
        assert any(entry.text == "" for entry in parsed.transcript)

    def test_carries_the_stimulus_block(self, payload):
        """`hasAudio`/`hasVisual` drive the muted lines on the result screen."""
        parsed = AnalysisSucceeded(**payload)
        assert parsed.stimulus is not None
        assert parsed.stimulus.hasAudio is True
        assert parsed.stimulus.hasVisual is True

    def test_unset_optional_fields_serialise_as_null(self, payload):
        """The reason the zod contract uses .nullish() rather than .optional().

        `.optional()` accepts only `undefined`. Pydantic emits `null`. Every
        TS-to-TS test would pass and the first real job would fail at the boundary.
        """
        minimal = {
            key: value
            for key, value in payload.items()
            if key not in {"durationSec", "transcript", "axisBands", "stimulus"}
        }
        dumped = AnalysisSucceeded(**minimal).model_dump(mode="json")
        assert dumped["durationSec"] is None
        assert dumped["transcript"] is None
        assert dumped["axisBands"] is None
        assert dumped["stimulus"] is None

    def test_rejects_a_negative_duration(self, payload):
        with pytest.raises(Exception):
            AnalysisSucceeded(**{**payload, "durationSec": -1})
