#!/usr/bin/env bash
# Hugging Face Space entrypoint — one container, two processes.
#
# The Space's real job is `worker.py`: the long-lived BullMQ consumer of the
# `analysis` queue, which is the only thing `apps/api` drives. But a Docker
# Space that never answers HTTP on $PORT is never marked healthy by Hugging
# Face, so `main.py` rides along as the health / poke-by-hand face.
#
# Only ONE of them loads TRIBE v2. `engine.MODEL` is a per-process global, so
# two processes means two full copies of the model (TRIBE + the Llama-3.2-3B
# text encoder) on the same card — an OOM on anything short of an A100.
# `ML_HTTP_LOAD_MODEL=0` keeps uvicorn's lifespan from loading a second one:
# `/` and `/health` still answer, and `/analyze/*` returns 503, which is the
# honest response here — inference goes through the queue.
set -uo pipefail

PORT="${PORT:-7860}"

ML_HTTP_LOAD_MODEL=0 uvicorn main:app --host 0.0.0.0 --port "$PORT" &
http_pid=$!

python worker.py &
worker_pid=$!

echo "[entrypoint] uvicorn pid=$http_pid on :$PORT · worker pid=$worker_pid"

# Forward the stop signal so worker.py's own SIGTERM handler runs and drains the
# job it is holding. Without this a restart kills the container mid-inference and
# BullMQ has to wait out ML_WORKER_LOCK_MS (30 min) before anyone retries it.
terminate() {
    kill -TERM "$worker_pid" "$http_pid" 2>/dev/null || true
}
trap terminate TERM INT

# Exit as soon as EITHER process does. A container that still serves /health
# while the worker is dead (bad REDIS_URL, CUDA OOM) looks healthy to the Space
# while the queue silently backs up — better to fall over and be restarted.
#
# `wait -n` would say this in one line but needs bash >= 4.3, and this script
# should still run on a dev's macOS bash 3.2. The sleep is backgrounded and
# waited on rather than run in the foreground because bash defers a trap until
# the current foreground command returns — a plain `sleep 5` would sit on a
# SIGTERM for up to five seconds before draining anything.
status=0
while :; do
    if ! kill -0 "$worker_pid" 2>/dev/null; then
        wait "$worker_pid"; status=$?; break
    fi
    if ! kill -0 "$http_pid" 2>/dev/null; then
        wait "$http_pid"; status=$?; break
    fi
    sleep 5 &
    wait $! 2>/dev/null
done

terminate
wait 2>/dev/null
exit "$status"
