# TDD for `apps/ml` — testing the ML island without a GPU

**Date:** 2026-08-07
**Scope:** `apps/ml`, `.github/workflows`, root `package.json`, `CLAUDE.md`
**Status:** designed, not implemented

## Problem

`apps/ml` cannot be developed on the machine it is developed on.

TRIBE v2 needs a GPU and ~10 GB of gated weights. The MacBook has neither — the `tribev2` package is
not even installed in `apps/ml/.venv`. So every change to `worker.py` is written blind and verified,
if at all, by deploying it. The monorepo's own `TODO` says as much: _"run a real clip through ml →
worker → Postgres"_ is still open, and everything downstream of it — the five timeline arrays, the
percentile, the recommendations — is marked **done, unobserved**.

The cost is concentrated in the code that has nothing to do with the model. `worker.py` is 407 lines,
of which perhaps 30 call TRIBE. The rest is a download with two independent size caps and a
content-type fallback, five mapping functions that reshape the model's output into the queue
contract, and a processor that has to get attempt arithmetic and a `retryable` boolean exactly right
or an analysis is stranded `PROCESSING` forever. **None of it is tested.** All of it runs fine on a
Mac.

Two smaller problems sit alongside:

- **The suite that exists cannot be run.** `tests/test_parcellation.py` and `tests/test_contract.py`
  are good tests, but `pytest` is not installed in `.venv` and is commented out in
  `requirements.txt` under "Dev only". There is no pytest config, no CI, and `turbo run test` does
  not reach `apps/ml` (no `package.json`, by design).
- **Nothing can be exercised end to end locally.** `api → queue → ml → worker → Postgres → mobile`
  has never run in one piece, because the third hop needs a GPU.

## Goals

1. `pytest` on the MacBook covers `worker.py`'s real logic — download, mapping, publishing — in
   seconds, with no GPU, no network and no Redis.
2. The same suite runs green in **GitHub Actions** on a stock runner, without torch, without
   `tribev2`, without a GPU.
3. `python worker.py` runs locally without a GPU, so the whole product path can be exercised on one
   machine.
4. Test-first becomes the working default for `apps/ml`: pytest declared, configured, reachable from
   one repo-wide command, and enforced by CI.
5. The assumptions the fake encodes are **verified against the real types**, not deferred.

## Non-goals

- **Testing TRIBE itself.** Meta's model is a dependency, not our code. This tests our use of it.
- **Replacing `tests/test_parcellation.py` or `tests/test_contract.py`.** Both stay untouched; they
  already do their jobs.
- **A new `.claude/skills/` skill.** `superpowers:test-driven-development` covers the how, and a
  second document restating it is one more thing to keep in sync. A `CLAUDE.md` bullet pointing at
  the seam carries the only repo-specific part.
