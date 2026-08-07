"""The real thing: TRIBE v2 on whatever accelerator this box has.

Everything here was `engine.py`'s module body until the backend seam landed; the
comments are load-bearing and were moved with the code. **This is the only module
in `apps/ml` that imports torch**, and `backends/__init__.py` imports it lazily,
so a test run that never selects this backend never pays for it.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

#: Where TRIBE caches weights. `engine.py` defines the same one line so `main.py`
#: can report the path without importing this (torch-bearing) module.
CACHE_DIR = Path(os.getenv("TRIBE_CACHE_DIR", "./cache"))

# neuralset (which owns the feature extractors) declares `device` as a closed
# pydantic Literal — "auto" | "cpu" | "cuda" | "accelerate" — and has no MPS
# support anywhere in the package. Handing it "mps" fails validation inside
# `TribeModel(**config)`, before torch is ever reached. So the extractors get the
# nearest legal device while the brain model keeps whatever `_select_device`
# picked: `TribeModel.predict` moves every batch to `model.device`, so the two do
# not have to agree.
_NEURALSET_DEVICES = ("auto", "cpu", "cuda", "accelerate")

# The pretrained config.yaml hardcodes `device: cuda` for every feature extractor
# (text/audio/video/image). Override to the extractor device so they run on CPU
# when no CUDA GPU is present.
_FEATURE_DEVICE_KEYS = (
    "data.text_feature.device",
    "data.audio_feature.device",
    "data.video_feature.image.device",
    "data.image_feature.image.device",
)


def _select_device() -> str:
    """Pick the fastest available torch device for the TRIBE brain model.

    Preference: CUDA > Apple Silicon GPU (MPS) > CPU. The library's own "auto"
    only knows cuda/cpu, so on a Mac it would fall back to CPU. When choosing MPS
    we enable PYTORCH_ENABLE_MPS_FALLBACK so any op not implemented on Metal runs
    on CPU instead of crashing. Override with TRIBE_DEVICE=cpu|cuda|mps if needed.
    """
    forced = os.getenv("TRIBE_DEVICE")
    if forced:
        device = forced
    else:
        import torch

        if torch.cuda.is_available():
            device = "cuda"
        elif torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"
    if device == "mps":
        os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    logger.info(f"TRIBE brain model will run on device: {device}")
    return device


def _extractor_device(device: str) -> str:
    if device in _NEURALSET_DEVICES:
        return device
    logger.warning(
        f"neuralset's feature extractors do not support device '{device}' "
        f"(accepted: {', '.join(_NEURALSET_DEVICES)}) — they will run on CPU, "
        f"which is slow for the ViT-g video encoders. The TRIBE model itself "
        f"still runs on '{device}'."
    )
    return "cpu"


class TribeBackend:
    """TRIBE v2, loaded once per process."""

    def __init__(self) -> None:
        self.device = _select_device()
        self.extractor_device = _extractor_device(self.device)
        self._model = None

    def load(self) -> None:
        """Download (first run) and load TRIBE v2. Idempotent.

        Blocking and slow — several GB on a cold cache. Both callers do this once
        at startup rather than per request/job.
        """
        if self._model is not None:
            return

        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        logger.info("Loading TRIBE v2 model (first run downloads several GB)…")
        try:
            from tribev2.demo_utils import TribeModel  # type: ignore

            self._model = TribeModel.from_pretrained(
                "facebook/tribev2",
                cache_folder=str(CACHE_DIR),
                device=self.device,
                config_update={
                    key: self.extractor_device for key in _FEATURE_DEVICE_KEYS
                },
            )
            logger.info("TRIBE v2 model loaded successfully.")
        except Exception as exc:
            logger.error(f"Failed to load TRIBE v2 model: {exc}")
            raise RuntimeError(f"Model load failed: {exc}") from exc

    def unload(self) -> None:
        """Drop the reference (FastAPI teardown). Nothing else to clean up."""
        self._model = None

    def is_loaded(self) -> bool:
        return self._model is not None

    def run(self, modality: str, path: str) -> tuple[np.ndarray, list]:
        """Blocking TRIBE v2 inference for a single file on disk.

        Synchronous and CPU/GPU-bound — both callers run it off the event loop
        (`run_in_threadpool` / `asyncio.to_thread`).
        """
        if self._model is None:
            raise RuntimeError("Model is not loaded. Call load_model() first.")
        if modality == "video":
            df = self._model.get_events_dataframe(video_path=path)
        else:
            df = self._model.get_events_dataframe(audio_path=path)
        return self._model.predict(events=df)
