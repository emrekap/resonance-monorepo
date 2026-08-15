"""The ffmpeg stimulus probe — which channels does the media file contain?

The model predicts activity in every brain network no matter what it watches,
so a silent clip still yields an "audio" curve. `stimulus.py` answers the
different question the result screen needs: does the *stimulus* carry audio /
visuals at all, so the lines for absent channels can be faded rather than read
as content quality.

Every clip here is synthesised by ffmpeg itself — no fixtures are committed,
and the whole module is skipped where ffmpeg is absent (CI installs only
`requirements-dev.txt`; the probe is exercised on machines that can run the
worker at all, which is the population that matters).
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from stimulus import StimulusProbe, probe_stimulus

pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg/ffprobe not on PATH",
)

_VIDEO_CODEC = ["-c:v", "libx264", "-pix_fmt", "yuv420p"]
_AUDIO_CODEC = ["-c:a", "aac"]

_TONE = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=1"]
_SILENCE = ["-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=16000"]
_BLUE = ["-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1:r=8"]
_BLACK = ["-f", "lavfi", "-i", "color=c=black:s=64x64:d=1:r=8"]
# A small bright box on black — the caption-on-black shape: the average luma
# stays "black" but the peak does not.
_CAPTIONED = [
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=64x64:d=1:r=8,drawbox=x=28:y=28:w=8:h=8:color=white:t=fill",
]


def _synth(directory: Path, name: str, *args: str) -> Path:
    out = directory / name
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args, str(out)],
        check=True,
        timeout=120,
    )
    return out


@pytest.fixture(scope="module")
def clips(tmp_path_factory) -> dict[str, Path]:
    d = tmp_path_factory.mktemp("stimulus-clips")
    return {
        "voiced": _synth(
            d, "voiced.mp4", *_BLUE, *_TONE, *_VIDEO_CODEC, *_AUDIO_CODEC, "-shortest"
        ),
        "silent_track": _synth(
            d, "silent-track.mp4", *_BLUE, *_SILENCE, *_VIDEO_CODEC, *_AUDIO_CODEC, "-t", "1"
        ),
        "no_audio_stream": _synth(d, "no-audio.mp4", *_BLUE, *_VIDEO_CODEC),
        "black": _synth(
            d, "black.mp4", *_BLACK, *_TONE, *_VIDEO_CODEC, *_AUDIO_CODEC, "-shortest"
        ),
        "captioned_black": _synth(
            d, "captioned.mp4", *_CAPTIONED, *_TONE, *_VIDEO_CODEC, *_AUDIO_CODEC, "-shortest"
        ),
        "audio_only": _synth(d, "tone.wav", *_TONE),
    }


class TestAudio:
    def test_a_real_tone_counts_as_audio(self, clips):
        assert probe_stimulus(clips["voiced"], "video").has_audio is True

    def test_a_track_of_digital_silence_does_not(self, clips):
        """The 'exported with a muted track' case — a stream exists, nothing is on it."""
        assert probe_stimulus(clips["silent_track"], "video").has_audio is False

    def test_a_missing_audio_stream_does_not(self, clips):
        assert probe_stimulus(clips["no_audio_stream"], "video").has_audio is False

    def test_an_audio_upload_with_a_tone_counts(self, clips):
        assert probe_stimulus(clips["audio_only"], "audio").has_audio is True


class TestVisual:
    def test_a_colour_clip_counts_as_visual(self, clips):
        assert probe_stimulus(clips["voiced"], "video").has_visual is True

    def test_a_black_screen_does_not(self, clips):
        assert probe_stimulus(clips["black"], "video").has_visual is False

    def test_bright_content_on_black_keeps_visual_live(self, clips):
        """Captions/text on a black screen are visual stimulus — the peak-luma
        condition is what makes this pass while a truly black clip fails."""
        assert probe_stimulus(clips["captioned_black"], "video").has_visual is True

    def test_an_audio_upload_has_no_visual(self, clips):
        assert probe_stimulus(clips["audio_only"], "audio").has_visual is False


class TestFailure:
    """A probe bug must never fail an analysis whose GPU run already succeeded."""

    def test_a_file_ffmpeg_cannot_read_probes_to_unknown(self, tmp_path):
        junk = tmp_path / "junk.mp4"
        junk.write_bytes(b"x")
        assert probe_stimulus(junk, "video") == StimulusProbe(None, None)

    def test_a_missing_file_probes_to_unknown(self, tmp_path):
        assert probe_stimulus(tmp_path / "gone.mp4", "video") == StimulusProbe(None, None)
