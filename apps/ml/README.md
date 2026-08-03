---
title: TRIBE v2 API
emoji: 🧠
colorFrom: blue
colorTo: purple
sdk: docker
app_port: 7860
suggested_hardware: l4x1
suggested_storage: large
---

# TRIBE v2 Video Analysis API

A lightweight **FastAPI** service that wraps Meta's [TRIBE v2](https://huggingface.co/facebook/tribev2) model, exposing a REST endpoint to predict **fMRI brain responses** to video (and audio) files.

> **What is TRIBE v2?**  
> A deep multimodal brain-encoding model from Meta that predicts how the human cortex responds to naturalistic stimuli. It combines V-JEPA2 (video), Wav2Vec-BERT (audio), and LLaMA 3.2 (text) into a unified Transformer that maps onto the fsaverage5 cortical mesh (~20 k vertices).

---

## Requirements

| Requirement           | Notes                                                                         |
| --------------------- | ----------------------------------------------------------------------------- |
| **Python**            | 3.11 (tested on 3.11.15; `exca` requires ≥ 3.11)                              |
| **pip**               | 23+                                                                           |
| **RAM**               | ≥ 8 GB (TRIBE v2 weights ~3.5 GB + Llama-3.2-3B ~6 GB)                        |
| **GPU**               | Optional but strongly recommended (CPU inference is slow)                     |
| **`uv` + `ffmpeg`**   | Required for transcription: tribev2 runs `uvx whisperx`, which needs `ffmpeg` |
| **HuggingFace token** | **Required for all inference** — gated [LLaMA 3.2-3B] text encoder.           |

[LLaMA 3.2-3B]: https://huggingface.co/meta-llama/Llama-3.2-3B

### HuggingFace access (required)

Every request runs TRIBE v2's text encoder, the **gated** `meta-llama/Llama-3.2-3B` repo:

1. Request access (one click, usually instant): <https://huggingface.co/meta-llama/Llama-3.2-3B>
2. Create a read token: <https://huggingface.co/settings/tokens>
3. Put it in `.env` (`cp .env.example .env`, then set `HF_TOKEN=hf_…`). `main.py` loads
   `.env` on startup and also accepts the `HUGGINGFACE_TOKEN` / `HUGGING_FACE_HUB_TOKEN` aliases.

Without it, inference fails with `401 ... gated repo` at the text-feature step.

---

## Quick start

### 1 — Clone / download the project

```bash
git clone <this-repo>
cd tribev2-api
```

### 2 — Create a virtual environment

```bash
pyenv versions
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
```

### 3 — Install dependencies

```bash
pip install -r requirements.txt
```

> First install pulls TRIBE v2 from GitHub and its transitive deps (PyTorch, transformers, etc.). This can take a few minutes.

### 4 — Configure environment

```bash
cp .env.example .env
# Edit .env — add your HuggingFace token if you plan to use text input
```

### 5 — Start the server

```bash
# Load .env automatically (Linux/macOS)
set -a && source .env && set +a

python main.py
# or
uvicorn main:app --host 0.0.0.0 --port 8000
```

---

## Two entry points

This app runs one of two ways, over one shared implementation:

| File            | What it is                              | Who drives it                                   |
| --------------- | --------------------------------------- | ----------------------------------------------- |
| **`main.py`**   | FastAPI — upload a file, get JSON back  | You, by hand; `example_client.py`; the HF Space |
| **`worker.py`** | BullMQ consumer of the `analysis` queue | `apps/api`, in production                       |

Both import **`engine.py`**, which owns the environment bootstrap (`.env`, PATH, whisperx pinning,
device selection), the model load, and inference itself. Loading ~10 GB of weights twice in two
slightly different ways is the drift that split avoids.

### The worker

```bash
python worker.py
```

Needs `REDIS_URL` (see `.env.example`) and a running Redis —
`docker compose -f ../../infra/docker/docker-compose.yml up -d`.

```text
apps/api  ──▶  [analysis]  ──▶  worker.py  ──▶  [analysis-results]  ──▶  apps/worker  ──▶  Postgres
```

It downloads the media, runs TRIBE v2, and publishes the outcome. **It never touches Postgres** —
Prisma is the single owner of the app schema, and a second ORM here is exactly the drift the
polyglot split exists to prevent. `apps/worker` (Bun) does the writing.

Interop is not a bridge or a translation layer: the `bullmq` PyPI package is the official port and
runs the _same Lua scripts_ as the npm one, so a job Bun adds is a job Python consumes. The payload
shapes live in [`queue_contract.py`](queue_contract.py), mirroring
[`packages/queue/src/contract.ts`](../../packages/queue/src/contract.ts) — **change one, change the
other.**

