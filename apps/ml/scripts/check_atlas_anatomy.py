"""The empirical half of the atlas check: does TRIBE's vertex order match the atlas?

`atlas/axis_map.py` assumes `MODEL.predict`'s 20484 columns are fsaverage5
vertices, left hemisphere then right, in FreeSurfer vertex order. The structural
evidence says they are (the checkpoint's own config projects training targets
with `TribeSurfaceProjector(mesh=fsaverage5)`, which stacks left-then-right; the
committed atlas is byte-identical to the canonical CBIG annot in the same
order). But a permuted surface still averages to plausible numbers on all five
axes, so the failure mode is silent — hence this check, which asks the brain
model a question with a known anatomical answer:

    A flickering high-contrast checkerboard with no speech should light the
    visual axis and the Vis* networks, and leave language near the floor.
    Spoken words over a black screen should do the opposite.

If the vertex order were scrambled, every mask would average the same mixture
and the contrast would vanish — exactly what happens to the geometry table in
the permutation control of the atlas-side check (TODO #1's history in
docs/resonance-model-design.md §2e).

Usage — needs a RUNNING inference endpoint; this script never imports torch:

    python scripts/check_atlas_anatomy.py                          # local uvicorn
    python scripts/check_atlas_anatomy.py --base-url https://emrekap-tribev2-api.hf.space
    python scripts/check_atlas_anatomy.py --from-saved out/anatomy-check  # re-verdict

The clips are synthesized with ffmpeg (and macOS `say` for the speech clip —
skipped, with a warning, where `say` does not exist). Nothing is downloaded;
no third-party media, so the check is deterministic and rights-free.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from atlas.axis_map import AXES, load_atlas  # noqa: E402

#: Comfortably over the pipeline's 30 s minimum batch duration.
CLIP_SECONDS = 48

#: The Schaefer 17 networks, for the per-network table. Matching follows
#: axis_map's rule: a prefix matches when followed by `_` or the end.
NETWORKS = (
    "VisCent", "VisPeri", "SomMotA", "SomMotB", "DorsAttnA", "DorsAttnB",
    "SalVentAttnA", "SalVentAttnB", "LimbicA", "LimbicB", "ContA", "ContB",
    "ContC", "DefaultA", "DefaultB", "DefaultC", "TempPar",
)

SPEECH_TEXT = (
    "The library opens at nine in the morning. She placed the letter on the "
    "wooden table and read every word aloud. Tomorrow we will walk to the "
    "harbour and count the boats as they arrive. Language lives in sentences, "
    "and sentences carry meaning across silence."
)


def _run(cmd: list[str]) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(f"{cmd[0]} failed:\n{result.stderr[-2000:]}")


def make_motion_clip(path: Path) -> None:
    """Flickering, drifting high-contrast checkerboard; digitally silent audio.

    An 8 Hz pattern-reversal checkerboard is the classic V1 localizer; the
    drift adds motion energy for the dorsal stream. The audio track exists and
    is silent on purpose: whisperx should find nothing, so any language-axis
    response to this clip is noise, not signal.
    """
    checker = (
        "geq=lum='if(mod(floor((X+T*40)/40)+floor(Y/40)+floor(T*8),2),235,16)'"
        ":cb=128:cr=128"
    )
    _run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", f"nullsrc=size=640x480:rate=30:duration={CLIP_SECONDS}",
        "-f", "lavfi", "-i", f"anullsrc=r=44100:cl=stereo:d={CLIP_SECONDS}",
        "-vf", checker, "-pix_fmt", "yuv420p",
        "-c:v", "libx264", "-c:a", "aac", "-shortest", str(path),
    ])


def make_speech_clip(path: Path, tmp_dir: Path) -> bool:
    """Synthesized speech over a black screen. Returns False where `say` is absent."""
    if shutil.which("say") is None:
        return False
    aiff = tmp_dir / "speech.aiff"
    _run(["say", "-o", str(aiff), SPEECH_TEXT * 3])
    _run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", f"color=c=black:size=640x480:rate=30:duration={CLIP_SECONDS}",
        "-i", str(aiff),
        "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac",
        "-t", str(CLIP_SECONDS), str(path),
    ])
    return True


def _auth_headers() -> dict[str, str]:
    token = (
        os.getenv("HF_TOKEN")
        or os.getenv("HUGGING_FACE_HUB_TOKEN")
        or os.getenv("HUGGINGFACE_TOKEN")
    )
    return {"Authorization": f"Bearer {token}"} if token else {}


def analyze(base_url: str, clip: Path) -> dict:
    import requests

    with clip.open("rb") as handle:
        response = requests.post(
            f"{base_url}/analyze/video",
            files={"file": (clip.name, handle, "video/mp4")},
            headers=_auth_headers(),
            timeout=3600,
        )
    response.raise_for_status()
    return response.json()


def network_table(per_vertex: np.ndarray) -> list[tuple[str, float, int]]:
    """Mean predicted activation per 17-network, descending."""
    labels, names = load_atlas()
    rows = []
    for network in NETWORKS:
        parcel_ids = [
            parcel_id
            for parcel_id, name in enumerate(names)
            if parcel_id > 0
            and (local := name.removeprefix("17Networks_LH_").removeprefix("17Networks_RH_"))
            and (local == network or local.startswith(f"{network}_"))
        ]
        mask = np.isin(labels, parcel_ids)
        rows.append((network, float(per_vertex[mask].mean()), int(mask.sum())))
    return sorted(rows, key=lambda row: -row[1])


def separation(networks: list[tuple[str, float, int]], coalition: tuple[str, ...]) -> float:
    """How far the stimulus-appropriate networks stand off the remaining ones.

    (coalition mean − others mean) / others std. This is the criterion with
    power: under a scrambled vertex order every mask averages the same mixture,
    the 17-network table flattens, and this ratio collapses toward zero — while
    rank criteria ("X is in the top 3") can still pass by luck on a flat table.
    """
    inside = [mean for name, mean, _ in networks if name in coalition]
    outside = [mean for name, mean, _ in networks if name not in coalition]
    spread = float(np.std(outside))
    if spread == 0.0:
        return 0.0
    return float((np.mean(inside) - np.mean(outside)) / spread)


#: The networks a stimulus should recruit. Motion: the visual axis's own
#: composition (axis_map). Speech: auditory cortex sits inside SomMotB at the
#: 17-network level, plus the two language-axis networks.
COALITIONS = {
    "motion": ("VisCent", "VisPeri", "DorsAttnA", "DorsAttnB"),
    "speech": ("SomMotB", "TempPar", "DefaultB"),
}

#: Speech recruits cortex far more broadly than a checkerboard does (attention,
#: semantics, auditory), so its dissociation is real but softer.
SEPARATION_FLOOR = {"motion": 3.0, "speech": 1.5}


def verdict(result: dict, kind: str) -> list[tuple[str, bool]]:
    """The claims, spelled out — a pass is a statement, not an impression."""
    axis_means = result["axis_means"]
    peak = {axis: axis_means[axis]["peak"] for axis in AXES}
    per_vertex = np.asarray(result["mean_activation_per_vertex"], dtype=np.float64)
    networks = network_table(per_vertex)
    stand_off = separation(networks, COALITIONS[kind])
    floor = SEPARATION_FLOOR[kind]

    if kind == "motion":
        return [
            ("visual has the highest peak of all five axes",
             peak["visual"] == max(peak.values())),
            (f"visual-coalition networks stand {stand_off:.1f} sigma off the rest (need >{floor})",
             stand_off > floor),
            ("language peak is below visual peak",
             peak["language"] < peak["visual"]),
        ]
    return [
        ("audio peak beats visual peak (speech, black screen)",
         peak["audio"] > peak["visual"]),
        (f"speech-coalition networks stand {stand_off:.1f} sigma off the rest (need >{floor})",
         stand_off > floor),
        ("visual is not the top network",
         not networks[0][0].startswith("Vis")),
    ]


def verdict_bands_only(axis_means: dict, kind: str) -> list[tuple[str, bool]]:
    """The verdict when only the queue payload exists (no per-vertex vector).

    The deployed worker serves inference exclusively through the queue, and
    `AnalysisSucceeded` carries `axisBands` but not per-vertex means — so this
    fallback contrasts the five bands directly. Under a scrambled vertex order
    every band averages the same mixture and the contrast collapses, same cliff
    as the network table, just without its anatomical localization.
    """
    peak = {axis: axis_means[axis]["peak"] for axis in AXES}
    mean = {axis: axis_means[axis]["mean"] for axis in AXES}

    def stand_off(target: str) -> float:
        others = [mean[a] for a in AXES if a != target]
        spread = float(np.std(others))
        return float((mean[target] - np.mean(others)) / spread) if spread else 0.0

    if kind == "motion":
        contrast = stand_off("visual")
        return [
            ("visual has the highest peak of all five axes",
             peak["visual"] == max(peak.values())),
            (f"visual band stands {contrast:.1f} sigma off the other four (need >3)",
             contrast > 3.0),
            ("language peak is below visual peak",
             peak["language"] < peak["visual"]),
        ]
    contrast = stand_off("audio")
    return [
        ("audio peak beats visual peak (speech, black screen)",
         peak["audio"] > peak["visual"]),
        (f"audio band stands {contrast:.1f} sigma off the other four (need >1.5)",
         contrast > 1.5),
        ("visual does not have the highest mean of the five bands",
         mean["visual"] != max(mean.values())),
    ]


def report_queue(name: str, payload: dict, kind: str, gate: bool = True) -> bool:
    """Verdict over an `analysis.succeeded` queue payload (axisBands only).

    `gate=False` prints the band table without the within-clip claims — used
    when the verdict comes from the cross-stimulus contrast instead, because
    within-clip signs are not meaningful for out-of-distribution stimuli.
    """
    bands = payload["axisBands"]
    n_segments = len(payload.get("timeline", {}).get("startSec", []))
    print(f"\n=== {name} ({n_segments} segments, via the queue — bands only)")
    print(f"  {'axis':<13} {'mean':>8} {'std':>8} {'peak':>8}")
    for axis in AXES:
        stats = bands[axis]
        print(f"  {axis:<13} {stats['mean']:>8.4f} {stats['std']:>8.4f} {stats['peak']:>8.4f}")
    if not gate:
        return True
    ok = True
    for claim, passed in verdict_bands_only(bands, kind):
        print(f"  {'PASS' if passed else 'FAIL'}  {claim}")
        ok &= passed
    return ok


def report_contrast(payloads: dict[str, dict]) -> bool:
    """The scramble-proof verdict: axis x stimulus double dissociation.

    Within-clip signs turned out to be the wrong question — TRIBE is a
    movie-trained encoder, and a synthetic checkerboard sits so far out of
    distribution that it reads as "less than baseline" everywhere (the first
    run of this check measured exactly that). What a permuted vertex order
    CANNOT fake is different axes preferring different stimuli in the
    anatomically-predicted directions: under a scramble every mask averages
    the same mixture, so all five bands must move together across clips.

    Needs `natural` (visual-rich, silent) and `speech` (black screen, spoken
    words); `motion` (the checkerboard) is reported as context where present.
    """
    means = {
        kind: {axis: payload["axisBands"][axis]["mean"] for axis in AXES}
        for kind, payload in payloads.items()
    }
    # Center each clip's bands on their own mean. An in-distribution clip lifts
    # EVERY band relative to an out-of-distribution one (the first run measured
    # a ~+0.11 global shift from checkerboard to movie footage), and that global
    # tide says nothing about vertex order. Centering removes it; what survives
    # is which cortex a clip recruited MORE than the rest — the axis-specific
    # signal a permuted order cannot produce, because permuted masks all average
    # the same mixture and center to ~0.
    centered = {
        kind: {axis: value - float(np.mean(list(clip.values()))) for axis, value in clip.items()}
        for kind, clip in ((kind, means[kind]) for kind in means)
    }
    print("\n=== cross-stimulus contrast (band means, centered per clip)")
    print(f"  {'axis':<13} " + " ".join(f"{kind:>9}" for kind in centered))
    for axis in AXES:
        print(f"  {axis:<13} " + " ".join(f"{centered[kind][axis]:>9.4f}" for kind in centered))

    if "natural" not in centered or "speech" not in centered:
        print("  (need both natural and speech payloads for the dissociation)")
        return False

    natural, speech = centered["natural"], centered["speech"]
    checks = [
        ("visual is the top band on the visual-rich clip",
         natural["visual"] == max(natural.values())),
        ("audio is the top band on the clip with sound",
         speech["audio"] == max(speech.values())),
        ("audio DROPS below average on the silenced clip (double dissociation)",
         natural["audio"] < 0),
        ("both dissociations clear the scramble noise floor (>0.05)",
         (natural["visual"] - speech["visual"]) > 0.05
         and (speech["audio"] - natural["audio"]) > 0.05),
    ]
    ok = True
    for claim, passed in checks:
        print(f"  {'PASS' if passed else 'FAIL'}  {claim}")
        ok &= passed

    # Reported, not gated: TempPar/DefaultB is the SEMANTIC system, and semantic
    # cortex is modality-invariant — a silent movie with a story drives it as
    # hard as spoken sentences do (which is also why apps/worker only downgrades
    # CLARITY on an empty transcript rather than expecting language to track
    # audio). A criterion that expects `language` to prefer speech over
    # narrative is wrong about the mask, not the ordering; speech-perception
    # cortex is the `audio` axis, gated above.
    gap = speech["language"] - natural["language"]
    print(f"  INFO  language(speech) - language(natural) = {gap:+.4f} "
          "(semantic cortex is modality-invariant; not a gate)")
    return ok


def report(name: str, result: dict, kind: str) -> bool:
    axis_means = result["axis_means"]
    per_vertex = np.asarray(result["mean_activation_per_vertex"], dtype=np.float64)

    print(f"\n=== {name} ({result['n_timesteps']} segments x {result['n_vertices']} vertices)")
    print(f"  {'axis':<13} {'mean':>8} {'std':>8} {'peak':>8}")
    for axis in AXES:
        stats = axis_means[axis]
        print(f"  {axis:<13} {stats['mean']:>8.4f} {stats['std']:>8.4f} {stats['peak']:>8.4f}")

    print("  top / bottom 17-networks by mean activation:")
    rows = network_table(per_vertex)
    for network, mean, n in rows[:4]:
        print(f"    {network:<14} {mean:>8.4f}  ({n} vertices)")
    print("    ...")
    for network, mean, n in rows[-2:]:
        print(f"    {network:<14} {mean:>8.4f}  ({n} vertices)")

    ok = True
    for claim, passed in verdict(result, kind):
        print(f"  {'PASS' if passed else 'FAIL'}  {claim}")
        ok &= passed
    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--base-url", default="http://localhost:8040")
    parser.add_argument("--out", type=Path, default=Path("out/anatomy-check"))
    parser.add_argument(
        "--from-saved", type=Path, default=None,
        help="re-run the verdict from a previous run's saved JSON, no endpoint needed",
    )
    parser.add_argument(
        "--from-queue", type=Path, default=None,
        help="verdict over saved `analysis.succeeded` queue payloads "
        "(<dir>/{motion,speech}-queue.json) — the deployed worker's only output shape",
    )
    args = parser.parse_args()

    if args.from_queue:
        payloads = {
            kind: json.loads(saved.read_text())
            for kind in ("motion", "speech", "natural")
            if (saved := args.from_queue / f"{kind}-queue.json").exists()
        }
        if not payloads:
            print(f"no *-queue.json found in {args.from_queue}")
            return 2
        # Per-clip tables for the record; the verdict is the contrast.
        for kind, payload in payloads.items():
            report_queue(f"{kind} (queue)", payload, kind, gate=False)
        ok = report_contrast(payloads)
        print(f"\n{'ANATOMY CHECK PASSED' if ok else 'ANATOMY CHECK FAILED'} (cross-stimulus)")
        return 0 if ok else 1

    if args.from_saved:
        ok = True
        for kind in ("motion", "speech"):
            saved = args.from_saved / f"{kind}.json"
            if saved.exists():
                ok &= report(f"{kind} (saved)", json.loads(saved.read_text()), kind)
        return 0 if ok else 1

    args.out.mkdir(parents=True, exist_ok=True)
    motion = args.out / "motion.mp4"
    speech = args.out / "speech.mp4"

    print("synthesizing clips …")
    make_motion_clip(motion)
    has_speech = make_speech_clip(speech, args.out)
    if not has_speech:
        print("  [warn] `say` not found — skipping the speech control clip")

    ok = True
    for kind, clip in (("motion", motion), ("speech", speech)):
        if kind == "speech" and not has_speech:
            continue
        print(f"\nanalyzing {clip.name} against {args.base_url} … (GPU inference, be patient)")
        result = analyze(args.base_url, clip)
        (args.out / f"{kind}.json").write_text(json.dumps(result))
        ok &= report(kind, result, kind)

    print(f"\n{'ANATOMY CHECK PASSED' if ok else 'ANATOMY CHECK FAILED'} — see {args.out}/")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
