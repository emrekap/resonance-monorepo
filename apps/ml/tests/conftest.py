"""pytest configuration for the ML island.

`apps/ml` has no `package.json` by design (Bun and Turbo ignore it), so its tests
run directly:

    cd apps/ml && pytest tests/
"""

from __future__ import annotations

import sys
from pathlib import Path

# Tests import `parcellation`, `atlas`, `queue_contract` the same way the worker
# and the FastAPI app do — as top-level modules from the app root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def pytest_addoption(parser):
    parser.addoption(
        "--regenerate-fixture",
        action="store_true",
        default=False,
        help="Rewrite the shared api↔ml contract fixture from the Pydantic models.",
    )
