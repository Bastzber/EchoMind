from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core import audio_service as audio_service_module


class _FakeContainer:
    streams: list = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class PyavMetadataEncodingTest(unittest.TestCase):
    """Files whose container metadata is GBK-encoded must still decode.

    Regression: pyav decodes metadata tags as UTF-8 and raises UnicodeDecodeError
    on GBK tags, so thousands of perfectly playable files were reported as
    "decode failed" and blacklisted as poison.
    """

    def test_open_passes_metadata_errors_ignore(self):
        calls = []

        def fake_open(*args, **kwargs):
            calls.append(kwargs)
            return _FakeContainer()

        with mock.patch.object(audio_service_module._av, "open", fake_open):
            with self.assertRaises(Exception):
                audio_service_module.AudioService._decode_with_pyav(
                    Path("dummy.wav"), 48000, True
                )

        self.assertTrue(calls, "av.open must be called")
        self.assertEqual(
            calls[0].get("metadata_errors"),
            "ignore",
            "pyav must ignore non-UTF-8 metadata instead of failing the whole file",
        )


if __name__ == "__main__":
    unittest.main()