- **A `ReplayBackend` over recorded tensors.** See [Decision 5](#decision-5--record-a-1-kb-manifest-not-a-2-mb-tensor).

## What already exists (verified)

Everything in this section was checked, not assumed.

- `engine.py` **imports cleanly on the Mac** — torch 2.6 is installed, `device` resolves to `mps`.
  Only `load_model()` and `run_inference()` fail, because `tribev2` is absent.
- **In a minimal venv** (`numpy pydantic bullmq requests pytest pytest-asyncio`, ~20 s to install):
  `parcellation`, `atlas.axis_map` and `queue_contract` all import, `n_vertices()` is 20484,
  `axis_bands` returns `(3, 5)`, and `bullmq` imports. **`import engine` fails with
  `No module named 'torch'`** — and the only reason is `_select_device()` running at module scope.
  That single line is what stands between this repo and cheap CI.
- The real `neuralset` types are **installed locally and readable**:
  - `neuralset/segments.py:180` — `Segment` is a dataclass of `start: float`, `duration: float`,
    `timeline: str`, with `stop` (`= start + duration`) and `ns_events` as properties.
    `ns_events` reads from a shared `_EventStore`; segments are "not meant to be instantiated
    directly" — `list_segments(events_df, ...)` builds them.
  - `neuralset/events/etypes.py:671` — `Word` and `Sentence` are `BaseText(Event)` with
    `text: str` (`min_length=1`), `start: float`, `duration: NonNegativeFloat = 0.0`.
  - `neuralset.segments` itself imports only numpy, pandas and its own modules — but the
    **package's** dependency set pulls torch, mne, mne-bids, pyprep, scikit-learn and nibabel.
    Too heavy for CI, fine locally.
- `parcellation.py` is pure and fully tested (`axis_bands`, `clip_summary`).
- `tests/test_parcellation.py` already establishes the technique this design reuses: plant a known
  value into `axis_masks()[i]`, assert it comes back out of `axis_bands`.
- `device` is `z.string().nullish()` in `packages/queue/src/contract.ts:112` and `Optional[str]` in
  `queue_contract.py` — free-form on both sides, so a backend may name itself.
- `infra/docker/docker-compose.yml` already runs a local Redis (`bun run docker:local`).
- `worker.py` does `import requests` **inside** `_download`, so it is monkeypatchable without a
  mocking library.
- `engine.DEVICE` has 4 references in `worker.py` (lines 284, 317, 339, 368) and 1 in `main.py`
  (line 141).
- There is no `.github/workflows` directory in this repo yet.

## Decisions

### Decision 1 — the fake is a backend seam in `engine.py`, not a parallel script

The alternative was a standalone `scripts/fake_worker.py` that consumes the queue and emits
synthetic results, leaving production code untouched. Rejected: it would duplicate
`AnalysisProcessor`'s download, mapping and publish logic, and the two would drift — so local runs
would exercise a copy of `worker.py` rather than `worker.py`. Since the whole point is confidence in
the real path, the stand-in goes behind a seam the real path already crosses.

Selection is by environment variable (`ML_BACKEND`), not a constructor argument, because
`entrypoint.sh`, the Dockerfile and `main.py` would all need threading otherwise for zero gain in a
process that loads exactly one model.

### Decision 2 — `engine.DEVICE` becomes `engine.device()`

This is the keystone. A module-level constant computed at import time calls `_select_device()`, which
does `import torch` — so **importing `engine` at all requires torch**, which is what makes the
current suite un-runnable in CI and slow locally. As a lazy function it buys three things:

1. `pytest` in CI installs six small wheels instead of torch. Verified above.
2. Importing `engine` under `ML_BACKEND=synthetic` never touches torch, so the suite stays seconds.
3. `SyntheticBackend.device == "synthetic"` rides the contract's free-form `device` field into
   `inference_runs.device`. **A fake run labels itself in Postgres.** No synthetic row can be
   mistaken for a real one later, in a query or on a chart — which is what makes it safe to point
   the local worker at a real database.

Five call sites change. `CACHE_DIR`, `VIDEO_SUFFIXES`, `AUDIO_SUFFIXES` and `SUFFIXES_BY_MODALITY`
stay module constants — they are not backend-dependent.

### Decision 3 — the synthetic tensor carries planted structure, not noise

Seeded noise would prove the plumbing carries a well-formed payload and nothing else; no test could
assert anything about meaning, and the mobile timeline would render static. Planting a known signal
into specific networks at a known time window makes one assertion possible that is worth the whole
design:

> a `visual_burst` clip must peak in the **visual** band, inside the window it was planted in.

That single test fails if the atlas mapping breaks, if `axis_timeline`'s column order drifts from
`AXES`, or if `_timeline()` misaligns its five arrays. Three real bugs, caught on a laptop.

### Decision 4 — the segment stand-in is verified against the real types, both ways

`SyntheticBackend` cannot return real `neuralset.Segment` objects in CI — the package pulls torch.
So it returns a small stand-in exposing exactly the surface `engine` consumes: `start`, `duration`,
`stop`, `ns_events`, with events carrying `text` / `start` and a type name of `Word`.

That surface is **not a guess**: it is transcribed from `neuralset/segments.py:180` and
`etypes.py:671`, cited in the code. And it is checked against reality by
`tests/test_neuralset_types.py`, which does `pytest.importorskip("neuralset")`, builds **real**
`Segment`s via `list_segments()` from a real `Word` DataFrame, and asserts `engine.segment_text()`
and `engine.predictions_to_dict()` handle them identically to the stand-in.

Locally, where neuralset is installed, that test **runs on every `pytest`**. In CI it skips. So the
assumption is re-verified on the developer's machine continuously, rather than deferred to a GPU run
that has not happened. This is what replaces the original design's "record a manifest and hope".

### Decision 5 — record a 1 KB manifest, not a 2 MB tensor

The original design paired a `RecordingBackend` with a `ReplayBackend` over a captured `.npz`.
Decision 4 removes most of its reason to exist: the segment surface is now verified continuously,
and `SyntheticBackend` already gives a realistic local run.

What remains worth capturing is the part Decision 4 cannot reach — the **tensor's** dtype and TR
spacing, which only the real model can settle. So `RecordingBackend` survives in minimal form: a
decorator that wraps any backend and writes `tribe-shape.json` (~1 KB: dtype, ndim, `n_vertices`,
inferred TR spacing, segment attributes seen). `ReplayBackend` and the `.npz` are **cut** — building
serialization for a file nobody has yet is speculative.

Because it is a decorator, it is tested on the Mac by recording `SyntheticBackend`. On a GPU box,
`ML_RECORD_DIR=./recordings python worker.py` wraps `TribeBackend` and the artifact is real. One code
path, no GPU-only branch.

### Decision 6 — unit tests use a spy, not a fake Redis

`bullmq` drives Redis through Lua scripts; running them against `fakeredis` would test an emulator's
Lua support, not our code. So `AnalysisProcessor` is driven directly with a fake job object and a
spy results-queue — no Redis at all, which is both faster and a truer test of the logic in question.

Real BullMQ interop is worth proving too, since the polyglot split depends on it, so it gets an
opt-in `@pytest.mark.integration` suite against the docker Redis that already exists. Deselected by
default: bare `pytest` must never need a daemon, in CI or out.

### Decision 7 — `apps/ml` stays a Python island

The root `package.json` grows `test:ml`, and `test` runs `turbo run test && bun run test:ml`. No
`package.json` is added to `apps/ml`, so Bun and Turbo keep ignoring it exactly as they do today,
while one command still covers the monorepo.

### Decision 8 — CI installs `requirements-dev.txt`, never `requirements.txt`

`requirements.txt` pins torch from PyTorch's own index and installs `tribev2` from git alongside
transformers, librosa and PyAV — minutes of install and gigabytes of wheels, for a suite that must
not touch any of it. `requirements-dev.txt` is a separate, deliberately small file, and **the CI job
installing only that file is itself the test** that the suite has not quietly grown a heavy import.

If someone adds `import torch` at module scope in a tested module, CI goes red immediately. That is
the intended behaviour, not an inconvenience.

## Architecture

```text
engine.py                     pure functions + thin delegation (unchanged surface)
  predictions_to_dict()         ← pure, stays
  segment_text()                ← pure, stays
  temp_media_file()             ← pure, stays
  load_model() / run_inference() / is_loaded() / device()
                                └──▶ backends.get_backend()

backends/__init__.py          Backend protocol · get_backend() · ML_BACKEND selector
backends/tribe.py             TribeBackend       ← today's code, moved verbatim (imports torch)
backends/synthetic.py         SyntheticBackend   ← planted [T × 20484] float32, no torch
backends/recording.py         RecordingBackend   ← decorator, writes tribe-shape.json
```

`worker.py` and `main.py` keep their current call sites apart from `DEVICE` → `device()`.

### Stage 1 — the backend protocol

```python
class Backend(Protocol):
    device: str
    def load(self) -> None: ...
    def run(self, modality: str, path: str) -> tuple[np.ndarray, list]: ...
```

`get_backend()` reads `ML_BACKEND` (`tribe` | `synthetic`, default **`tribe`**) and caches one
instance per process. `ML_RECORD_DIR`, when set, wraps whatever was selected in `RecordingBackend`.
**Production behaviour with no environment variables set is byte-identical to today.** `tribe.py` is
the only module that imports torch, and it is imported lazily, inside `get_backend()`.

### Stage 2 — `SyntheticBackend`

Scenarios, selected by `ML_SYNTH_SCENARIO`, seeded by `ML_SYNTH_SEED` (default `0`):

| Scenario       | What it plants                                                                   |
| -------------- | -------------------------------------------------------------------------------- |
| `visual_burst` | visual parcels ramp to ~3σ across the 10–14 s window; transcript empty           |
| `talky`        | language parcels track a canned word list; segments carry fake `Word` events     |
| `flat`         | seeded noise only — the "this clip did nothing" case                             |
| `mixed`        | visual burst early, language mid — **default**, so a rendered timeline has shape |

Segment count comes from the media's real duration (PyAV when importable, else
`ML_SYNTH_DURATION_SEC`, default `30`) divided by `TR_SEC = 1.49`. Values are `float32`. Segments are
the Decision 4 stand-in.

