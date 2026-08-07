"""
TRIBE v2 model lifecycle and inference — the part that is not a transport.

Extracted from `main.py` so the two things that run the model share one
implementation: the FastAPI service (`main.py`, what the Hugging Face Space
serves) and the queue worker (`worker.py`, what `apps/api` actually drives in
production). Loading ~10 GB of weights twice, in two slightly different ways,
is exactly the drift this avoids.

Importing this module performs the environment bootstrap (`.env`, PATH,
whisperx pinning, device selection). Loading the weights is separate and
explicit — call `load_model()`.
"""

import logging
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path

import numpy as np

import parcellation
from parcellation import AXES  # noqa: F401 — re-exported for callers of this module

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Load .env and normalise the HuggingFace token. TRIBE v2's text encoder is the
# gated meta-llama/Llama-3.2-3B repo, so a token is required even for video and
# audio inference (not just text). huggingface_hub reads HF_TOKEN /
# HUGGING_FACE_HUB_TOKEN — bridge the common HUGGINGFACE_TOKEN alias to those.
# ---------------------------------------------------------------------------
def _load_env() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    load_dotenv(Path(__file__).resolve().parent / ".env")

    token = (
        os.environ.get("HF_TOKEN")
        or os.environ.get("HUGGING_FACE_HUB_TOKEN")
        or os.environ.get("HUGGINGFACE_TOKEN")
    )
    if token and token != "hf_YOUR_TOKEN_HERE":
        os.environ.setdefault("HF_TOKEN", token)
        os.environ.setdefault("HUGGING_FACE_HUB_TOKEN", token)
        logger.info("HuggingFace token loaded (gated Llama-3.2-3B access enabled).")
    else:
        logger.warning(
            "No HuggingFace token set. TRIBE v2's gated text encoder "
            "(meta-llama/Llama-3.2-3B) will fail. Set HF_TOKEN in .env and ensure "
            "your account has access: https://huggingface.co/meta-llama/Llama-3.2-3B"
        )


_load_env()


# ---------------------------------------------------------------------------
# Ensure the external binaries tribev2's audio pipeline shells out to are
# reachable, regardless of how this process is launched (IDE, systemd, shell,
# queue worker):
#   - uvx    : tribev2 runs `uvx whisperx` for transcription
#   - ffmpeg : whisperx runs `ffmpeg` to decode audio
# Both are looked up on PATH by child processes, which inherit os.environ.
# ---------------------------------------------------------------------------
def _ensure_binaries_on_path() -> None:
    import shutil

    # Binary -> common install dirs to fall back to if not already on PATH.
    wanted = {
        "uvx": [Path.home() / ".local/bin", Path.home() / ".cargo/bin"],
        "ffmpeg": [Path("/opt/homebrew/bin"), Path("/usr/local/bin")],
    }
    install_hint = {
        "uvx": "Install uv: https://astral.sh/uv",
        "ffmpeg": "Install ffmpeg: brew install ffmpeg",
    }
    for binary, candidates in wanted.items():
        if shutil.which(binary):
            continue
        for candidate in candidates:
            if (candidate / binary).exists():
                os.environ["PATH"] = f"{candidate}{os.pathsep}{os.environ.get('PATH', '')}"
                logger.info(
                    f"Added {candidate} to PATH so '{binary}' can be found.")
                break
        else:
            logger.warning(
                f"'{binary}' not found on PATH; audio transcription will fail. {install_hint[binary]}")


def _pin_whisperx_env() -> None:
    """Steer the ephemeral `uvx whisperx` resolution that tribev2 spawns.

    The child process inherits os.environ, so uv's env vars set here apply.
    Without these, uv may pick Python 3.14 and torchaudio>=2.9 (which removed
    `list_audio_backends`), breaking pyannote.audio at import time.
    """
    os.environ.setdefault("UV_PYTHON", "3.11")
    constraints = Path(__file__).resolve().parent / "uvx-constraints.txt"
    if constraints.exists():
        os.environ.setdefault("UV_CONSTRAINT", str(constraints))


