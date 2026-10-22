from __future__ import annotations

import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core import embedder as embedder_module


class _FakeWorker:
    def __init__(self, pid: int):
        self.pid = pid
        self.killed = False
        self.stdin = mock.Mock()
        self.stdout = mock.Mock()
        self.stderr = mock.Mock()

    def kill(self):
        self.killed = True

    def wait(self, timeout=None):
        return 0

    def poll(self):
        return 0


class GetMelWorkerTest(unittest.TestCase):
    """_get_mel_worker must never block forever when warm-up fails.

    Regression: _get_mel_worker held _mel_worker_lock and then called
    _reset_mel_worker, which acquires the same non-reentrant lock. One failed
    warm-up (cold start slower than the warm timeout) deadlocked the rebuild
    silently and forever, with no log line and no progress.
    """

    def _run_get_worker(self, timeout=5.0):
        created: list[_FakeWorker] = []

        def fake_spawn():
            worker = _FakeWorker(1000 + len(created))
            created.append(worker)
            return worker

        # Use a fresh lock of the *production* type: a plain Lock reproduces the
        # deadlock, an RLock does not. Patching by type keeps the test honest and
        # still isolates the module from a thread that hangs on failure.
        fresh_lock = type(embedder_module._mel_worker_lock)()
        with mock.patch.object(embedder_module, "_mel_worker", None), \
                mock.patch.object(embedder_module, "_mel_worker_lock", fresh_lock), \
                mock.patch.object(embedder_module, "_spawn_mel_worker", fake_spawn), \
                mock.patch.object(
                    embedder_module, "_warm_mel_worker",
                    lambda worker, timeout=60.0: False,
                ), \
                mock.patch("subprocess.run", lambda *a, **k: None):
            done = threading.Event()
            box: dict = {}

            def run():
                try:
                    box["worker"] = embedder_module._get_mel_worker()
                except BaseException as exc:  # noqa: BLE001 - surfaced by assertion
                    box["error"] = exc
                finally:
                    done.set()

            thread = threading.Thread(target=run, daemon=True)
            thread.start()
            finished = done.wait(timeout)
        return finished, box, created

    def test_returns_after_warmup_failure_instead_of_hanging(self):
        finished, box, created = self._run_get_worker()

        self.assertTrue(
            finished,
            "_get_mel_worker deadlocked after a failed warm-up "
            "(non-reentrant _mel_worker_lock re-acquired by _reset_mel_worker)",
        )
        self.assertNotIn("error", box, f"_get_mel_worker raised: {box.get('error')!r}")
        self.assertEqual(len(created), 2, "warm-up failure should be retried exactly twice")


class PoisonRetryBudgetTest(unittest.TestCase):
    """A file that already failed the batch must not cost minutes on retry.

    Regression: every retry used RETRY_TIMEOUT=200s, twice per round trip, so one
    poison file burned ~7 minutes. With thousands of unknown poison files in the
    queue the rebuild could not finish in any useful time.
    """

    def test_retry_budget_is_short(self):
        self.assertTrue(
            hasattr(embedder_module, "MEL_RETRY_TIMEOUT"),
            "the per-file retry budget must be a named module constant",
        )
        self.assertLessEqual(
            embedder_module.MEL_RETRY_TIMEOUT,
            60.0,
            "a per-file poison retry must stay under a minute",
        )


class TwoPassTest(unittest.TestCase):
    """Pass 1 must encode healthy files without bisecting; poison goes to pass 2."""

    def test_first_pass_never_bisects(self):
        paths = ["f%02d.wav" % i for i in range(64)]
        poison = "f07.wav"
        sizes = []

        def fake_round_trip(chunk, sample_rate, max_samples, timeout):
            sizes.append(len(chunk))
            if poison in chunk:
                return {}
            return {p: [0.0] for p in chunk}

        bad = []
        process = getattr(embedder_module, "_process_chunks", None)
        self.assertIsNotNone(process, "embedder must expose _process_chunks")

        with mock.patch.object(embedder_module, "_mel_round_trip", fake_round_trip), \
                mock.patch.object(embedder_module, "_note_bad_file", bad.append), \
                mock.patch.object(embedder_module, "_reset_mel_worker", lambda: None):
            sink = {}
            process(paths, 48000, 0, sink)

        chunk = embedder_module.MEL_CHUNK_SIZE
        expected_batches = 64 // chunk
        self.assertEqual(
            sizes[:expected_batches], [chunk] * expected_batches,
            "pass 1 must run pure chunk batches without interleaved bisection",
        )
        self.assertEqual(len(sink), 63)
        self.assertEqual(bad, [poison])