`TR_SEC` and the dtype remain **unverified against the real model** and are marked as such in code,
naming `RecordingBackend` as what will settle them.

### Stage 3 — `RecordingBackend`

```python
def run(self, modality, path):
    preds, segments = self.inner.run(modality, path)
    _write_manifest(self.out_dir, preds, segments)   # ~1 KB
    return preds, segments
```

Enabled with `ML_RECORD_DIR=./recordings python worker.py`. Unset, nothing in the production path
changes.

### Stage 4 — the suite

```text
apps/ml/
  pytest.ini                  asyncio_mode=auto · markers · addopts=-m "not integration and not gpu"
  requirements-dev.txt        pytest · pytest-asyncio · numpy · pydantic · bullmq · requests
  tests/
    conftest.py               + spy_results_queue · fake_job · fake_http · tmp_media
    test_parcellation.py      exists, untouched
    test_contract.py          exists, untouched
    test_backends.py          NEW  get_backend selection · protocol postconditions · device naming
    test_synthetic.py         NEW  a planted signal lands in the band it claims
    test_neuralset_types.py   NEW  importorskip — real Segment/Word vs the stand-in
    test_recording.py         NEW  manifest written; run() returns the inner result unchanged
    test_worker_mapping.py    NEW  _timeline · _transcript · _axis_bands · _stats
    test_worker_processor.py  NEW  started/succeeded/failed · attempt maths · deterministic jobId
    test_download.py          NEW  404 · bad suffix · both size caps · content-type fallback
    integration/
      test_queue_roundtrip.py @pytest.mark.integration — real docker Redis
```

