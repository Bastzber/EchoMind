# -*- coding: utf-8 -*-
"""接管逻辑的单测：不连 Chroma，用桩替代 collection 与数据库。"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from core import index_adopt  # noqa: E402


class _Collection:
    def __init__(self, rows):
        self._rows = rows

    def count(self):
        return len(self._rows)

    def get(self, limit=None, offset=0, include=None):
        rows = self._rows[offset:offset + (limit or len(self._rows))]
        return {
            "ids": [row[0] for row in rows],
            "metadatas": [row[1] for row in rows],
        }


class _Indexer:
    def __init__(self, rows, name="text_shadow_test"):
        self.collection_name = name
        self.collection = _Collection(rows)


class _Db:
    def __init__(self, manifest, states):
        self._manifest = manifest
        self._states = states
        self.ready_calls = []

    def get_index_manifest(self, project_id, kind):
        return self._manifest

    def get_artifact_states(self, project_id, kind, ids):
        return {file_id: self._states[file_id] for file_id in ids if file_id in self._states}

    def set_artifacts_ready(self, project_id, kind, ids, *, engine_fingerprint=None, now=None):
        self.ready_calls.append((list(ids), engine_fingerprint))
        for file_id in ids:
            self._states[file_id]["state"] = "ready"
        return len(ids)


def _manifest():
    return {
        "state": "ready",
        "collection_name": "text_shadow_test",
        "engine_fingerprint": "clap-text:abc",
    }


def test_adopts_matching_fingerprint():
    rows = [
        ("a", {"source_fingerprint": "s1"}),
        ("b", {"source_fingerprint": "s2"}),
    ]
    db = _Db(_manifest(), {
        "a": {"state": "stale", "source_fingerprint": "s1", "engine_fingerprint": "clap-text:abc"},
        "b": {"state": "pending", "source_fingerprint": "s2", "engine_fingerprint": "clap-text:abc"},
    })
    result = index_adopt.adopt_existing_vectors(db, _Indexer(rows), "default", "text_vector")
    assert result["scanned"] == 2
    assert result["adopted"] == 2
    assert result["kept_stale"] == 0
    assert db.ready_calls and db.ready_calls[0][1] == "clap-text:abc"


def test_keeps_rows_whose_source_changed():
    rows = [
        ("a", {"source_fingerprint": "old"}),
    ]
    db = _Db(_manifest(), {
        "a": {"state": "stale", "source_fingerprint": "new", "engine_fingerprint": "clap-text:abc"},
    })
    result = index_adopt.adopt_existing_vectors(db, _Indexer(rows), "default", "text_vector")
    assert result["adopted"] == 0
    assert result["kept_stale"] == 1
    assert not db.ready_calls


def test_dry_run_does_not_write():
    rows = [("a", {"source_fingerprint": "s1"})]
    db = _Db(_manifest(), {
        "a": {"state": "stale", "source_fingerprint": "s1", "engine_fingerprint": None},
    })
    result = index_adopt.adopt_existing_vectors(db, _Indexer(rows), "default", "text_vector", dry_run=True)
    assert result["adopted"] == 1
    assert not db.ready_calls
    assert db._states["a"]["state"] == "stale"


def test_rejects_mismatched_collection():
    rows = [("a", {"source_fingerprint": "s1"})]
    db = _Db(_manifest(), {"a": {"state": "stale", "source_fingerprint": "s1"}})
    indexer = _Indexer(rows, name="text_shadow_other")
    try:
        index_adopt.adopt_existing_vectors(db, indexer, "default", "text_vector")
    except RuntimeError as exc:
        assert "collection 不匹配" in str(exc)
    else:
        raise AssertionError("collection 不一致时应当拒绝")
