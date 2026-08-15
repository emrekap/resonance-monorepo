"""The poller↔ml boundary, checked from the Python side.

Same shape as `test_contract.py`, for the same reason: the corpus half of
`packages/queue/src/contract.ts` and of `queue_contract.py` are mirrored by
hand, so nothing but a test notices when one side moves.

Regenerate after an intentional contract change:

    pytest tests/test_corpus_contract.py --regenerate-fixture
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from queue_contract import CorpusSucceeded

FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "queue"
    / "src"
    / "__fixtures__"
    / "corpus-succeeded.json"
)


@pytest.fixture(scope="module")
def payload() -> dict:
    assert FIXTURE.exists(), f"corpus contract fixture missing at {FIXTURE}"
    return json.loads(FIXTURE.read_text())


class TestCorpusSucceeded:
    def test_reproduces_the_fixture_field_for_field(self, payload, request):
        rebuilt = CorpusSucceeded(**payload).model_dump(mode="json")

        if request.config.getoption("--regenerate-fixture", default=False):
            FIXTURE.write_text(json.dumps(rebuilt, indent=2) + "\n")
            pytest.skip("fixture regenerated")

        assert rebuilt == payload, (
            "queue_contract.py no longer reproduces the shared corpus fixture. If the "
            "contract changed on purpose, change packages/queue/src/contract.ts too and "
            "rerun with --regenerate-fixture."
        )

    def test_axis_bands_are_required(self, payload):
        # A corpus score exists only to yield a composite. One without bands is
        # a row that can never be ranked, so it must not serialise at all.
        without = {k: v for k, v in payload.items() if k != "axisBands"}
        with pytest.raises(Exception):
            CorpusSucceeded(**without)

    def test_carries_no_tenant(self, payload):
        # A corpus row has no workspace. If either key appears here the
        # isolation in spec §3 has been breached upstream.
        assert "workspaceId" not in payload
        assert "analysisId" not in payload

    def test_transcript_stays_row_aligned_with_the_curve(self, payload):
        parsed = CorpusSucceeded(**payload)
        assert parsed.transcript is not None
        assert [e.startSec for e in parsed.transcript] == parsed.timeline.startSec
