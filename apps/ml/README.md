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

**`apps/ml`** — the Python half of the polyglot split. It wraps Meta's
[TRIBE v2](https://huggingface.co/facebook/tribev2) to predict **fMRI brain responses** to video and
audio, and reduces them to the five product axes the app shows. Two entry points over one engine: a
**BullMQ worker** (what `apps/api` actually drives) and a **FastAPI** face (manual use, and the
Space's health check).

> **What is TRIBE v2?**
> A deep multimodal brain-encoding model from Meta that predicts how the human cortex responds to naturalistic stimuli. It combines V-JEPA2 (video), Wav2Vec-BERT (audio), and LLaMA 3.2 (text) into a unified Transformer that maps onto the fsaverage5 cortical mesh (~20 k vertices).

This is a **Python island**: no `package.json`, so Bun and Turbo ignore it by design. It is driven
from here, not from the repo root — except `bun run test:ml`, which shells into the venv below.

---

## Requirements

| Requirement           | Notes                                                                              |
| --------------------- | ---------------------------------------------------------------------------------- |
| **Python**            | 3.11 (tested on 3.11.15; `exca` requires ≥ 3.11)                                   |
| **pip**               | 23+                                                                                |
| **RAM**               | ≥ 8 GB — the loaded model is TRIBE v2 (~3.5 GB) plus Llama-3.2-3B (~6 GB)          |
| **Disk**              | ~10 GB in `TRIBE_CACHE_DIR` — the TRIBE checkpoint (~1 GB) plus its three encoders |
| **GPU**               | Optional but strongly recommended (CPU inference is slow)                          |
| **`uv` + `ffmpeg`**   | Required for transcription: tribev2 runs `uvx whisperx`, which needs `ffmpeg`      |
| **HuggingFace token** | **Required for all inference** — including video-only and audio-only. See below.   |

### HuggingFace access — required for every request, not just text

Every run loads TRIBE v2's text encoder, the **gated**
[`meta-llama/Llama-3.2-3B`](https://huggingface.co/meta-llama/Llama-3.2-3B) repo. There is no
video-only or audio-only path that skips it — the trimodal transformer wants all three streams, so
a missing token fails a silent-video clip exactly as it fails a talking head
([`engine.py`](engine.py) says the same at the bootstrap).

1. Request access (one click, usually instant): <https://huggingface.co/meta-llama/Llama-3.2-3B>
2. Create a read token: <https://huggingface.co/settings/tokens>
3. Put it in `.env` (`cp .env.example .env`, then set `HF_TOKEN=hf_…`). `engine.py` loads `.env` on
   startup and bridges the `HUGGINGFACE_TOKEN` / `HUGGING_FACE_HUB_TOKEN` aliases onto `HF_TOKEN`
   for `huggingface_hub`. No `huggingface-cli login` needed — the env var is the whole mechanism,
   which is also how the container gets it (a Space secret, never a layer in the image).

Without it, inference fails with `401 ... gated repo` at the text-feature step.

---

## Quick start

### 1 — Get to this directory

```bash
git clone <this-repo> resonance-monorepo
cd resonance-monorepo/apps/ml
```

### 2 — Create a virtual environment

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
```

`.venv` in **this** directory is also what `bun run test:ml` looks for from the repo root; it fails
with a pointer here if it is missing.

### 3 — Install dependencies

Two files, and which one you want depends on whether you intend to run the model:

```bash
pip install -r requirements.txt        # to RUN inference: torch + tribev2 from git, several minutes
pip install -r requirements-dev.txt    # to run the TESTS only: no torch, no tribev2, seconds
```

The suite needs only the dev file because the model sits behind a backend seam — see
[Tests](#tests). CI installs `requirements-dev.txt` precisely so that a stray module-scope
`import torch` turns the job red.

### 4 — Configure environment

```bash
cp .env.example .env
# Edit .env — HF_TOKEN is required (see above); REDIS_URL if you will run the worker
```

### 5 — Start something

```bash
python worker.py                    # the queue worker — what apps/api drives
ML_BACKEND=synthetic python worker.py   # ...the same worker, without a GPU

python main.py                      # or the FastAPI face → http://localhost:8040
uvicorn main:app --host 0.0.0.0 --port 8040
```

`engine.py` loads `.env` itself, so no `set -a && source .env` dance is needed.

---

## Two entry points

This app runs one of two ways, over one shared implementation:

| File            | What it is                              | Who drives it                              |
| --------------- | --------------------------------------- | ------------------------------------------ |
| **`main.py`**   | FastAPI — upload a file, get JSON back  | You, by hand; `example_client.py`          |
| **`worker.py`** | BullMQ consumer of the `analysis` queue | `apps/api`, in production and on the Space |

Both import **`engine.py`**, which owns the environment bootstrap (`.env`, PATH, whisperx pinning,
device selection), the model load, and inference itself. Loading ~10 GB of weights twice in two
slightly different ways is the drift that split avoids.

## From vertices to product axes

TRIBE predicts `[n_segments × 20484]` BOLD on the fsaverage5 cortical surface. Nobody can be shown
that, and the brain-wide _average_ of it is the one summary independent work has shown does **not**
predict engagement ([`docs/resonance-model-design.md`](../../docs/resonance-model-design.md) §0) —
the signal lives in specific networks. So `parcellation.py` averages _within_ networks instead:

```text
preds [T × 20484] ──atlas/──▶ five per-segment bands ──▶ three timeline curves
                                                     └─▶ five clip-level scalars
```

| Axis         | Cortex                          | Defensibility                                                      |
| ------------ | ------------------------------- | ------------------------------------------------------------------ |
| visual       | Visual + Dorsal Attention       | high — best-predicted cortex, 1:1 with the video encoder           |
| audio        | auditory cortex (`SomMotB_Aud`) | high — direct match for the audio encoder                          |
| language     | temporo-parietal + Default-B    | medium — solid for speech, meaningless without it                  |
| emotional    | Limbic                          | **low** — the real reward circuitry is subcortical and absent here |
| memorability | Default Mode core               | **low** — memory encoding needs hippocampus, also absent           |

The last two still get numbers, and ship labelled `BETA` in the product regardless. Having a number
does not make a cortical proxy for a subcortical structure defensible.

### The atlas

`atlas/schaefer400_17networks_fsaverage5.npz` is **committed** — 14 KB, generated once by
[`scripts/build_atlas.py`](scripts/build_atlas.py) from the Schaefer 2018 400-parcel / 17-network
parcellation (Yeo lab / CBIG). Nothing at runtime downloads it, which is why `nilearn` stays an
optional dependency.

Schaefer rather than the raw Yeo-17 annotation for two reasons: every parcel name carries its network
assignment (`17Networks_LH_SomMotB_Aud_1`), so [`atlas/axis_map.py`](atlas/axis_map.py) can be checked
against the data; and it is sub-parcelled, which the audio axis needs — at the 17-network level
auditory cortex is inside SomMotB next to hand and foot motor, and the band would be mostly dilution.

The artifact stores **parcel ids**, not axis ids, so remapping an axis is a code review rather than a
regenerated binary. It holds an `int16` array and a unicode string array — never a pickled object
array, so loading it can never execute code.

Rebuild only if the source parcellation changes:

```bash
python scripts/build_atlas.py    # needs nibabel + network access
```

### Tests

The model sits behind a seam (`backends/`), so the suite needs neither a GPU nor `tribev2` nor torch
— it runs on a laptop and on a CI runner in under a second.

```bash
python -m venv .venv && ./.venv/bin/pip install -r requirements-dev.txt
./.venv/bin/python -m pytest
```

Or `bun run test:ml` from the repo root, which also runs as part of `bun run test`. CI runs the same
thing on every push (`.github/workflows/test.yml`).

Three tiers; the last two are deselected by default, so a bare `pytest` never needs a daemon:

| Command                 | Needs                  | Covers                                      |
| ----------------------- | ---------------------- | ------------------------------------------- |
| `pytest`                | nothing                | everything below the model                  |
| `pytest -m integration` | `bun run docker:local` | the real BullMQ round-trip through Redis    |
| `pytest -m gpu`         | a GPU + `tribev2`      | `TribeBackend` against the backend contract |

`tests/test_parcellation.py` plants a known signal in each network's vertices and asserts the bands
recover it exactly — the only end-to-end check that the masks index what they claim to. It also
rejects the wrong surface, a transposed array, and any axis that resolves to zero vertices.

`tests/test_contract.py` is the Python half of the api↔ml boundary check: it asserts Pydantic still
reproduces `packages/queue/src/__fixtures__/analysis-succeeded.json`, which `contract.test.ts` parses
with zod. The two files are mirrored by hand, so nothing but this notices when one side moves. After
an intentional contract change, `pytest tests/test_contract.py --regenerate-fixture`.

`tests/test_neuralset_types.py` checks the `Segment` / `Word` stand-ins in `backends/synthetic.py`
against the **real** neuralset classes. It runs here (this venv has neuralset) and skips in CI — so
the fake's assumptions are re-verified on every local run rather than deferred to a GPU that is not
available. It is what established that the real `Word` requires a `timeline` field.

### The worker

```bash
python worker.py
```

Needs `REDIS_URL` (see `.env.example`) and a running Redis —
`docker compose -f ../../infra/docker/docker-compose.yml up -d`.

#### Without a GPU

```bash
ML_BACKEND=synthetic python worker.py
```

Real Redis, real download, real `worker.py` — only the model is fabricated, from a deterministic
tensor with signal planted into named cortical networks. The run reports `device: "synthetic"`, which
lands in `inference_runs.device`, so a synthetic result can always be told from a real one in the
database.

| Variable                | Default | Meaning                                        |
| ----------------------- | ------- | ---------------------------------------------- |
| `ML_BACKEND`            | `tribe` | `tribe` \| `synthetic`                         |
| `ML_SYNTH_SCENARIO`     | `mixed` | `visual_burst` \| `talky` \| `flat` \| `mixed` |
| `ML_SYNTH_SEED`         | `0`     | makes the fabricated tensor reproducible       |
| `ML_SYNTH_DURATION_SEC` | probed  | skip reading the media's real duration         |
| `ML_RECORD_DIR`         | unset   | write a `tribe-shape.json` manifest per run    |

`ML_RECORD_DIR` is how the two remaining guesses in `backends/synthetic.py` (`TR_SEC`, the dtype)
eventually become facts: set it on a box that can run the real model, and commit the manifest.

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

On first startup the weights are downloaded from HuggingFace to `TRIBE_CACHE_DIR` (default
`./cache/`) — **~10 GB**: the TRIBE v2 checkpoint is only ~1 GB of that, the three encoders are the
rest. Budget the disk and the first-boot minutes accordingly.

### On the Hugging Face Space

The Space runs **both** processes from one container ([`entrypoint.sh`](entrypoint.sh)): `worker.py`
is the point of it, and `main.py` rides along because a Docker Space that never answers on
`app_port` is never marked healthy. Only the worker loads TRIBE v2 — `engine.MODEL` is a per-process
global, so a second process means a second multi-GB copy on the same card. The HTTP face therefore
starts with `ML_HTTP_LOAD_MODEL=0`: `/` and `/health` answer (with `"inference": "queue-worker"`) and
`/analyze/*` returns 503. Inference there goes through the queue, which is the only path
`apps/api` uses anyway.

`REDIS_URL` must be a Redis the Space can reach — a managed one (Upstash, Redis Cloud), not the
`infra/docker` localhost default — and the same instance `apps/api` and `apps/worker` point at. It
carries a password, so it is a Space **secret**, never a variable and never a layer in the image.

#### Deploy

```bash
cd apps/ml
python manage_space.py secrets    # 1. push HF_TOKEN + REDIS_URL from .env
python manage_space.py deploy     # 2. upload the code — triggers a rebuild
python manage_space.py status     # 3. wait for stage=RUNNING
curl -H "Authorization: Bearer $HF_TOKEN" https://<you>-tribev2-api.hf.space/health
```

1. **`secrets`** — the two credentials the container has no other way to get, since `.env` is never
   uploaded. Changing them later needs a `restart` to take effect.
2. **`deploy`** — uploads this folder to the Space repo, which starts a build. The weights live on the
   persistent `/data` volume (the `TRIBE_CACHE_DIR` / `HF_HOME` Space variables), so a rebuild
   re-installs the image but does not re-download ~10 GB.
3. **`status`** — stage, hardware, storage. A fresh boot still spends minutes loading the model onto
   the card before the worker starts consuming.
4. The health check should answer `"inference": "queue-worker"`, and the Space logs should carry
   `🧠 ml worker consuming "…:analysis"` — that line, not the HTTP 200, is what says jobs from
   `apps/api` are being picked up.

Also: `restart` (pick up new secrets), `pause` (stop the GPU meter), `provision` (first-time setup).

Two things the tooling cannot check for you. Upstash blocks `CONFIG GET`, so confirm in its console
that **eviction is off** — BullMQ needs `noeviction` or it drops jobs under memory pressure. And a
worker blocks on `BZPOPMIN` around the clock, which bills per command on a managed Redis. A running
Space also competes for jobs with any local `python worker.py`.

If either process exits, `entrypoint.sh` takes the container down with it: a Space that still serves
`/health` while the worker is dead looks healthy while the queue silently backs up. A stop is
forwarded as SIGTERM so `worker.py` drains the job it is holding — without that, a paused or
restarted Space leaves the job `active` until `ML_WORKER_LOCK_MS` (30 min) expires and BullMQ's
stalled-job checker requeues it.

---

## API endpoints

**The FastAPI face is not on the product's path** — `apps/api` reaches this service only over the
queue. These endpoints are for driving the model by hand, and for giving the Space something to
answer a health check with. On the Space they run with `ML_HTTP_LOAD_MODEL=0`, so `/analyze/*`
returns **503** there and only the two health routes work.

| Method | Path             | Description                                  |
| ------ | ---------------- | -------------------------------------------- |
| `GET`  | `/`              | Health check                                 |
| `GET`  | `/health`        | Detailed health (model status, cache path)   |
| `POST` | `/analyze/video` | Predict brain responses to a **video** file  |
| `POST` | `/analyze/audio` | Predict brain responses to an **audio** file |

### Interactive docs

Open **<http://localhost:8040/docs>** for the Swagger UI.

---

## Usage examples

### curl

```bash
# Health check
curl http://localhost:8040/health

# Analyse a video (summary output)
curl -X POST http://localhost:8040/analyze/video \
     -F "file=@/path/to/video.mp4"

# Analyse a video — include full prediction tensor
curl -X POST "http://localhost:8040/analyze/video?include_full_predictions=true" \
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
        "http://localhost:8040/analyze/video",
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
  "n_timesteps": 30,          // one row per fMRI TR — see the caveat below
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

**`n_timesteps` and `segments` count different things.** A timestep is one **model output row**, one
per fMRI repetition time (TR); a segment is one **input window** carrying the whisperx events, which
is why `n_events` hangs off it. They are not the same clock and neither is a video frame rate.

**The TR is not confirmed.** `backends/synthetic.py` assumes `TR_SEC = 1.49`, and that constant is
one of the two documented guesses in this package, not a measurement — the timeline the product
draws is indexed by it. `ML_RECORD_DIR=<dir> python worker.py` on a box that can run the real model
writes a `tribe-shape.json` manifest; committing one is what turns the guess into a fact. Until then
do not quote a sampling rate in user-facing copy.

---

## Environment variables

[`.env.example`](.env.example) is the authoritative list and carries the reasoning inline; this is
the summary.

| Variable                | Default                  | Applies to  | Meaning                                                                                |
| ----------------------- | ------------------------ | ----------- | -------------------------------------------------------------------------------------- |
| `HF_TOKEN`              | _(empty)_                | both        | **Required for all inference.** Aliases: `HUGGINGFACE_TOKEN`, `HUGGING_FACE_HUB_TOKEN` |
| `TRIBE_CACHE_DIR`       | `./cache`                | both        | Where the ~10 GB of weights land                                                       |
| `TRIBE_DEVICE`          | auto                     | both        | Force `cpu` \| `cuda` \| `mps`; auto-detects cuda > mps > cpu                          |
| `HOST`                  | `0.0.0.0`                | `main.py`   | Bind address                                                                           |
| `PORT`                  | `8040`                   | `main.py`   | Listen port (the container sets `7860` for the Space)                                  |
| `ML_HTTP_LOAD_MODEL`    | `1`                      | `main.py`   | `0` starts the HTTP face without the model; `/analyze/*` → 503                         |
| `REDIS_URL`             | `redis://127.0.0.1:6379` | `worker.py` | The queue. Same instance as `apps/api` and `apps/worker`                               |
| `ML_BACKEND`            | `tribe`                  | `worker.py` | `tribe` \| `synthetic`                                                                 |
| `ML_WORKER_CONCURRENCY` | `1`                      | `worker.py` | Jobs in flight. This is GPU memory, not I/O                                            |
| `ML_WORKER_LOCK_MS`     | `1800000`                | `worker.py` | Must exceed the slowest run, or a stalled-job check double-runs a clip                 |
| `ML_RESULT_ATTEMPTS`    | `5`                      | `worker.py` | Retries `apps/worker` gets to persist one result                                       |
| `ML_MAX_MEDIA_BYTES`    | `2147483648`             | `worker.py` | Refuse larger media instead of filling the disk                                        |
| `ML_DOWNLOAD_TIMEOUT_S` | `300`                    | `worker.py` | Media download timeout                                                                 |
| `ML_SYNTH_SCENARIO`     | `mixed`                  | synthetic   | `visual_burst` \| `talky` \| `flat` \| `mixed`                                         |
| `ML_SYNTH_SEED`         | `0`                      | synthetic   | Makes the fabricated tensor reproducible                                               |
| `ML_SYNTH_DURATION_SEC` | probed                   | synthetic   | Skip reading the media's real duration                                                 |
| `ML_RECORD_DIR`         | unset                    | `worker.py` | Write a `tribe-shape.json` manifest per run                                            |

---

## Notes

- TRIBE v2 predictions are offset 5 s into the past to compensate for haemodynamic lag.
- Video should be **≥ 15–30 seconds** for meaningful predictions.
- CPU inference is supported but very slow; a CUDA GPU is recommended.
- The model weights are licensed under **CC-BY-NC-4.0** (non-commercial use only) — which is why
  `docs/investor-one-pager.md` scopes TRIBE to MVP validation and the commercial product to an
  independently trained model.

---

## Project structure

```text
apps/ml/
├── worker.py            # BullMQ consumer of `analysis` — the production entry point
├── main.py              # FastAPI face: /health + /analyze/{video,audio}
├── engine.py            # SHARED: .env + PATH bootstrap, whisperx pin, device, model load, inference
├── parcellation.py      # [T × 20484] → five per-segment product-axis bands
├── queue_contract.py    # Pydantic mirror of packages/queue/src/contract.ts — CHANGE BOTH
├── backends/            # the model seam that keeps the tests torch-free
│   ├── tribe.py         #   the real thing — the ONLY module that may import torch
│   └── synthetic.py     #   deterministic fake with signal planted in named networks
├── atlas/
│   ├── schaefer400_17networks_fsaverage5.npz   # committed, 14 KB, parcel ids not axis ids
│   └── axis_map.py      #   parcel → product axis, in code so it is reviewable
├── scripts/build_atlas.py   # regenerates the .npz (needs nibabel + network)
├── tests/               # pytest — no GPU, no torch, no tribev2
├── manage_space.py      # HF Space deploy: secrets / deploy / status / restart / pause
├── entrypoint.sh        # runs uvicorn + worker.py in one container, dies if either does
├── Dockerfile
├── requirements.txt     # to RUN: torch + tribev2 from git
├── requirements-dev.txt # to TEST: neither
├── example_client.py
└── .env.example
```
