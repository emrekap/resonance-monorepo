"""pytest configuration for the ML island.

`apps/ml` has no `package.json` by design (Bun and Turbo ignore it), so its tests
run directly:

    cd apps/ml && pytest
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# Tests import `parcellation`, `atlas`, `queue_contract` the same way the worker
# and the FastAPI app do — as top-level modules from the app root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# The whole suite runs against the synthetic backend. This is set before any test
# imports `engine`, because `engine.device()` resolves a backend on first call and
# the tribe one imports torch — which CI does not install.
os.environ.setdefault("ML_BACKEND", "synthetic")


def pytest_addoption(parser):
    parser.addoption(
        "--regenerate-fixture",
        action="store_true",
        default=False,
        help="Rewrite the shared api↔ml contract fixture from the Pydantic models.",
    )


@pytest.fixture(autouse=True)
def _isolated_backend():
    """Drop the process-wide backend cache around every test.

    `get_backend()` memoises deliberately — production loads one model per
    process. That would otherwise leak a backend selected by one test into the
    next one's assertions.
    """
    import backends

    backends.reset_backend()
    yield
    backends.reset_backend()


# ─── HTTP ────────────────────────────────────────────────────────────────────


class _FakeResponse:
    """Enough of `requests.Response` for `worker._download`.

    Hand-rolled rather than pulling in `responses` or `httpretty`: `_download`
    does `import requests` inside the function, so monkeypatching the module
    attribute is all that is needed, and a fake this small is easier to read than
    a mocking DSL.
    """

    def __init__(self, status, headers, chunks):
        self.status_code = status
        self.headers = headers
        self._chunks = chunks

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def raise_for_status(self):
        if self.status_code >= 400:
            import requests

            raise requests.HTTPError(f"{self.status_code} error")

    def iter_content(self, chunk_size=None):
        yield from self._chunks


@pytest.fixture
def fake_http(monkeypatch):
    """Script the next `requests.get` that `worker._download` makes."""

    def install(status=200, headers=None, chunks=(b"data",)):
        import requests

        def _get(url, **kwargs):
            return _FakeResponse(status, headers or {}, chunks)

        monkeypatch.setattr(requests, "get", _get)

    return install


# ─── the queue ───────────────────────────────────────────────────────────────


class _SpyQueue:
    """Stands in for the BullMQ results queue.

    Not a fake Redis: `bullmq` drives Redis through Lua scripts, so running them
    against an emulator would test the emulator. What matters here is *what this
    worker decided to publish*, which a spy captures directly. The real
    round-trip is covered by `tests/integration/test_queue_roundtrip.py`.
    """

    def __init__(self):
        self.calls: list[tuple[str, dict, dict]] = []

    async def add(self, name, data, opts):
        self.calls.append((name, data, opts))

    def named(self, name: str) -> dict:
        matches = [data for called, data, _ in self.calls if called == name]
        assert matches, f"nothing published as {name!r}; got {[c[0] for c in self.calls]}"
        return matches[-1]

    def opts_for(self, name: str) -> dict:
        matches = [opts for called, _, opts in self.calls if called == name]
        assert matches, f"nothing published as {name!r}"
        return matches[-1]


@pytest.fixture
def spy_results_queue():
    return _SpyQueue()


class _FakeJob:
    """The members `AnalysisProcessor` reads off a BullMQ Job."""

    def __init__(self, data, attempts, attempts_started, job_id):
        self.data = data
        self.opts = {"attempts": attempts}
        self.attemptsStarted = attempts_started
        self.attemptsMade = max(0, attempts_started - 1)
        self.id = job_id


@pytest.fixture
def fake_job():
    def build(data=None, attempts=1, attempts_started=1, job_id="job-1"):
        return _FakeJob(
            data
            or {
                "analysisId": "analysis-1",
                "workspaceId": "workspace-1",
                "modality": "video",
                "media": {
                    "assetId": "asset-1",
                    "url": "https://example.test/clip.mp4",
                },
            },
            attempts,
            attempts_started,
            job_id,
        )

    return build