class SkipPoisonPassTest(unittest.TestCase):
    """ECHOMIND_SKIP_POISON_PASS=1 must finish pass 1 and defer poison."""

    def test_skip_flag_avoids_bisection(self):
        paths = ["a.wav", "b.wav", "c.wav"]
        calls = []

        def fake_round_trip(chunk, sample_rate, max_samples, timeout):
            calls.append(list(chunk))
            return {"a.wav": [0.0]} if "a.wav" in chunk else {}

        with mock.patch.dict("os.environ", {"ECHOMIND_SKIP_POISON_PASS": "1"}), \
                mock.patch.object(embedder_module, "_mel_round_trip", fake_round_trip), \
                mock.patch.object(embedder_module, "_note_bad_file", lambda p: None), \
                mock.patch.object(embedder_module, "_collect_vectors",
                                  lambda *a, **k: self.fail("bisection must be skipped")):
            sink = {}
            embedder_module._process_chunks(paths, 48000, 0, sink, chunk_size=3)

        self.assertEqual(list(sink), ["a.wav"])
        self.assertEqual(len(calls), 1, "only pass 1 should run")


class ChunkContentionTest(unittest.TestCase):
    """A poison file must not hold a huge chunk hostage on every timeout."""

    def test_chunk_and_batch_timeout_are_small(self):
        self.assertTrue(hasattr(embedder_module, "MEL_CHUNK_SIZE"))
        self.assertTrue(hasattr(embedder_module, "MEL_BATCH_TIMEOUT"))
        self.assertLessEqual(embedder_module.MEL_CHUNK_SIZE, 32)
        self.assertLessEqual(embedder_module.MEL_BATCH_TIMEOUT, 90.0)


class BinaryIsolationTest(unittest.TestCase):
    """One poison file in a 256 batch must not cost 256 sequential timeouts."""

    def test_single_poison_file_costs_logarithmic_attempts(self):
        paths = ["file%03d.wav" % i for i in range(256)]
        poison = "file007.wav"
        calls = []

        def fake_round_trip(chunk, sample_rate, max_samples, timeout):
            calls.append(list(chunk))
            if poison in chunk:
                return {}
            return {p: [0.0] for p in chunk}

        bad = []
        isolate = getattr(embedder_module, "_collect_vectors", None)
        self.assertIsNotNone(
            isolate, "embedder must expose _collect_vectors for bisection isolation"
        )

        with mock.patch.object(embedder_module, "_mel_round_trip", fake_round_trip), \
                mock.patch.object(embedder_module, "_note_bad_file", bad.append), \
                mock.patch.object(embedder_module, "_reset_mel_worker", lambda: None):
            sink = {}
            isolate(paths, 48000, 0, sink)

        self.assertEqual(bad, [poison], "only the poison file should be blacklisted")
        self.assertEqual(len(sink), 255, "every healthy file must still get a vector")
        self.assertLessEqual(
            len(calls), 20,
            "bisection should need ~2*log2(256) attempts, made %d" % len(calls),
        )


class ResetWorkerConsoleTest(unittest.TestCase):
    """_reset_mel_worker must kill the worker tree without flashing a console.

    Regression: the taskkill call had no creationflags, so Windows opened a new
    console window for it. During poison-file isolation this happened repeatedly
    and the user saw a blue cmd window flashing.
    """

    def test_taskkill_runs_without_console_window(self):
        worker = _FakeWorker(4321)
        calls = []

        with mock.patch.object(embedder_module, "_mel_worker", worker), \
                mock.patch("subprocess.run", lambda *a, **k: calls.append((a, k))):
            embedder_module._reset_mel_worker()

        self.assertEqual(len(calls), 1, "expected exactly one taskkill invocation")
        kwargs = calls[0][1]
        self.assertTrue(
            kwargs.get("creationflags"),
            "taskkill launched without CREATE_NO_WINDOW -> blue console window flashes",
        )


if __name__ == "__main__":
    unittest.main()
