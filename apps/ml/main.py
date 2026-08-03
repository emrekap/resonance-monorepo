"""
TRIBE v2 Video Analysis API
Predicts fMRI brain responses to video input using Meta's TRIBE v2 model.

This is the HTTP face of the service — the one the Hugging Face Space serves,
and the one to poke by hand or from `example_client.py`. The model lifecycle and
inference itself live in `engine.py`, shared with `worker.py` (the queue
consumer that `apps/api` actually drives; see apps/ml/README.md).
"""

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, File, UploadFile, HTTPException, Query
from fastapi.responses import JSONResponse
from fastapi.concurrency import run_in_threadpool

import engine

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load the model once when the server starts."""
    engine.load_model()
    yield
    engine.unload_model()


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

async def _analyze(
    modality: str,
    file: UploadFile,
    allowed_suffixes: tuple[str, ...],
    include_full_predictions: bool,
) -> JSONResponse:
    """Shared upload → save → infer → serialise flow for both endpoints."""
    if not engine.is_loaded():
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
        content = await file.read()
        with engine.temp_media_file(suffix) as tmp_path:
            tmp_path.write_bytes(content)

            logger.info(
                f"Running TRIBE v2 {modality} inference on '{filename}' "
                f"({len(content) / 1e6:.1f} MB)…"
            )
            # Inference is CPU/GPU-bound and synchronous — keep the event loop free.
            preds, segments = await run_in_threadpool(
                engine.run_inference, modality, str(tmp_path)
            )

        result = engine.predictions_to_dict(preds, segments)
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


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/", summary="Health check")
async def root():
    return {"status": "ok", "model_loaded": engine.is_loaded()}


@app.get("/health", summary="Detailed health check")
async def health():
    return {
        "status": "ok" if engine.is_loaded() else "model_not_loaded",
        "model": "facebook/tribev2",
        "device": engine.DEVICE,
        "cache_dir": str(engine.CACHE_DIR.resolve()),
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
    return await _analyze("video", file, engine.VIDEO_SUFFIXES, include_full_predictions)


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
    return await _analyze("audio", file, engine.AUDIO_SUFFIXES, include_full_predictions)


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
