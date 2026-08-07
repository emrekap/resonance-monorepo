"""What the worker writes to stdout at startup.

`REDIS_URL` carries its password inline (`rediss://default:<token>@host:6379` is
what a managed Redis hands you), and the startup banner used to log it verbatim —
so every boot wrote a live credential into wherever logs are shipped. Logs
outlive processes and are rarely as access-controlled as a secret store.
"""

from __future__ import annotations

import worker


class TestRedaction:
    def test_hides_the_password_in_a_managed_redis_url(self):
        url = "rediss://default:SUPERSECRETTOKEN@example.upstash.io:6379"
        redacted = worker._redacted(url)
        assert "SUPERSECRETTOKEN" not in redacted
        assert "example.upstash.io:6379" in redacted

    def test_keeps_the_username_so_the_line_is_still_diagnostic(self):
        redacted = worker._redacted("rediss://default:tok@example.upstash.io:6379")
        assert "default" in redacted

    def test_leaves_a_local_url_alone(self):
        """`redis://127.0.0.1:6379` has nothing to hide, and mangling it would
        make the common case harder to read."""
        assert worker._redacted("redis://127.0.0.1:6379") == "redis://127.0.0.1:6379"

    def test_survives_a_url_it_cannot_parse(self):
        """Never raise from a log line. A banner that crashes the worker would be
        worse than a banner that says nothing useful."""
        assert worker._redacted("not a url at all")
        assert "***" not in worker._redacted("not a url at all")

    def test_hides_a_password_with_no_username(self):
        assert "tok" not in worker._redacted("rediss://:tok@example.io:6379")
