from __future__ import annotations

import sys
import threading
import unittest
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core import embedder as embedder_module


class _FakeModel:
    def __init__(self, exc):
        self.exc = exc

    def get_text_features(self, **kwargs):
        raise self.exc


class _Encoding(dict):
    def to(self, device):
        return self


class _FakeProcessor:
    def __call__(self, **kwargs):
        return _Encoding(input_ids=[1, 2, 3])


class _FakeTorch:
    class inference_mode:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False


class TextEmbeddingGuardTest(unittest.TestCase):
    """A poisoned CUDA context must surface as a fatal, non-retryable error."""

    def _embedder(self, exc):
        obj = object.__new__(embedder_module.CLIPEmbedder)
        obj.model = _FakeModel(exc)
        obj.processor = _FakeProcessor()
        obj.device = "cpu"
        obj._inference_lock = threading.Lock()
        obj._ensure_model = lambda: None
        obj._output_vector = lambda outputs: np.zeros(512, dtype=np.float32)
        return obj

    def test_cuda_assert_raises_dedicated_error(self):
        obj = self._embedder(RuntimeError("CUDA error: device-side assert triggered"))
        with self.assertRaises(embedder_module.EmbedderCudaError):
            obj.text_to_embedding("铃声")

    def test_ordinary_error_stays_runtime_error(self):
        obj = self._embedder(RuntimeError("shape mismatch"))
        with self.assertRaises(RuntimeError) as ctx:
            obj.text_to_embedding("铃声")
        self.assertNotIsInstance(ctx.exception, embedder_module.EmbedderCudaError)

    def test_long_text_is_truncated(self):
        captured = {}

        class _Capture(_FakeProcessor):
            def __call__(self, **kwargs):
                captured.update(kwargs)
                return _Encoding(input_ids=[1, 2, 3])

        obj = self._embedder(None)
        obj.processor = _Capture()
        obj.model = type("M", (), {"get_text_features": lambda self, **k: None})()
        obj._output_vector = lambda outputs: np.zeros(512, dtype=np.float32)
        obj.text_to_embedding("字" * 500)
        self.assertLessEqual(len(captured["text"][0]), embedder_module.TEXT_MAX_CHARS)


if __name__ == "__main__":
    unittest.main()