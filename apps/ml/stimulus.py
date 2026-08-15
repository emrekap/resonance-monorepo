"""What channels does the media file actually contain?

The model predicts activity in every brain network no matter what it watches —
a silent clip still yields an "audio" curve, correctly: a viewer's auditory
cortex exists. These probes answer the different question the result screen
needs: does the *stimulus* carry audio / visuals at all, so the lines for
absent channels can be faded rather than read as content quality.

ffmpeg/ffprobe only (`engine` already demands both on PATH for whisperx) and no
torch, so the module stays importable and testable everywhere. Every failure
degrades to ``None`` ("unknown"), never to an exception: a probe bug must not
fail an analysis whose GPU run already succeeded, and ``None`` renders exactly
like a payload from before the probe existed.
"""

from __future__ import annotations

import logging
import re
import subprocess
from pathlib import Path
from typing import NamedTuple, Optional

logger = logging.getLogger(__name__)

#: A volumedetect mean below this is "a track of digital silence", not audio.
#: Speech in a quiet room sits around -30 to -20 dB; -50 is far under anything
#: a viewer would perceive as sound, while staying above volumedetect's own
#: floor for encoded silence (~-91 dB).
SILENCE_FLOOR_DB = -50.0

#: A clip is "effectively black" only when the average luma stays under
#: BLACK_YAVG_MAX **and** no sampled frame ever brightens past BLACK_YMAX_MAX.
#: The second condition is deliberate: captions on a black screen barely move
#: the average (YAVG ~19 for one small caption) but peak at white (~235), and
#: text is visual stimulus. Limited-range black encodes as Y=16, so both
#: thresholds sit well above it and well below any real content.
BLACK_YAVG_MAX = 24.0
BLACK_YMAX_MAX = 48.0

#: Frames per second signalstats samples. Whole-stream stats on a 60 fps clip
#: would decode ~30x more frames without changing the answer.
_SAMPLE_FPS = 2

_TIMEOUT_SEC = 60

_MEAN_VOLUME = re.compile(r"mean_volume:\s*(-?[\d.]+)\s*dB")
_YAVG = re.compile(r"lavfi\.signalstats\.YAVG=([\d.]+)")
_YMAX = re.compile(r"lavfi\.signalstats\.YMAX=([\d.]+)")


class StimulusProbe(NamedTuple):
    """Each field is independently Optional — the probes run separately, and
    one ffmpeg failure must not discard the other's answer."""

    has_audio: Optional[bool]
    has_visual: Optional[bool]


def probe_stimulus(path: Path | str, modality: str) -> StimulusProbe:
    """Probe the downloaded media once, before the tempdir it lives in is gone."""
    path = Path(path)
    return StimulusProbe(_probe_audio(path), _probe_visual(path, modality))


def _run(argv: list[str]) -> str:
    """Run ffmpeg/ffprobe, returning stdout+stderr combined.

    Combined because the two tools disagree about where findings go:
    volumedetect reports on stderr, ``metadata=print:file=-`` on stdout.
    """
    proc = subprocess.run(argv, capture_output=True, text=True, timeout=_TIMEOUT_SEC)
    if proc.returncode != 0:
        raise RuntimeError(f"{argv[0]} exited {proc.returncode}: {proc.stderr[-500:]}")
    return proc.stdout + proc.stderr


def _has_stream(path: Path, kind: str) -> bool:
    out = _run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            kind,
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
            str(path),
        ]
    )
    return any(line.strip() for line in out.splitlines())


def _probe_audio(path: Path) -> Optional[bool]:
    try:
        if not _has_stream(path, "a"):
            return False
        out = _run(
            [
                "ffmpeg",
                "-hide_banner",
                "-nostdin",
                "-i",
                str(path),
                "-map",
                "0:a:0",
                "-af",
                "volumedetect",
                "-vn",
                "-f",
                "null",
                "-",
            ]
        )
        match = _MEAN_VOLUME.search(out)
        if match is None:
            return None
        return float(match.group(1)) > SILENCE_FLOOR_DB
    except Exception:
        logger.warning(f"audio probe failed for {path}", exc_info=True)
        return None


def _probe_visual(path: Path, modality: str) -> Optional[bool]:
    try:
        if modality != "video":
            # An audio upload has no frames at all — a fact, not a probe result.
            return False
        if not _has_stream(path, "v"):
            return False
        out = _run(
            [
                "ffmpeg",
                "-hide_banner",
                "-nostdin",
                "-i",
                str(path),
                "-map",
                "0:v:0",
                "-vf",
                f"fps={_SAMPLE_FPS},signalstats,metadata=print:file=-",
                "-an",
                "-f",
                "null",
                "-",
            ]
        )
        yavg = [float(value) for value in _YAVG.findall(out)]
        ymax = [float(value) for value in _YMAX.findall(out)]
        if not yavg or not ymax:
            return None
        is_black = sum(yavg) / len(yavg) < BLACK_YAVG_MAX and max(ymax) < BLACK_YMAX_MAX
        return not is_black
    except Exception:
        logger.warning(f"visual probe failed for {path}", exc_info=True)
        return None