Two markers, both deselected by default:

| Marker        | Needs                | Run with                                        |
| ------------- | -------------------- | ----------------------------------------------- |
| _(none)_      | nothing              | `pytest` — green on a laptop and on a CI runner |
| `integration` | docker Redis         | `bun run docker:local && pytest -m integration` |
| `gpu`         | the real TRIBE model | `pytest -m gpu` on a GPU box                    |

Fixtures in `conftest.py`:

- `spy_results_queue` — records every `.add(name, data, opts)` so tests assert on published payloads.
- `fake_job` — a stand-in exposing `id`, `data`, `opts`, `attemptsStarted`, `attemptsMade`.
- `fake_http` — a ~20-line scripted `requests.get` replacement (status, headers, chunks). No new
  dependency, because `_download` imports `requests` at call time.

The two highest-value targets, because nothing guards them today:

1. **`_download`'s streaming cap** — the case where the server omits or lies about `content-length`
   and only the byte counter stops the write.
2. **`AnalysisProcessor`'s failure path** — that an `UnrecoverableError` publishes `retryable: False`
   on the first attempt while a transient error publishes `True`. That boolean decides whether an
   analysis is marked `FAILED` or left `PROCESSING` forever.

### Stage 5 — CI and the default command

`.github/workflows/test.yml` — one workflow, two jobs, both on `push` and `pull_request`:

