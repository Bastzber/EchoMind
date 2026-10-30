# -*- coding: utf-8 -*-
"""描述包批量写入的单元测试：不连真实库，用假 db 验证分批、跳过规则、标签合并。"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from core import metadata_pack  # noqa: E402


class _Cursor:
    def __init__(self, store):
        self.store = store
        self.connection = self
        self._result = []
        self.fts_calls = []

    def execute(self, sql, params=()):
        if sql.strip().startswith("SELECT file_uuid, path, ai_description, tags"):
            ids = list(params)
            self._result = [
                dict(self.store[item]) for item in ids if item in self.store
            ]
        return self

    def fetchall(self):
        return self._result

    def executemany(self, sql, seq):
        for row in seq:
            if sql.startswith("UPDATE files SET ai_description"):
                desc, tags, _ts, uuid = row
                self.store[uuid]["ai_description"] = desc
                self.store[uuid]["tags"] = tags

    def commit(self):
        return None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Db:
    def __init__(self, rows):
        self.rows = rows
        self.fts_batches = []
        self.stale_calls = []

    def get_cursor(self):
        return _Cursor(self.rows)

    def update_fts_rows(self, project_id, ids):
        self.fts_batches.append(list(ids))
        return len(list(ids))

    def mark_artifacts_stale(self, project_id, kind, ids):
        self.stale_calls.append(list(ids))
        return len(list(ids))


def _rows(count, desc="[auto] 待补"):
    return {
        "u%d" % i: {"file_uuid": "u%d" % i, "path": "p/u%d" % i,
                    "ai_description": desc, "tags": json.dumps(["雨"], ensure_ascii=False)}
        for i in range(count)
    }


def test_writes_in_batches_and_syncs_fts_once_per_batch():
    db = _Db(_rows(10))
    pairs = [{"file_uuid": "u%d" % i, "description": "雨声 %d" % i} for i in range(10)]
    result = metadata_pack.apply("default", pairs, db_manager=db, batch_size=4)
    assert result["applied"] == 10
    assert result["skipped"] == 0
    assert len(db.fts_batches) == 3          # 4 + 4 + 2
    assert db.rows["u3"]["ai_description"] == "雨声 3"


def test_keeps_existing_manual_description_without_overwrite():
    rows = _rows(3)
    rows["u1"]["ai_description"] = "我自己写的描述"
    db = _Db(rows)
    pairs = [{"file_uuid": "u%d" % i, "description": "AI 描述 %d" % i} for i in range(3)]
    result = metadata_pack.apply("default", pairs, db_manager=db)
    assert result["applied"] == 2
    assert result["skipped"] == 1
    assert db.rows["u1"]["ai_description"] == "我自己写的描述"


def test_overwrite_replaces_manual_description():
    rows = _rows(1)
    rows["u0"]["ai_description"] = "我自己写的描述"
    db = _Db(rows)
    result = metadata_pack.apply(
        "default", [{"file_uuid": "u0", "description": "新描述"}], overwrite=True, db_manager=db
    )
    assert result["applied"] == 1
    assert db.rows["u0"]["ai_description"] == "新描述"


def test_tags_merge_without_duplicates():
    rows = _rows(1)
    db = _Db(rows)
    metadata_pack.apply(
        "default",
        [{"file_uuid": "u0", "description": "x", "tags": ["雨", "雷声"]}],
        db_manager=db,
    )
    tags = json.loads(db.rows["u0"]["tags"])
    assert tags == ["雨", "雷声"]


def test_ignores_unknown_and_empty_pairs():
    db = _Db(_rows(2))
    result = metadata_pack.apply(
        "default",
        [{"file_uuid": "missing", "description": "x"}, {"file_uuid": "u0", "description": ""}],
        db_manager=db,
    )
    assert result["applied"] == 0

def test_only_touched_files_are_marked_stale():
    """改几条描述就只标几条：原来会 mark_project_artifacts 把整库标脏。"""
    db = _Db(_rows(10))
    pairs = [{"file_uuid": "u%d" % i, "description": "x%d" % i} for i in range(3)]
    metadata_pack.apply("default", pairs, db_manager=db)
    marked = [uuid for batch in db.stale_calls for uuid in batch]
    assert sorted(marked) == ["u0", "u1", "u2"]
