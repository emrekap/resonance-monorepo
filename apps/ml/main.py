"""
TRIBE v2 Video Analysis API
Predicts fMRI brain responses to video input using Meta's TRIBE v2 model.
"""

import os
import tempfile
import logging
from pathlib import Path
from contextlib import asynccontextmanager

import numpy as np
import uvicorn
from fastapi import FastAPI, File, UploadFile, HTTPException, Query
from fastapi.responses import JSONResponse
from fastapi.concurrency import run_in_threadpool

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s")
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
# reachable, regardless of how this server is launched (IDE, systemd, shell):
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
    """Pick the fastest available torch device for the feature extractors.

    Preference: CUDA > Apple Silicon GPU (MPS) > CPU. The library's own "auto"
    only knows cuda/cpu, so on a Mac it would fall back to (very slow) CPU for
    the ViT-g video encoders. When choosing MPS we enable
    PYTORCH_ENABLE_MPS_FALLBACK so any op not implemented on Metal runs on CPU
    instead of crashing. Override with TRIBE_DEVICE=cpu|cuda|mps if needed.
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


_ensure_binaries_on_path()
_pin_whisperx_env()
DEVICE = _select_device()

# ---------------------------------------------------------------------------
# Global model instance (loaded once at startup)
# ---------------------------------------------------------------------------
MODEL = None
CACHE_DIR = Path(os.getenv("TRIBE_CACHE_DIR", "./cache"))


# The pretrained config.yaml hardcodes `device: cuda` for every feature
# extractor (text/audio/video/image). Override to the selected device so they
# run on MPS/CPU when no CUDA GPU is present.
_FEATURE_DEVICE_KEYS = (
    "data.text_feature.device",
    "data.audio_feature.device",
    "data.video_feature.image.device",
    "data.image_feature.image.device",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load the model once when the server starts."""
    global MODEL
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    logger.info("Loading TRIBE v2 model (first run downloads several GB)…")
    try:
        from tribev2.demo_utils import TribeModel  # type: ignore
        MODEL = TribeModel.from_pretrained(
            "facebook/tribev2",
            cache_folder=str(CACHE_DIR),
            device=DEVICE,
            config_update={key: DEVICE for key in _FEATURE_DEVICE_KEYS},
        )
        logger.info("TRIBE v2 model loaded successfully.")
    except Exception as exc:
        logger.error(f"Failed to load TRIBE v2 model: {exc}")
        raise RuntimeError(f"Model load failed: {exc}") from exc
    yield
    # Teardown (nothing to clean up)
    MODEL = None


app = FastAPI(
    title="TRIBE v2 Brain Encoding API",
    description=(
        "Predict fMRI brain responses to video using Meta's TRIBE v2 model. "
        "Upload a video file and receive predicted neural activations on the "
        "fsaverage5 cortical surface (~20 k vertices)."
    ),
    version="1.0.0",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Accepted file extensions per modality (mirrors tribev2.VALID_SUFFIXES).
VIDEO_SUFFIXES = (".mp4", ".avi", ".mkv", ".mov", ".webm")
AUDIO_SUFFIXES = (".wav", ".mp3", ".flac", ".ogg")


def _predictions_to_dict(preds: np.ndarray, segments: list) -> dict:
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
            }
        )

    return {
        "shape": list(preds.shape),
        "n_timesteps": int(preds.shape[0]),  # one row per kept TR segment
        "n_vertices": int(preds.shape[1]),
        # Per-vertex mean activation across time (lightweight summary)
        "mean_activation_per_vertex": preds.mean(axis=0).tolist(),
        # Per-timestep mean activation across vertices
        "mean_activation_per_timestep": preds.mean(axis=1).tolist(),
        "stats": {
            "global_mean": float(preds.mean()),
            "global_std": float(preds.std()),
            "global_min": float(preds.min()),
            "global_max": float(preds.max()),
        },
        "segments": seg_meta,
    }