Why a queue rather than the HTTP endpoints above: inference is seconds-to-minutes and GPU-bound.
Blocking a client request on it would hold an API connection for the duration and lose the work on
any disconnect. The queue gives durability, retries with backoff, and lets the GPU box scale
independently of the API box.

Knobs (all optional, see `.env.example`): `ML_WORKER_CONCURRENCY` — default 1, because concurrency
here is GPU memory, not I/O; `ML_WORKER_LOCK_MS` — must exceed the slowest run or the stalled-job
checker hands the same clip to a second worker mid-inference; `ML_MAX_MEDIA_BYTES`,
`ML_DOWNLOAD_TIMEOUT_S`.

On first startup the model weights (~1 GB) are downloaded from HuggingFace to `./cache/`.

---

## API endpoints

| Method | Path             | Description                                  |
| ------ | ---------------- | -------------------------------------------- |
| `GET`  | `/`              | Health check                                 |
| `GET`  | `/health`        | Detailed health (model status, cache path)   |
| `POST` | `/analyze/video` | Predict brain responses to a **video** file  |
| `POST` | `/analyze/audio` | Predict brain responses to an **audio** file |

### Interactive docs

Open **http://localhost:8000/docs** for the Swagger UI.

---

## Usage examples

### curl

```bash
# Health check
curl http://localhost:8000/health

# Analyse a video (summary output)
curl -X POST http://localhost:8000/analyze/video \
     -F "file=@/path/to/video.mp4"

# Analyse a video — include full prediction tensor
curl -X POST "http://localhost:8000/analyze/video?include_full_predictions=true" \
     -F "file=@/path/to/video.mp4"
```

### Python client (included)

```bash
# Basic usage
python example_client.py /path/to/video.mp4

# Save full prediction tensor to JSON
python example_client.py /path/to/video.mp4 --full
```

### Python (requests)

```python
import requests

with open("video.mp4", "rb") as f:
    resp = requests.post(
        "http://localhost:8000/analyze/video",
        files={"file": ("video.mp4", f, "video/mp4")},
        timeout=300,
    )

data = resp.json()
print(data["stats"])
# {'global_mean': -0.012, 'global_std': 0.87, 'global_min': -4.2, 'global_max': 5.1}
print(data["shape"])
# [30, 20484]  →  (timesteps × cortical vertices)
```

---

## Response format

```jsonc
{
  "status": "success",
  "filename": "video.mp4",
  "shape": [30, 20484],
  "n_timesteps": 30,          // at 2 Hz (one per 500 ms)
  "n_vertices": 20484,        // fsaverage5 cortical mesh
  "mean_activation_per_vertex": [...],   // length n_vertices
  "mean_activation_per_timestep": [...], // length n_timesteps
  "stats": {
    "global_mean": -0.012,
    "global_std": 0.87,
    "global_min": -4.20,
    "global_max": 5.10
  },
  "segments": [
    { "start": 0.0, "stop": 2.0, "duration": 2.0, "n_events": 3 }
  ],
  // Only present if ?include_full_predictions=true
  "full_predictions": [[...], ...]  // shape: [n_timesteps][n_vertices]
}
```

---

## HuggingFace token

A **HuggingFace read token** is only required if you use the **text** modality (which downloads the gated LLaMA 3.2-3B model).

For **video-only** or **audio-only** requests no token is needed.

**How to create a token:**

1. Go to https://huggingface.co/settings/tokens
2. Click **New token → Read**
3. Copy the token into `.env` as `HUGGINGFACE_TOKEN`
4. Run `huggingface-cli login` and paste the token when prompted

---

## Environment variables

| Variable            | Default   | Description                         |
| ------------------- | --------- | ----------------------------------- |
| `HUGGINGFACE_TOKEN` | _(empty)_ | HF token (needed for text modality) |
| `TRIBE_CACHE_DIR`   | `./cache` | Where to store model weights        |
| `HOST`              | `0.0.0.0` | Bind address                        |
| `PORT`              | `8000`    | Listen port ress                    |
| `PORT`              | `8000`    | Listen port                         |

---

## Notes

- TRIBE v2 predictions are offset 5 s into the past to compensate for haemodynamic lag.
- Video should be **≥ 15–30 seconds** for meaningful predictions.
- CPU inference is supported but very slow; a CUDA GPU is recommended.
- The model weights are licensed under **CC-BY-NC-4.0** (non-commercial use only).

---

## Project structure

```
tribev2-api/
├── main.py             # FastAPI app + all endpoints
├── example_client.py   # Python client demo
├── requirements.txt    # Python dependencies
├── .env.example        # Environment variable template
└── README.md
```