```yaml
ml: setup-python 3.11 · pip cache · pip install -r apps/ml/requirements-dev.txt · pytest
node: setup-bun · bun install --frozen-lockfile · turbo run typecheck test
```

The `ml` job deliberately does **not** install `requirements.txt` (Decision 8). The `node` job is
included because `turbo run test` already passes locally and the repo has no CI at all today; if it
proves flaky it can be dropped without touching the `ml` job.

Also:

- Root `package.json`: `"test": "turbo run test && bun run test:ml"`, with `test:ml` resolving
  `apps/ml`'s interpreter and failing with a message naming `apps/ml/README.md` if the venv is
  absent.
- `apps/ml/README.md`: replace the four-line Testing section with the tiers, the markers and
  `ML_BACKEND=synthetic python worker.py` as the documented no-GPU path.
- `CLAUDE.md` Conventions: _"Touching `apps/ml`? Test first. The model sits behind a backend seam, so
  `pytest` runs on a MacBook and in CI; `ML_BACKEND=synthetic` runs the real worker without a GPU."_

## Testing

| Unit               | Test                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `get_backend()`    | default is `tribe`; each `ML_BACKEND` value resolves; unknown value raises; result is cached             |
| `SyntheticBackend` | shape/dtype; determinism under a fixed seed; each scenario's planted signal lands in its band and window |
| `RecordingBackend` | wrapping `SyntheticBackend` writes the manifest; `run()` returns the inner result unchanged              |
| `engine.device()`  | reports `synthetic` under the synthetic backend                                                          |
| segment stand-in   | `test_neuralset_types.py` — real `Segment`/`Word` and the stand-in produce identical `segment_text()`    |

`test_backends.py` holds the postconditions every backend must satisfy (2-D, `n_vertices()` columns,
one segment per row, monotonic `start`), parametrized over backends; the `tribe` parameter carries
`@pytest.mark.gpu`.

**Verification that this design worked** is three things, in order:

1. `pip install -r requirements-dev.txt && pytest` is green from a bare Python 3.11 with no torch.
2. The same command is green on a GitHub Actions runner.
3. `bun run docker:local`, `ML_BACKEND=synthetic python worker.py`, `apps/api` and `apps/worker`
   together take an upload from the mobile app to a rendered result screen, on a MacBook, with
   `inference_runs.device = 'synthetic'` in the row.

## Risks

- **`TR_SEC` and the tensor dtype are still guesses.** Decision 4 fixes the _segment_ surface — the
  part that caused the most doubt — by checking it against the installed real types on every local
  run. The tensor's own properties cannot be settled without the model, and `RecordingBackend`
  exists to capture them the first time one runs. Marked in code, not silently assumed.
- **A green suite reads as more confidence than it is.** Nothing here proves TRIBE produces sensible
  neuroscience for a given clip; it proves our code handles the model's output correctly. The open
  `TODO` — a real clip through the real model — is **not** closed by this work.
- **`engine.DEVICE` → `device()` is a breaking change to a module attribute.** Five call sites in
  this repo, all updated together. `main.py` and `worker.py` are the only known consumers; anything
  outside (a notebook, the Space's glue) would need the same one-line change.
- **The `node` CI job may be flaky before the `ml` job is trusted.** Mitigated by keeping them
  separate jobs, so an ML regression is never masked by a TypeScript one and vice versa.
- **`requirements-dev.txt` can drift from `requirements.txt`.** Both list `numpy`, `pydantic` (via
  transitive deps) and `bullmq`. Versions are pinned in neither for the dev set, on purpose: CI
  resolving the latest compatible wheel is a cheap early warning, and the production image is built
  from `requirements.txt` regardless.

## Open questions

- **Which scenario should `mixed` actually mix?** Proposed as visual-early/language-mid so the mobile
  timeline has visible shape, but the right answer is whatever makes a broken axis mapping most
  obvious on screen. Settle it while writing `test_synthetic.py`.
- **Where does the first real run come from** — the deployed HF Space, or a runpod box? Not needed to
  start this work; it is the input to `tribe-shape.json`, not a blocker for anything else.