def _run_inference(modality: str, tmp_path: str) -> tuple[np.ndarray, list]:
    """Blocking TRIBE v2 inference for a single saved file. Runs in a thread."""
    if modality == "video":
        df = MODEL.get_events_dataframe(video_path=tmp_path)
    else:
        df = MODEL.get_events_dataframe(audio_path=tmp_path)
    return MODEL.predict(events=df)


async def _analyze(
    modality: str,
    file: UploadFile,
    allowed_suffixes: tuple[str, ...],
    include_full_predictions: bool,
) -> JSONResponse:
    """Shared upload → save → infer → serialise flow for both endpoints."""
    if MODEL is None:
        raise HTTPException(
            status_code=503, detail="Model is not loaded yet. Try again shortly."
        )

    filename = file.filename or ""
    suffix = Path(filename).suffix.lower()
    content_type = file.content_type or ""
    if suffix not in allowed_suffixes and not content_type.startswith(f"{modality}/"):
        raise HTTPException(
            status_code=415,
            detail=(
                f"Unsupported {modality} file '{filename}' (type '{content_type}'). "
                f"Accepted extensions: {', '.join(allowed_suffixes)}."
            ),
        )

    # Persist the upload so tribev2 can read it from disk.
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix or None) as tmp:
            content = await file.read()
            tmp.write(content)
            tmp_path = tmp.name
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save upload: {exc}")

    try:
        logger.info(
            f"Running TRIBE v2 {modality} inference on '{filename}' "
            f"({len(content) / 1e6:.1f} MB)…"
        )
        # Inference is CPU/GPU-bound and synchronous — keep the event loop free.
        preds, segments = await run_in_threadpool(_run_inference, modality, tmp_path)

        result = _predictions_to_dict(preds, segments)
        if include_full_predictions:
            result["full_predictions"] = preds.tolist()

        logger.info(
            f"Inference complete: shape={preds.shape}, "
            f"mean={preds.mean():.4f}, std={preds.std():.4f}"
        )
        return JSONResponse(
            content={"status": "success", "filename": filename, **result}
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"Inference failed: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Inference failed: {exc}")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/", summary="Health check")
async def root():
    return {"status": "ok", "model_loaded": MODEL is not None}


@app.get("/health", summary="Detailed health check")
async def health():
    return {
        "status": "ok" if MODEL is not None else "model_not_loaded",
        "model": "facebook/tribev2",
        "cache_dir": str(CACHE_DIR.resolve()),
    }


@app.post(
    "/analyze/video",
    summary="Predict brain responses to a video",
    response_class=JSONResponse,
)
async def analyze_video(
    file: UploadFile = File(..., description="Video file (mp4, avi, mkv, mov, webm)"),
    include_full_predictions: bool = Query(
        False,
        description=(
            "If true, include the full (n_timesteps × n_vertices) prediction "
            "matrix in the response. Warning: this can be very large."
        ),
    ),
):
    """
    Upload a video and receive predicted fMRI brain activations.

    The audio track is transcribed (whisperx) and the video/audio/text streams
    are fed through TRIBE v2. Returns per-vertex and per-timestep mean
    activations plus global stats on the fsaverage5 cortical mesh.
    """
    return await _analyze("video", file, VIDEO_SUFFIXES, include_full_predictions)


@app.post(
    "/analyze/audio",
    summary="Predict brain responses to an audio file",
    response_class=JSONResponse,
)
async def analyze_audio(
    file: UploadFile = File(..., description="Audio file (wav, mp3, flac, ogg)"),
    include_full_predictions: bool = Query(
        False,
        description="If true, include the full prediction matrix (can be large).",
    ),
):
    """
    Upload an audio file and receive predicted fMRI brain activations.
    The audio is transcribed and processed through the audio/text modalities.
    """
    return await _analyze("audio", file, AUDIO_SUFFIXES, include_full_predictions)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", 8000)),
        reload=False,
        log_level="info",
    )
