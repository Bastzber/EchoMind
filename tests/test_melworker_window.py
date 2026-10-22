from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core import melworker


class DecodeTimeoutTest(unittest.TestCase):
    def test_decode_timeout_is_short_enough(self):
        self.assertLessEqual(
            melworker.DECODE_TIMEOUT, 10.0,
            "per-file decode timeout must stay below the batch timeout",
        )


class ResolveWindowTest(unittest.TestCase):
    """A zero-window warm-up request must not poison the worker session.

    Regression: the worker cached sample_rate/max_samples from the first request.
    _warm_mel_worker sends max_samples=0, so every later file took an empty window
    and returned None - "every file is a poison file", with no error at all.
    """

    def test_zero_window_warmup_does_not_override_real_values(self):
        rate, window = melworker._resolve_window(
            {"sample_rate": 48000, "max_samples": 0}, 48000, 480000
        )
        self.assertEqual(rate, 48000)
        self.assertEqual(window, 480000, "zero window from warm-up must be ignored")

    def test_real_request_overrides_previous_values(self):
        rate, window = melworker._resolve_window(
            {"sample_rate": 44100, "max_samples": 220500}, 48000, 480000
        )
        self.assertEqual((rate, window), (44100, 220500))


if __name__ == "__main__":
    unittest.main()