def _select_device() -> str:
    """Pick the fastest available torch device for the TRIBE brain model.

    Preference: CUDA > Apple Silicon GPU (MPS) > CPU. The library's own "auto"
    only knows cuda/cpu, so on a Mac it would fall back to CPU. When choosing
    MPS we enable PYTORCH_ENABLE_MPS_FALLBACK so any op not implemented on
    Metal runs on CPU instead of crashing. Override with
    TRIBE_DEVICE=cpu|cuda|mps if needed.

    This is the device for the brain model only — see `_extractor_device` for
    the feature extractors, which accept a narrower set.
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
    logger.info(f"Feature extractors will run on device: {device}")
    return device


# neuralset (which owns the feature extractors) declares `device` as a closed
# pydantic Literal — "auto" | "cpu" | "cuda" | "accelerate" — and has no MPS
# support anywhere in the package. Handing it "mps" fails validation inside
# `TribeModel(**config)`, before torch is ever reached. So the extractors get
# the nearest legal device while the brain model keeps whatever `_select_device`
# picked: `TribeModel.predict` moves every batch to `model.device`, so the two
# do not have to agree.
_NEURALSET_DEVICES = ("auto", "cpu", "cuda", "accelerate")


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


_ensure_binaries_on_path()
_pin_whisperx_env()
DEVICE = _select_device()
EXTRACTOR_DEVICE = _extractor_device(DEVICE)

# ---------------------------------------------------------------------------
# Global model instance (loaded once per process)
# ---------------------------------------------------------------------------
MODEL = None
CACHE_DIR = Path(os.getenv("TRIBE_CACHE_DIR", "./cache"))


# The pretrained config.yaml hardcodes `device: cuda` for every feature
# extractor (text/audio/video/image). Override to EXTRACTOR_DEVICE so they run
# on CPU when no CUDA GPU is present.
_FEATURE_DEVICE_KEYS = (
    "data.text_feature.device",
    "data.audio_feature.device",
    "data.video_feature.image.device",
    "data.image_feature.image.device",
)

# Accepted file extensions per modality (mirrors tribev2.VALID_SUFFIXES).
VIDEO_SUFFIXES = (".mp4", ".avi", ".mkv", ".mov", ".webm")
AUDIO_SUFFIXES = (".wav", ".mp3", ".flac", ".ogg")

SUFFIXES_BY_MODALITY = {"video": VIDEO_SUFFIXES, "audio": AUDIO_SUFFIXES}


def load_model():
    """Download (first run) and load TRIBE v2. Idempotent.

    Blocking and slow — several GB on a cold cache. Both callers do this once at
    startup rather than per request/job.
    """
    global MODEL
    if MODEL is not None:
        return MODEL

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    logger.info("Loading TRIBE v2 model (first run downloads several GB)…")
    try:
        from tribev2.demo_utils import TribeModel  # type: ignore
        MODEL = TribeModel.from_pretrained(
            "facebook/tribev2",
            cache_folder=str(CACHE_DIR),
            device=DEVICE,
            config_update={key: EXTRACTOR_DEVICE for key in _FEATURE_DEVICE_KEYS},
        )
        logger.info("TRIBE v2 model loaded successfully.")
    except Exception as exc:
        logger.error(f"Failed to load TRIBE v2 model: {exc}")
        raise RuntimeError(f"Model load failed: {exc}") from exc
    return MODEL


def unload_model() -> None:
    """Drop the reference (FastAPI teardown). Nothing else to clean up."""
    global MODEL
    MODEL = None


def is_loaded() -> bool:
    return MODEL is not None


def segment_text(segment) -> str:
    """The words spoken during one segment, joined in time order.

    whisperx transcription already ran as part of building the events dataframe,
    so the transcript is sitting on each segment as ``Word`` / ``Sentence``
    events — it costs nothing to read and is what lets the insight step say *why*
    attention moved rather than only *when*.

    Segments with no speech return ``""`` rather than being dropped: the
    transcript stays row-aligned with the attention curve, which is the entire
    reason it is worth carrying.
    """
    try:
        events = list(segment.ns_events)
    except Exception:
        return ""

    spoken = []
    for event in events:
        text = getattr(event, "text", None)
        if not isinstance(text, str) or not text.strip():
            continue
        # `Word` carries a `sentence` attribute, `Sentence` does not. Prefer word
        # events so the text lands in the segment it was actually spoken in;
        # taking both would duplicate every sentence across its own words.
        if type(event).__name__ == "Word":
            spoken.append((float(getattr(event, "start", 0.0)), text.strip()))

    if not spoken:
        # No word-level events — fall back to sentence-level, which is coarser
        # but better than reporting the clip as silent.
        for event in events:
            text = getattr(event, "text", None)
            if isinstance(text, str) and text.strip():
                spoken.append((float(getattr(event, "start", 0.0)), text.strip()))

    return " ".join(text for _, text in sorted(spoken))


def predictions_to_dict(preds: np.ndarray, segments: list) -> dict:
    """Serialise the (n_segments × n_vertices) prediction array to JSON.

    ``segments`` is a list of neuralset ``Segment`` objects aligned row-for-row
    with ``preds``; each exposes ``start`` / ``duration`` / ``stop`` and the
    events it covers via ``ns_events``.
    """
    seg_meta = []
    for seg in segments or []:
        try:
            n_events = len(seg.ns_events)
        except Exception:
            n_events = None
        seg_meta.append(
            {
                "start": float(getattr(seg, "start", 0.0)),
                "stop": float(getattr(seg, "stop", 0.0)),
                "duration": float(getattr(seg, "duration", 0.0)),
                "n_events": n_events,
                "text": segment_text(seg),
            }
        )

    # The per-network reduction — the part a creator is actually shown. Kept
    # separate from the brain-wide means below, which stay dev telemetry.
    bands = parcellation.axis_bands(preds)

    return {
        "shape": list(preds.shape),
        "n_timesteps": int(preds.shape[0]),  # one row per kept TR segment
        "n_vertices": int(preds.shape[1]),
        # Per-vertex mean activation across time (lightweight summary)
        "mean_activation_per_vertex": preds.mean(axis=0).tolist(),
        # Per-timestep mean activation across vertices
        "mean_activation_per_timestep": preds.mean(axis=1).tolist(),
        # Per-segment activation within each product axis, in AXES order.
        "axis_timeline": {
            axis: bands[:, index].tolist() for index, axis in enumerate(parcellation.AXES)
        },
        # Per-axis clip-level statistics — apps/worker ranks one of them.
        "axis_means": parcellation.clip_summary(bands),
        "duration_sec": max((meta["stop"] for meta in seg_meta), default=0.0),
        "stats": {
            "global_mean": float(preds.mean()),
            "global_std": float(preds.std()),
            "global_min": float(preds.min()),
            "global_max": float(preds.max()),
        },
        "segments": seg_meta,
    }


def run_inference(modality: str, path: str) -> tuple[np.ndarray, list]:
    """Blocking TRIBE v2 inference for a single file on disk.

    Synchronous and CPU/GPU-bound — both callers run it off the event loop
    (`run_in_threadpool` / `asyncio.to_thread`).
    """
    if MODEL is None:
        raise RuntimeError("Model is not loaded. Call load_model() first.")
    if modality == "video":
        df = MODEL.get_events_dataframe(video_path=path)
    else:
        df = MODEL.get_events_dataframe(audio_path=path)
    return MODEL.predict(events=df)


@contextmanager
def temp_media_file(suffix: str | None = None):
    """A named temp file that tribev2 can read from disk, cleaned up after.

    tribev2 takes paths, not buffers, so every entry point has to land the bytes
    somewhere first — over HTTP and off the queue alike.
    """
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix or None)
    try:
        tmp.close()
        yield Path(tmp.name)
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
