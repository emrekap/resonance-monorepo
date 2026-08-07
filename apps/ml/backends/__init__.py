"""Where the model comes from — the seam that makes this island testable.

`apps/ml` cannot run TRIBE v2 on a laptop: it needs a GPU and ~10 GB of gated
weights. Everything *around* the model — the download, the mapping into the queue
contract, the retry arithmetic in `worker.py` — is ordinary Python that runs
anywhere, and it was untestable only because it sat behind an import of the
model.

So the model lives behind a protocol with two implementations. `TribeBackend` is
the real one and the default; `SyntheticBackend` fabricates a plausible tensor.
Selection is by environment variable rather than a constructor argument because
`entrypoint.sh`, the Dockerfile, `main.py` and `worker.py` would all need
threading otherwise, for zero gain in a process that loads exactly one model.

    python worker.py                          # tribe, as in production
    ML_BACKEND=synthetic python worker.py     # the whole path, no GPU

`tribe.py` is imported lazily below and is the only module that imports torch.
That is what lets CI install six small wheels instead of a CUDA build.
"""

from __future__ import annotations

import os
import typing as tp
from pathlib import Path

import numpy as np

DEFAULT_BACKEND = "tribe"


class Backend(tp.Protocol):
    """What `engine.py` needs from whatever is producing predictions."""

    #: Reported to `apps/worker` and stored in `inference_runs.device`.
    device: str

    def load(self) -> None:
        """Bring the model into memory. Idempotent, blocking, possibly slow."""

    def unload(self) -> None:
        """Drop it again (FastAPI teardown)."""

    def is_loaded(self) -> bool: ...

    def run(self, modality: str, path: str) -> tuple[np.ndarray, list]:
        """`[n_segments x n_vertices]` predictions plus the aligned segments."""


def selected_name() -> str:
    """The backend `ML_BACKEND` asks for, normalised. `tribe` when unset."""
    return (os.getenv("ML_BACKEND") or DEFAULT_BACKEND).strip().lower()


_BACKEND: Backend | None = None


def get_backend() -> Backend:
    """The process's backend, built once.

    Memoised on purpose: a backend owns several GB of weights, and building a
    second one mid-process is never what anyone wanted. Tests call
    `reset_backend()` between cases.
    """
    global _BACKEND
    if _BACKEND is None:
        _BACKEND = _build()
    return _BACKEND


def reset_backend() -> None:
    """Drop the cached backend. Tests only."""
    global _BACKEND
    _BACKEND = None


def _build() -> Backend:
    name = selected_name()

    if name == "tribe":
        # Imported here, not at module scope: this is the line that costs a torch
        # import, and the synthetic path must never pay it.
        from .tribe import TribeBackend

        backend: Backend = TribeBackend()
    elif name == "synthetic":
        from .synthetic import SyntheticBackend

        backend = SyntheticBackend()
    else:
        raise ValueError(
            f"unknown ML_BACKEND {name!r} — expected 'tribe' or 'synthetic'. "
            "Refusing to guess: falling back to either one would be wrong."
        )

    record_dir = os.getenv("ML_RECORD_DIR")
    if record_dir:
        from .recording import RecordingBackend

        backend = RecordingBackend(backend, Path(record_dir))

    return backend
