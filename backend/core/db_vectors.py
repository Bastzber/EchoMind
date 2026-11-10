# -*- coding: utf-8 -*-
"""由 database.py 拆分出来的方法组，不要单独实例化，只作为 DatabaseManager 的 mixin。"""
from __future__ import annotations

from core.db_common import *  # noqa: F401,F403
from core.db_common import (  # noqa: F401
    _execute_sql_statements,
    _get_logger,
    _is_windows_style_path,
    _parse_tags,
    _stable_file_uuid,
)
from core.db_common import logger_proxy as logger  # noqa: F401

# 单例入口在 core.database 里，这里按需延迟取，避免循环导入
def get_db_manager(*args, **kwargs):
    from core.database import get_db_manager as _impl
    return _impl(*args, **kwargs)


def reset_db_manager(*args, **kwargs):
    from core.database import reset_db_manager as _impl
    return _impl(*args, **kwargs)


def init_db(*args, **kwargs):
    from core.database import init_db as _impl
    return _impl(*args, **kwargs)


class VectorsMixin:
    def ensure_fts(self, project_id: str) -> int:
        """建表并在缺失时灌数据，返回灌入行数。"""
        from core.zh_tokenizer import tokenize

        with self.get_cursor() as cursor:
            cursor.execute(
                """
                CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
                    file_uuid UNINDEXED,
                    project_id UNINDEXED,
                    filename,
                    title,
                    description,
                    tags,
                    tokenize = 'unicode61 remove_diacritics 2'
                )
                """
            )
        with self.get_cursor() as cursor:
            total = cursor.execute(
                "SELECT COUNT(*) FROM files WHERE project_id=?", (project_id,)
            ).fetchone()[0]
            indexed = cursor.execute(
                "SELECT COUNT(*) FROM files_fts WHERE project_id=?", (project_id,)
            ).fetchone()[0]
        if total == indexed:
            return 0

        inserted = 0
        batch: List[tuple] = []
        user_tags_by_file: Dict[str, List[str]] = {}
        with self.get_cursor() as cursor:
            cursor.execute("DELETE FROM files_fts WHERE project_id=?", (project_id,))
            rows = cursor.execute(
                "SELECT file_uuid, filename, path, ai_description, tags "
                "FROM files WHERE project_id=?",
                (project_id,),
            ).fetchall()
            try:
                for uuid_value, tag_name in cursor.execute(
                    "SELECT ft.file_uuid, t.name FROM file_tags ft "
                    "JOIN tags t ON t.id = ft.tag_id AND t.project_id = ft.project_id "
                    "WHERE ft.project_id=?",
                    (project_id,),
                ).fetchall():
                    if tag_name:
                        user_tags_by_file.setdefault(str(uuid_value), []).append(str(tag_name))
            except Exception:
                user_tags_by_file = {}
        for row in rows:
            file_uuid, filename, path, description, tags = row
            name = str(filename or "")
            stem = name.rsplit(".", 1)[0] if "." in name else name
            import json as _json

            try:
                tag_list = _json.loads(tags or "[]")
                tag_text = " ".join(str(t) for t in tag_list if t)
            except Exception:
                tag_text = str(tags or "")
            extras = user_tags_by_file.get(str(file_uuid))
            if extras:
                tag_text = (tag_text + " " + " ".join(extras)).strip()
            batch.append(
                (
                    str(file_uuid),
                    str(project_id),
                    tokenize(name),
                    tokenize(stem),
                    tokenize(description or ""),
                    tokenize(tag_text),
                )
            )
            if len(batch) >= 400:
                with self.get_cursor() as cursor:
                    cursor.executemany(
                        "INSERT INTO files_fts "
                        "(file_uuid, project_id, filename, title, description, tags) "
                        "VALUES (?,?,?,?,?,?)",
                        batch,
                    )
                    cursor.connection.commit()
                inserted += len(batch)
                batch = []
        if batch:
            with self.get_cursor() as cursor:
                cursor.executemany(
                    "INSERT INTO files_fts "
                    "(file_uuid, project_id, filename, title, description, tags) "
                    "VALUES (?,?,?,?,?,?)",
                    batch,
                )
                cursor.connection.commit()
            inserted += len(batch)
        return inserted
    def fts_search(self, project_id: str, query: str, limit: int = 200) -> List[Dict[str, Any]]:
        """FTS5 + BM25 检索，按相关度返回文件元数据。"""
        from core.zh_tokenizer import build_match

        match = build_match(query)
        if not match:
            return []
        sql = """
            SELECT f.file_uuid, f.path, f.filename, f.duration, f.file_size,
                   f.sample_rate, f.channels, f.tags, f.ai_description,
                   bm25(files_fts, 0.0, 0.0, 1.0, 1.5, 2.0, 4.0) AS rank
            FROM files_fts
            JOIN files f ON f.file_uuid = files_fts.file_uuid
            WHERE files_fts MATCH ? AND files_fts.project_id = ?
            ORDER BY rank
            LIMIT ?
        """
        try:
            with self.get_cursor() as cursor:
                rows = cursor.execute(sql, (match, str(project_id), int(limit))).fetchall()
        except Exception as exc:
            logger.warning("FTS 查询失败: %s", exc)
            return []
        return [
            {
                "file_id": row["file_uuid"],
                "file_path": row["path"],
                "filename": row["filename"],
                "duration": row["duration"],
                "size": row["file_size"],
                "sample_rate": row["sample_rate"],
                "channels": row["channels"],
                "tags": row["tags"],
                "ai_description": row["ai_description"],
                "rank": row["rank"],
            }
            for row in rows
        ]
    def update_fts_row(self, project_id: str, file_uuid: str) -> None:
        """描述/标签改动后同步 FTS 行（失败不影响主流程）。"""
        from core.zh_tokenizer import tokenize

        try:
            with self.get_cursor() as cursor:
                row = cursor.execute(
                    "SELECT filename, ai_description, tags FROM files WHERE file_uuid=?",
                    (file_uuid,),
                ).fetchone()
                if not row:
                    return
                name = str(row["filename"] or "")
                stem = name.rsplit(".", 1)[0] if "." in name else name
                try:
                    tag_list = json.loads(row["tags"] or "[]")
                    tag_text = " ".join(str(t) for t in tag_list if t)
                except Exception:
                    tag_text = str(row["tags"] or "")
                user_tag_text = self._user_tag_text(cursor, project_id, file_uuid)
                if user_tag_text:
                    tag_text = (tag_text + " " + user_tag_text).strip()
                cursor.execute(
                    "DELETE FROM files_fts WHERE file_uuid=?", (file_uuid,)
                )
                cursor.execute(
                    "INSERT INTO files_fts "
                    "(file_uuid, project_id, filename, title, description, tags) "
                    "VALUES (?,?,?,?,?,?)",
                    (
                        file_uuid,
                        str(project_id),
                        tokenize(name),
                        tokenize(stem),
                        tokenize(row["ai_description"] or ""),
                        tokenize(tag_text),
                    ),
                )
                cursor.connection.commit()
        except Exception as exc:
            logger.debug("同步 FTS 行失败 %s: %s", file_uuid, exc)
    def mark_artifacts_stale(
        self, project_id: str, kind: str, file_uuids: Iterable[str]
    ) -> int:
        """只把指定文件标脏。

        原来是 mark_project_artifacts(project, [kind], 'stale')：改 3 条描述就
        把 6.5 万条文本向量全标脏，下一次对账要重编码整库。这里精确到文件。
        """
        if kind not in ARTIFACT_KINDS:
            return 0
        selected = [str(uuid) for uuid in dict.fromkeys(file_uuids) if uuid]
        if not selected:
            return 0
        stamp = datetime.now().isoformat()
        updated = 0
        for offset in range(0, len(selected), 500):
            batch = selected[offset:offset + 500]
            placeholders = ",".join("?" for _ in batch)
            with self.get_cursor() as cursor:
                cursor.execute(
                    f"""
                    UPDATE file_artifacts
                    SET state='stale', updated_at=?
                    WHERE project_id=? AND kind=? AND state='ready'
                      AND file_uuid IN ({placeholders})
                    """,
                    (stamp, str(project_id), kind, *batch),
                )
                updated += cursor.rowcount
        return updated
    def update_fts_rows(self, project_id: str, file_uuids: Iterable[str]) -> int:
        """批量同步 FTS 行：一次查询 + 一次 executemany，替代逐条 update_fts_row。

        逐条版本每条都要 SELECT + DELETE + INSERT + commit，64k 条描述包就是这么
        把写锁占满的（日志里的 database is locked）。
        """
        from core.zh_tokenizer import tokenize

        selected = [str(uuid) for uuid in dict.fromkeys(file_uuids) if uuid]
        if not selected:
            return 0
        written = 0
        for offset in range(0, len(selected), 500):
            chunk = selected[offset:offset + 500]
            placeholders = ",".join("?" for _ in chunk)
            try:
                with self.get_cursor() as cursor:
                    rows = cursor.execute(
                        f"SELECT file_uuid, filename, ai_description, tags FROM files "
                        f"WHERE file_uuid IN ({placeholders})",
                        chunk,
                    ).fetchall()
                    payload = []
                    for row in rows:
                        name = str(row["filename"] or "")
                        stem = name.rsplit(".", 1)[0] if "." in name else name
                        try:
                            tag_list = json.loads(row["tags"] or "[]")
                            tag_text = " ".join(str(t) for t in tag_list if t)
                        except Exception:
                            tag_text = str(row["tags"] or "")
                        user_tag_text = self._user_tag_text(cursor, project_id, row["file_uuid"])
                        if user_tag_text:
                            tag_text = (tag_text + " " + user_tag_text).strip()
                        payload.append((
                            row["file_uuid"], str(project_id), tokenize(name), tokenize(stem),
                            tokenize(row["ai_description"] or ""), tokenize(tag_text),
                        ))
                    if payload:
                        cursor.executemany(
                            "DELETE FROM files_fts WHERE file_uuid=?", [(item[0],) for item in payload]
                        )
                        cursor.executemany(
                            "INSERT INTO files_fts "
                            "(file_uuid, project_id, filename, title, description, tags) "
                            "VALUES (?,?,?,?,?,?)",
                            payload,
                        )
                        cursor.connection.commit()
                        written += len(payload)
            except Exception as exc:
                logger.debug("批量同步 FTS 失败（%d 条）: %s", len(chunk), exc)
        return written
    def _sync_fts_for_path(self, canonical_path: str, project_id: Optional[str] = None) -> None:
        """按路径把 FTS 行更新到最新（描述/标签变更后调用）。"""
        try:
            with self.get_cursor() as cursor:
                row = cursor.execute(
                    "SELECT file_uuid, project_id FROM files WHERE canonical_path=? LIMIT 1",
                    (canonical_path,),
                ).fetchone()
            if row:
                self.update_fts_row(row["project_id"] or project_id or "default", row["file_uuid"])
        except Exception as exc:
            _get_logger().debug(f"同步 FTS 失败 {canonical_path}: {exc}")
    def set_artifact_state(
        self,
        project_id: str,
        file_uuid: str,
        kind: str,
        state: str,
        *,
        source_fingerprint: Optional[str] = None,
        engine_fingerprint: Optional[str] = None,
        error_code: Optional[str] = None,
        error_message: Optional[str] = None,
    ) -> bool:
        if kind not in ARTIFACT_KINDS or state not in ARTIFACT_STATES:
            raise ValueError(f"invalid artifact transition: {kind}/{state}")
        now = datetime.now().isoformat()
        with self.get_cursor() as cursor:
            exists = cursor.execute("""
                SELECT 1 FROM files WHERE project_id=? AND file_uuid=?
            """, (project_id, file_uuid)).fetchone()
            if not exists:
                return False
            cursor.execute("""
                INSERT INTO file_artifacts
                (project_id, file_uuid, kind, state, source_fingerprint,
                 engine_fingerprint, error_code, error_message, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(project_id, file_uuid, kind) DO UPDATE SET
                    state=excluded.state,
                    source_fingerprint=COALESCE(
                        excluded.source_fingerprint, file_artifacts.source_fingerprint
                    ),
                    engine_fingerprint=COALESCE(
                        excluded.engine_fingerprint, file_artifacts.engine_fingerprint
                    ),
                    error_code=excluded.error_code,
                    error_message=excluded.error_message,
                    updated_at=excluded.updated_at
            """, (
                project_id, file_uuid, kind, state, source_fingerprint,
                engine_fingerprint, error_code, error_message, now,
            ))
        # 状态变了，计数缓存立刻作废，界面不用等 60 秒才看到「已就绪 +1」
        self.invalidate_artifact_counts(project_id)
        return True
    def mark_artifacts_stale_for_file(
        self,
        project_id: str,
        file_uuid: str,
        kinds: Iterable[str],
        now: Optional[str] = None,
    ) -> int:
        """标记单个文件的多个工件为 stale（重新分析/重命名后触发重建）。"""
        selected_kinds = tuple(kind for kind in kinds if kind in ARTIFACT_KINDS)
        if not selected_kinds:
            return 0
        timestamp = now or datetime.now().isoformat()
        placeholders = ",".join("?" for _ in selected_kinds)
        with self.get_cursor() as cursor:
            cursor.execute(f"""
                UPDATE file_artifacts
                SET state='stale', error_code=NULL, error_message=NULL, updated_at=?
                WHERE project_id=? AND file_uuid=? AND kind IN ({placeholders})
            """, (timestamp, project_id, file_uuid, *selected_kinds))
            return cursor.rowcount
    def get_artifact_counts(self, project_id: str) -> Dict[str, Dict[str, int]]:
        # 这个 JOIN 在 6.5 万条上要 870ms，而前端每 2 秒轮询一次 index/status，
        # 每次都卡一下主线程（新建工程打字卡顿的根因，11-03 实测 890~1190ms/次）。
        # 工件计数变化不频繁，缓存 15 秒；导入/索引任务会主动清缓存。
        now = time.monotonic()
        cache = getattr(self, '_artifact_counts_cache', None)
        if cache and cache.get('project_id') == project_id and now - cache.get('at', 0) < 60.0:
            return {k: dict(v) for k, v in cache['value'].items()}

        result = {
            kind: {state: 0 for state in ARTIFACT_STATES}
            for kind in ARTIFACT_KINDS
        }
        with self.get_cursor() as cursor:
            # 只统计仍然存在对应 files 行的工件。file_artifacts 里会残留孤儿行
            # （files 行已删、cascade 没生效），把它们算进来会让界面永远显示
            # 「待索引 N」而实际没有任何文件可索引（2026-10-31 实测 6/8/1 条）。
            rows = cursor.execute("""
                SELECT a.kind, a.state, COUNT(*) AS count
                FROM file_artifacts a
                JOIN files f ON f.file_uuid = a.file_uuid
                WHERE a.project_id=? GROUP BY a.kind, a.state
            """, (project_id,)).fetchall()
        for row in rows:
            result[row["kind"]][row["state"]] = row["count"]
        self._artifact_counts_cache = {
            'project_id': project_id,
            'at': time.monotonic(),
            'value': {k: dict(v) for k, v in result.items()},
        }
        return result
    def invalidate_artifact_counts(self, project_id: Optional[str] = None) -> None:
        """工件状态变了就清缓存，别让界面看着旧的「待索引 N」。"""
        cache = getattr(self, '_artifact_counts_cache', None)
        if not cache:
            return
        if project_id and cache.get('project_id') != project_id:
            return
        self._artifact_counts_cache = None
    def get_artifact(
        self, project_id: str, file_uuid: str, kind: str
    ) -> Optional[Dict[str, Any]]:
        if kind not in ARTIFACT_KINDS:
            return None
        with self.get_cursor() as cursor:
            row = cursor.execute("""
                SELECT project_id, file_uuid, kind, state, source_fingerprint,
                       engine_fingerprint, error_code, error_message, updated_at
                FROM file_artifacts
                WHERE project_id=? AND file_uuid=? AND kind=?
            """, (project_id, file_uuid, kind)).fetchone()
        return dict(row) if row else None
    def get_artifact_states(
        self,
        project_id: str,
        kind: str,
        file_ids: Iterable[str],
    ) -> Dict[str, Dict[str, Any]]:
        """批量取工件的 state / source_fingerprint，用于接管或对账。"""
        if kind not in ARTIFACT_KINDS:
            return {}
        selected = tuple(dict.fromkeys(str(value) for value in file_ids if value))
        if not selected:
            return {}
        result: Dict[str, Dict[str, Any]] = {}
        for offset in range(0, len(selected), 500):
            batch = selected[offset:offset + 500]
            placeholders = ",".join("?" for _ in batch)
            with self.get_cursor() as cursor:
                rows = cursor.execute(
                    f"""
                    SELECT file_uuid, state, source_fingerprint, engine_fingerprint
                    FROM file_artifacts
                    WHERE project_id=? AND kind=? AND file_uuid IN ({placeholders})
                    """,
                    (project_id, kind, *batch),
                ).fetchall()
            for row in rows:
                result[str(row["file_uuid"])] = {
                    "state": row["state"],
                    "source_fingerprint": row["source_fingerprint"],
                    "engine_fingerprint": row["engine_fingerprint"],
                }
        return result
    def set_artifacts_ready(
        self,
        project_id: str,
        kind: str,
        file_ids: Iterable[str],
        *,
        engine_fingerprint: Optional[str] = None,
        now: Optional[str] = None,
    ) -> int:
        """把一批工件直接标成 ready（接管已有向量时用，不重新编码）。"""
        if kind not in ARTIFACT_KINDS:
            return 0
        selected = tuple(dict.fromkeys(str(value) for value in file_ids if value))
        if not selected:
            return 0
        timestamp = now or datetime.now().isoformat()
        updated = 0
        for offset in range(0, len(selected), 500):
            batch = selected[offset:offset + 500]
            placeholders = ",".join("?" for _ in batch)
            with self.get_cursor() as cursor:
                cursor.execute(
                    f"""
                    UPDATE file_artifacts
                    SET state='ready',
                        engine_fingerprint=COALESCE(?, engine_fingerprint),
                        error_code=NULL,
                        error_message=NULL,
                        updated_at=?
                    WHERE project_id=? AND kind=?
                      AND state<>'ready' AND file_uuid IN ({placeholders})
                    """,
                    (engine_fingerprint, timestamp, project_id, kind, *batch),
                )
                updated += cursor.rowcount
        return updated
    def get_ready_artifact_ids(
        self,
        project_id: str,
        kind: str,
        file_ids: Iterable[str],
    ) -> set[str]:
        """Return the requested IDs whose SQLite artifact is currently ready."""
        if kind not in ARTIFACT_KINDS:
            return set()
        selected = tuple(dict.fromkeys(str(value) for value in file_ids if value))
        if not selected:
            return set()
        ready: set[str] = set()
        # Stay below SQLite's common parameter bound while supporting large
        # internal search pages.
        for offset in range(0, len(selected), 500):
            batch = selected[offset : offset + 500]
            placeholders = ",".join("?" for _ in batch)
            with self.get_cursor() as cursor:
                rows = cursor.execute(
                    f"""
                    SELECT file_uuid FROM file_artifacts
                    WHERE project_id=? AND kind=? AND state='ready'
                      AND file_uuid IN ({placeholders})
                    """,
                    (project_id, kind, *batch),
                ).fetchall()
            ready.update(str(row["file_uuid"]) for row in rows)
        return ready
    def list_artifacts_for_work(
        self,
        project_id: str,
        kinds: Iterable[str] = ARTIFACT_KINDS,
        # 默认不再把 failed 当作待办：失败的文件反复重试只会空转，
        # 还会让「处理中/失败」永远收敛不到 0（实测 48 条毒 MP3 就是这种）。
        # 需要重试时由「修复索引」显式传入 states=("failed",)。
        states: Iterable[str] = ("pending", "stale"),
        limit: int = 500,
        # 解码失败是终态（error_code='decode_failed'）：文件本身坏了或格式不支持，
        # 再排一百次也是白等超时。源文件换了会清掉 error_code，届时自然会重新排队。
        skip_error_codes: Iterable[str] = ("decode_failed",),
    ) -> List[Dict[str, Any]]:
        selected_kinds = tuple(kind for kind in kinds if kind in ARTIFACT_KINDS)
        selected_states = tuple(state for state in states if state in ARTIFACT_STATES)
        if not selected_kinds or not selected_states:
            return []
        selected_skip = tuple(str(code) for code in (skip_error_codes or ()) if code)
        placeholders_kinds = ",".join("?" for _ in selected_kinds)
        placeholders_states = ",".join("?" for _ in selected_states)
        skip_clause = ""
        if selected_skip:
            placeholders_skip = ",".join("?" for _ in selected_skip)
            skip_clause = f" AND COALESCE(a.error_code,'') NOT IN ({placeholders_skip})"
        query = f"""
            SELECT f.file_uuid, f.path, f.filename, f.duration, f.sample_rate,
                   f.channels, f.file_size, f.tags, f.source_fingerprint,
                   a.kind, a.state, a.engine_fingerprint, a.error_code,
                   a.error_message
            FROM file_artifacts a
            JOIN files f ON f.project_id=a.project_id AND f.file_uuid=a.file_uuid
            WHERE a.project_id=? AND a.kind IN ({placeholders_kinds})
              AND a.state IN ({placeholders_states}){skip_clause}
            ORDER BY a.updated_at, f.id LIMIT ?
        """
        # Index reconciliation is a background job and must be able to cover a
        # complete large library.  The public list API remains capped at 500;
        # this internal guard only prevents an accidentally unbounded query.
        params = [
            project_id, *selected_kinds, *selected_states, *selected_skip,
            max(1, min(limit, 100000)),
        ]
        with self.get_cursor() as cursor:
            return [dict(row) for row in cursor.execute(query, params).fetchall()]
    def upsert_index_manifest(
        self,
        project_id: str,
        kind: str,
        **values: Any,
    ) -> Dict[str, Any]:
        if kind not in ("audio_vector", "text_vector"):
            raise ValueError(f"invalid index kind: {kind}")
        allowed = {
            "collection_name", "engine_fingerprint", "model_id", "model_revision",
            "dimensions", "preprocessing_version", "metric", "state",
        }
        current = self.get_index_manifest(project_id, kind) or {}
        merged = {key: values.get(key, current.get(key)) for key in allowed}
        merged["metric"] = merged.get("metric") or "cosine"
        merged["state"] = merged.get("state") or "pending"
        revision = int(current.get("revision", 0)) + int(values.get("revision_increment", 0))
        now = datetime.now().isoformat()
        with self.get_cursor() as cursor:
            cursor.execute("""
                INSERT INTO index_manifests
                (project_id, kind, collection_name, engine_fingerprint, model_id,
                 model_revision, dimensions, preprocessing_version, metric,
                 revision, state, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(project_id, kind) DO UPDATE SET
                    collection_name=excluded.collection_name,
                    engine_fingerprint=excluded.engine_fingerprint,
                    model_id=excluded.model_id,
                    model_revision=excluded.model_revision,
                    dimensions=excluded.dimensions,
                    preprocessing_version=excluded.preprocessing_version,
                    metric=excluded.metric,
                    revision=excluded.revision,
                    state=excluded.state,
                    updated_at=excluded.updated_at
            """, (
                project_id, kind, merged.get("collection_name"),
                merged.get("engine_fingerprint"), merged.get("model_id"),
                merged.get("model_revision"), merged.get("dimensions"),
                merged.get("preprocessing_version"), merged["metric"], revision,
                merged["state"], now,
            ))
        return self.get_index_manifest(project_id, kind) or {}
    def get_index_manifest(self, project_id: str, kind: str) -> Optional[Dict[str, Any]]:
        with self.get_cursor() as cursor:
            row = cursor.execute("""
                SELECT * FROM index_manifests WHERE project_id=? AND kind=?
            """, (project_id, kind)).fetchone()
        return dict(row) if row else None
    def activate_index_manifests(
        self, project_id: str, manifests: Dict[str, Dict[str, Any]]
    ) -> Dict[str, Dict[str, Any]]:
        """Atomically make one or more verified shadow collections active."""
        if not is_safe_project_id(project_id):
            raise ValueError("invalid project id")
        valid: Dict[str, Dict[str, Any]] = {}
        for kind, payload in manifests.items():
            if kind not in ("audio_vector", "text_vector"):
                raise ValueError(f"invalid index kind: {kind}")
            collection_name = str(payload.get("collection_name") or "").strip()
            if not collection_name or payload.get("metric") != "cosine":
                raise ValueError(f"unverified index manifest: {kind}")
            valid[kind] = dict(payload)
        if not valid:
            return {}

        now = datetime.now().isoformat()
        with self.get_cursor() as cursor:
            for kind, payload in valid.items():
                current = cursor.execute("""
                    SELECT revision FROM index_manifests
                    WHERE project_id=? AND kind=?
                """, (project_id, kind)).fetchone()
                revision = int(current["revision"] if current else 0) + 1
                cursor.execute("""
                    INSERT INTO index_manifests
                    (project_id, kind, collection_name, engine_fingerprint, model_id,
                     model_revision, dimensions, preprocessing_version, metric,
                     revision, state, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'cosine', ?, 'ready', ?)
                    ON CONFLICT(project_id, kind) DO UPDATE SET
                        collection_name=excluded.collection_name,
                        engine_fingerprint=excluded.engine_fingerprint,
                        model_id=excluded.model_id,
                        model_revision=excluded.model_revision,
                        dimensions=excluded.dimensions,
                        preprocessing_version=excluded.preprocessing_version,
                        metric='cosine', revision=excluded.revision,
                        state='ready', updated_at=excluded.updated_at
                """, (
                    project_id,
                    kind,
                    payload["collection_name"],
                    payload.get("engine_fingerprint"),
                    payload.get("model_id"),
                    payload.get("model_revision"),
                    payload.get("dimensions"),
                    payload.get("preprocessing_version"),
                    revision,
                    now,
                ))
        return {
            kind: self.get_index_manifest(project_id, kind) or {}
            for kind in valid
        }
