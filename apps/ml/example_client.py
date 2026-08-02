"""
TRIBE v2 API – example client
Demonstrates how to call the /analyze/video endpoint from Python.

Usage:
    python example_client.py path/to/video.mp4
"""

import os
import sys
import json
import argparse
import requests

BASE_URL = "http://localhost:8000"


def _auth_headers() -> dict:
    """Bearer header for a private HuggingFace Space (ignored by a local server).

    Reads the same token aliases as main.py; set HF_TOKEN in .env or the env.
    """
    try:
        from dotenv import load_dotenv
        load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
    except ImportError:
        pass
    token = (os.getenv("HF_TOKEN") or os.getenv("HUGGING_FACE_HUB_TOKEN")
             or os.getenv("HUGGINGFACE_TOKEN"))
    return {"Authorization": f"Bearer {token}"} if token else {}


HEADERS = _auth_headers()


def check_health(base_url: str) -> None:
    resp = requests.get(f"{base_url}/health", headers=HEADERS, timeout=10)
    resp.raise_for_status()
    print("Health:", json.dumps(resp.json(), indent=2))


def analyze_video(base_url: str, video_path: str, full: bool = False) -> dict:
    """Send a video file to the API and return the prediction dict."""
    url = f"{base_url}/analyze/video"
    if full:
        url += "?include_full_predictions=true"

    print(f"\nSending '{video_path}' to {url} …")
    with open(video_path, "rb") as fh:
        resp = requests.post(
            url,
            files={"file": (video_path, fh, "video/mp4")},
            headers=HEADERS,
            timeout=300,   # inference can take a while on CPU
        )

    if not resp.ok:
        print(f"Error {resp.status_code}: {resp.text}")
        resp.raise_for_status()

    data = resp.json()
    return data


def pretty_print_result(data: dict) -> None:
    print("\n── TRIBE v2 Prediction Summary ─────────────────────────────────────")
    print(f"  File       : {data.get('filename')}")
    print(f"  Shape      : {data.get('shape')}  (timesteps × vertices)")
    print(f"  Timesteps  : {data.get('n_timesteps')}  (at 2 Hz)")
    print(
        f"  Vertices   : {data.get('n_vertices')}  (fsaverage5 cortical mesh)")

    stats = data.get("stats", {})
    print("\n── Global statistics ───────────────────────────────────────────────")
    for k, v in stats.items():
        print(f"  {k:<20}: {v:.6f}")

    segments = data.get("segments", [])
    if segments:
        print(
            f"\n── Segments ({len(segments)}) ─────────────────────────────────────────")
        for seg in segments[:10]:
            dur = seg.get("duration", seg.get("stop", 0.0) - seg.get("start", 0.0))
            print(
                f"  [{seg.get('start', 0.0):.2f}s – {seg.get('stop', 0.0):.2f}s]  "
                f"{dur:.2f}s, {seg.get('n_events', '?')} events")
        if len(segments) > 10:
            print(f"  … and {len(segments) - 10} more")

    per_t = data.get("mean_activation_per_timestep", [])
    if per_t:
        print(f"\n── Mean activation (first 10 timesteps) ────────────────────────────")
        for i, v in enumerate(per_t[:10]):
            print(f"  t={i:>3}  {v:.6f}")
    print()


def main():
    parser = argparse.ArgumentParser(description="TRIBE v2 API example client")
    parser.add_argument("video", help="Path to a video file")
    parser.add_argument("--url", default=BASE_URL, help="API base URL")
    parser.add_argument("--full", action="store_true",
                        help="Include full prediction tensor")
    args = parser.parse_args()

    check_health(args.url)
    result = analyze_video(args.url, args.video, full=args.full)
    pretty_print_result(result)

    if args.full:
        out = args.video.replace("/", "_") + "_predictions.json"
        with open(out, "w") as fh:
            json.dump(result, fh)
        print(f"Full predictions saved to {out}")


if __name__ == "__main__":
    main()
