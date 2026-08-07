"""Getting the media onto disk — and refusing to, correctly.

Two failure modes this guards, both of which cost real money when they go wrong:

- An `UnrecoverableError` tells BullMQ to stop retrying. Raising it for a
  transient fault throws away a job; *not* raising it for a permanent one burns
  the full retry budget re-downloading a 404.
- The size cap is checked twice, against the header and against the bytes
  actually arriving, because servers omit and misreport `content-length`. Only
  the second one can stop a server that lies.
"""

from __future__ import annotations

import pytest
from bullmq import UnrecoverableError

import worker

URL = "https://example.test/storage/v1/object/sign/media/clip"


class TestSuccess:
    def test_writes_the_bytes_it_streamed(self, fake_http, tmp_path):
        fake_http(headers={"content-type": "video/mp4"}, chunks=(b"abc", b"def"))
        path = worker._download(URL + ".mp4", tmp_path, "video")
        assert path.read_bytes() == b"abcdef"

    def test_takes_the_suffix_from_the_url(self, fake_http, tmp_path):
        fake_http(headers={"content-type": "application/octet-stream"})
        assert worker._download(URL + ".mov", tmp_path, "video").suffix == ".mov"

    def test_falls_back_to_the_content_type(self, fake_http, tmp_path):
        """A signed Storage URL carries no extension, and tribev2 dispatches on
        one — so the served content type is the only thing left to read."""
        fake_http(headers={"content-type": "video/quicktime; charset=utf-8"})
        assert worker._download(URL, tmp_path, "video").suffix == ".mov"

    def test_accepts_audio_for_the_audio_modality(self, fake_http, tmp_path):
        fake_http(headers={"content-type": "audio/mpeg"})
        assert worker._download(URL, tmp_path, "audio").suffix == ".mp3"


class TestUnrecoverable:
    def test_a_404_is_not_retried(self, fake_http, tmp_path):
        fake_http(status=404)
        with pytest.raises(UnrecoverableError, match="unreachable"):
            worker._download(URL + ".mp4", tmp_path, "video")

    def test_a_403_is_not_retried(self, fake_http, tmp_path):
        """An expired signed URL. Retrying cannot un-expire it."""
        fake_http(status=403)
        with pytest.raises(UnrecoverableError):
            worker._download(URL + ".mp4", tmp_path, "video")

    def test_an_unreadable_type_is_not_retried(self, fake_http, tmp_path):
        fake_http(headers={"content-type": "application/pdf"})
        with pytest.raises(UnrecoverableError, match="unsupported"):
            worker._download(URL, tmp_path, "video")

    def test_a_video_suffix_is_rejected_for_the_audio_modality(
        self, fake_http, tmp_path
    ):
        fake_http(headers={"content-type": "video/mp4"})
        with pytest.raises(UnrecoverableError, match="unsupported"):
            worker._download(URL + ".mp4", tmp_path, "audio")


class TestServerErrors:
    def test_a_500_raises_so_bullmq_backs_off(self, fake_http, tmp_path):
        """Retryable — the opposite of the 4xx cases above."""
        import requests

        fake_http(status=500)
        with pytest.raises(requests.HTTPError):
            worker._download(URL + ".mp4", tmp_path, "video")


class TestSizeCaps:
    def test_rejects_an_oversized_content_length(self, fake_http, tmp_path, monkeypatch):
        monkeypatch.setattr(worker, "MAX_MEDIA_BYTES", 10)
        fake_http(headers={"content-type": "video/mp4", "content-length": "999"})
        with pytest.raises(UnrecoverableError, match="over the"):
            worker._download(URL + ".mp4", tmp_path, "video")

    def test_stops_a_server_that_lies_about_its_length(
        self, fake_http, tmp_path, monkeypatch
    ):
        """The cap that actually protects the disk. `content-length` is a hint;
        the bytes arriving are the fact."""
        monkeypatch.setattr(worker, "MAX_MEDIA_BYTES", 4)
        fake_http(
            headers={"content-type": "video/mp4", "content-length": "2"},
            chunks=(b"ab", b"cd", b"ef"),
        )
        with pytest.raises(UnrecoverableError, match="while downloading"):
            worker._download(URL + ".mp4", tmp_path, "video")

    def test_stops_a_server_that_omits_its_length(
        self, fake_http, tmp_path, monkeypatch
    ):
        monkeypatch.setattr(worker, "MAX_MEDIA_BYTES", 4)
        fake_http(headers={"content-type": "video/mp4"}, chunks=(b"aaaa", b"bbbb"))
        with pytest.raises(UnrecoverableError, match="while downloading"):
            worker._download(URL + ".mp4", tmp_path, "video")

    def test_a_file_at_the_cap_is_allowed(self, fake_http, tmp_path, monkeypatch):
        monkeypatch.setattr(worker, "MAX_MEDIA_BYTES", 4)
        fake_http(headers={"content-type": "video/mp4"}, chunks=(b"abcd",))
        assert worker._download(URL + ".mp4", tmp_path, "video").read_bytes() == b"abcd"
