# TRIBE v2 API — GPU image for a Hugging Face Space (Docker SDK).
#
# Built on python:3.11-slim: the torch cu124 wheels bundle the CUDA runtime, so
# no CUDA base image is needed. Mirrors the requirements.txt install note, just
# swapping the `cpu` PyTorch index for `cu124` so inference runs on the GPU.
#
# Local build note: this targets linux/amd64 + CUDA. It won't run on an Apple
# Silicon Mac — build/run it on the Space (or any x86 CUDA host), not locally.
FROM python:3.11-slim

# System deps:
#   ffmpeg  — whisperx decodes audio with it (spawned via `uvx whisperx`)
#   git     — pip installs tribev2 from git+https (see requirements.txt)
#   curl    — fetches the uv installer below
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        git \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Hugging Face Spaces runs the container as uid 1000. Match it so files written
# at runtime (temp uploads, caches) are owned correctly.
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

# uv provides `uvx`, which tribev2 shells out to for whisperx transcription.
RUN curl -LsSf https://astral.sh/uv/install.sh | sh

WORKDIR /home/user/app

# Install deps first (better layer caching). torch/vision/audio come from the
# CUDA index; everything else from PyPI.
COPY --chown=user:user requirements.txt uvx-constraints.txt postinstall.py ./
RUN pip install --no-cache-dir -r requirements.txt \
        --index-url https://download.pytorch.org/whl/cu124 \
        --extra-index-url https://pypi.org/simple

# Re-apply tribev2/neuralset source patches (idempotent). On CUDA this keeps
# whisperx on float16 and is otherwise a no-op.
RUN python postinstall.py

# App code.
COPY --chown=user:user . .

# Safe local defaults. Override to /data/... via Space Variables once persistent
# storage is enabled, so the ~10 GB of weights survive restarts:
#   TRIBE_CACHE_DIR=/data/cache   HF_HOME=/data/hf
ENV TRIBE_CACHE_DIR=/home/user/app/cache \
    HF_HOME=/home/user/.cache/huggingface \
    PORT=7860

EXPOSE 7860
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860"]
