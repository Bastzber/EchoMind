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


class FilesMixin:
    def set_favorite(self, project_id: str, file_uuid: str, value: bool) -> bool:
        with self.get_cursor() as cursor:
            cursor.execute(
                "UPDATE files SET is_favorite=? WHERE project_id=? AND file_uuid=?",
                (1 if value else 0, str(project_id), str(file_uuid)),
            )
            changed = cursor.rowcount > 0
            cursor.connection.commit()
        return changed
    def list_favorites(self, project_id: str, limit: int = 500) -> List[Dict[str, Any]]:
        with self.get_cursor() as cursor:
            rows = cursor.execute(
                "SELECT file_uuid, path, filename, duration, file_size, tags, ai_description "
                "FROM files WHERE project_id=? AND is_favorite=1 ORDER BY filename LIMIT ?",
                (str(project_id), int(limit)),
            ).fetchall()
        return [
            {
                "id": r[0], "file_uuid": r[0], "path": r[1], "file_path": r[1],
                "filename": r[2], "duration": r[3], "size": r[4],
                "tags": _parse_tags(r[5]), "ai_description": r[6], "is_favorite": True,
            }
            for r in rows
        ]
    def count_favorites(self, project_id: str) -> int:
        with self.get_cursor() as cursor:
            row = cursor.execute(
                "SELECT COUNT(*) FROM files WHERE project_id=? AND is_favorite=1",
                (str(project_id),),
            ).fetchone()
        return int(row[0] or 0)
    def ensure_ignored_duplicate_schema(self) -> None:
        with self.get_cursor() as cursor:
            cursor.execute(
                "CREATE TABLE IF NOT EXISTS ignored_duplicate_groups ("
                "project_id TEXT NOT NULL, sha256 TEXT NOT NULL, note TEXT, created_at TEXT, "
                "PRIMARY KEY (project_id, sha256))"
            )
    def ignore_duplicate_group(self, project_id: str, sha256: str, note: str = "") -> bool:
        """把一组"有意保留的多分类音效"加入忽略名单，重复检测不再提示它。"""
        if not sha256:
            return False
        self.ensure_ignored_duplicate_schema()
        with self.get_cursor() as cursor:
            cursor.execute(
                "INSERT OR REPLACE INTO ignored_duplicate_groups "
                "(project_id, sha256, note, created_at) VALUES (?,?,?,?)",
                (str(project_id), str(sha256), str(note or ""), datetime.now().isoformat()),
            )
        return True
    def unignore_duplicate_group(self, project_id: str, sha256: str) -> bool:
        self.ensure_ignored_duplicate_schema()
        with self.get_cursor() as cursor:
            cursor.execute(
                "DELETE FROM ignored_duplicate_groups WHERE project_id=? AND sha256=?",
                (str(project_id), str(sha256)),
            )
            return cursor.rowcount > 0
    def list_ignored_duplicate_groups(self, project_id: str) -> List[Dict[str, str]]:
        self.ensure_ignored_duplicate_schema()
        with self.get_cursor() as cursor:
            rows = cursor.execute(
                "SELECT sha256, COALESCE(note,''), COALESCE(created_at,'') "
                "FROM ignored_duplicate_groups WHERE project_id=? ORDER BY created_at DESC",
                (str(project_id),),
            ).fetchall()
        return [{"sha256": row[0], "note": row[1], "created_at": row[2]} for row in rows]
    def duplicate_groups(self, project_id: str, limit: int = 100) -> List[Dict[str, Any]]:
        """按 sha256 分组找重复文件（跳过被标记"有意保留"的组）。"""
        self.ensure_ignored_duplicate_schema()
        ignored = {row["sha256"] for row in self.list_ignored_duplicate_groups(project_id)}
        with self.get_cursor() as cursor:
            rows = cursor.execute(
                "SELECT sha256, COUNT(*) AS n FROM files "
                "WHERE project_id=? AND sha256 IS NOT NULL AND sha256 != '' "
                "GROUP BY sha256 HAVING n > 1 ORDER BY n DESC LIMIT ?",
                (str(project_id), int(limit)),
            ).fetchall()
            groups = []
            for sha, count in rows:
                if sha in ignored:
                    continue
                files = cursor.execute(
                    "SELECT file_uuid, path, filename, file_size FROM files "
                    "WHERE project_id=? AND sha256=? ORDER BY path",
                    (str(project_id), sha),
                ).fetchall()
                groups.append(
                    {
                        "sha256": sha,
                        "count": count,
                        "files": [
                            {"file_uuid": f[0], "path": f[1], "filename": f[2], "size": f[3]}
                            for f in files
                        ],
                    }
                )
        return groups
    def files_needing_hash(self, project_id: str, limit: int = 200) -> List[Dict[str, str]]:
        """取还没算哈希的文件（大文件优先）。"""
        with self.get_cursor() as cursor:
            rows = cursor.execute(
                "SELECT file_uuid, path FROM files "
                "WHERE project_id=? AND COALESCE(hash_state,0)=0 "
                "ORDER BY file_size DESC LIMIT ?",
                (str(project_id), int(limit)),
            ).fetchall()
        return [{"file_uuid": r[0], "path": r[1]} for r in rows]
    def set_file_hash(self, file_uuid: str, sha256: str | None, state: int = 1) -> None:
        with self.get_cursor() as cursor:
            cursor.execute(
                "UPDATE files SET sha256=?, hash_state=? WHERE file_uuid=?",
                (sha256, state, file_uuid),
            )
            cursor.connection.commit()
    def upsert_file(self, record: AudioFileRecord, project_id: str = "default") -> Optional[str]:
        """Insert/update metadata and return the stable project-scoped file UUID."""
        if not is_safe_project_id(project_id):
            raise ValueError(f"unsafe project id: {project_id!r}")
        canonical_path = canonicalize_path(record.path)
        if not canonical_path:
            raise ValueError("file path is empty")
        source_fingerprint = record.source_fingerprint or make_source_fingerprint(record.path)
        now = datetime.now().isoformat()
        try:
            with self.get_cursor() as cursor:
                existing = cursor.execute("""
                    SELECT file_uuid, source_fingerprint, filename, tags
                    FROM files WHERE project_id=? AND canonical_path=?
                """, (project_id, canonical_path)).fetchone()
                file_uuid = (
                    existing["file_uuid"] if existing else
                    record.file_uuid or _stable_file_uuid(project_id, canonical_path)
                )
                source_changed = bool(
                    existing and existing["source_fingerprint"] != source_fingerprint
                )
                metadata_changed = bool(
                    existing and existing["filename"] != record.filename
                )
                auto_desc = "[auto]" + (
                    os.path.splitext(record.filename or "")[0].strip()
                    or record.filename or ""
                )
                cursor.execute("""
                    INSERT INTO files
                    (file_uuid, path, canonical_path, project_id, filename, duration,
                     sample_rate, channels, file_size, source_fingerprint, peaks_json,
                     waveform_fingerprint, waveform_version, tags, ai_description, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(project_id, canonical_path) DO UPDATE SET
                        path = excluded.path,
                        filename = excluded.filename,
                        duration = excluded.duration,
                        sample_rate = excluded.sample_rate,
                        channels = excluded.channels,
                        file_size = excluded.file_size,
                        source_fingerprint = excluded.source_fingerprint,
                        peaks_json = CASE
                            WHEN NOT (files.source_fingerprint IS excluded.source_fingerprint)
                                THEN excluded.peaks_json
                            ELSE COALESCE(excluded.peaks_json, files.peaks_json)
                        END,
                        waveform_fingerprint = CASE
                            WHEN NOT (files.source_fingerprint IS excluded.source_fingerprint)
                                THEN excluded.waveform_fingerprint
                            ELSE COALESCE(
                                excluded.waveform_fingerprint, files.waveform_fingerprint
                            )
                        END,
                        waveform_version = CASE
                            WHEN excluded.peaks_json IS NOT NULL THEN excluded.waveform_version
                            WHEN NOT (files.source_fingerprint IS excluded.source_fingerprint)
                                THEN NULL
                            ELSE files.waveform_version
                        END,
                        tags = CASE
                            WHEN files.tags IS NOT NULL AND files.tags != '[]' THEN files.tags
                            ELSE excluded.tags
                        END,
                        updated_at = excluded.updated_at
                """, (
                    file_uuid,
                    record.path,
                    canonical_path,
                    project_id,
                    record.filename,
                    record.duration,
                    record.sample_rate,
                    record.channels,
                    record.file_size,
                    source_fingerprint,
                    record.peaks_json,
                    record.waveform_fingerprint,
                    record.waveform_version,
                    record.tags,
                    auto_desc,
                    now,
                ))

                waveform_state = "ready" if record.get_peaks() else "pending"
                for kind in ARTIFACT_KINDS:
                    initial_state = waveform_state if kind == "waveform" else "pending"
                    cursor.execute("""
                        INSERT OR IGNORE INTO file_artifacts
                        (project_id, file_uuid, kind, state, source_fingerprint, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                    """, (project_id, file_uuid, kind, initial_state, source_fingerprint, now))
                if source_changed:
                    cursor.execute("""
                        UPDATE file_artifacts
                        SET state='stale', source_fingerprint=?, error_code=NULL,
                            error_message=NULL, updated_at=?
                        WHERE project_id=? AND file_uuid=?
                          AND kind IN ('waveform', 'audio_vector', 'text_vector')
                    """, (source_fingerprint, now, project_id, file_uuid))
                if metadata_changed:
                    cursor.execute("""
                        UPDATE file_artifacts
                        SET state='stale', source_fingerprint=?, error_code=NULL,
                            error_message=NULL, updated_at=?
                        WHERE project_id=? AND file_uuid=? AND kind='text_vector'
                    """, (source_fingerprint, now, project_id, file_uuid))
                if record.get_peaks():
                    cursor.execute("""
                        UPDATE file_artifacts SET state='ready', source_fingerprint=?,
                            engine_fingerprint=?, error_code=NULL, error_message=NULL, updated_at=?
                        WHERE project_id=? AND file_uuid=? AND kind='waveform'
                    """, (
                        source_fingerprint,
                        record.waveform_fingerprint,
                        now,
                        project_id,
                        file_uuid,
                    ))
            # 新文件/元数据变了：让「找相似」的词表重建（签名检查也会兜住）
            self._invalidate_similar_cache(project_id)
            return file_uuid
        except Exception as exc:
            _get_logger().error(f"写入文件失败 {record.path}: {exc}")
            raise
    def add_file(self, record: AudioFileRecord, project_id: str = 'default') -> bool:
        """
        添加或更新文件记录（按工程内路径去重）

        Args:
            record: 音频文件记录
            project_id: 所属工程ID

        Returns:
            是否成功
        """
        return self.upsert_file(record, project_id) is not None
    def add_file_simple(
        self,
        path: str,
        filename: str,
        duration: float = 0.0,
        sample_rate: int = 0,
        channels: int = 0,
        file_size: int = 0,
        peaks_json: Optional[str] = None,
        tags: str = '[]'
    ) -> bool:
        """
        简化版添加文件记录

        Args:
            path: 文件路径
            filename: 文件名
            duration: 时长
            sample_rate: 采样率
            channels: 声道数
            file_size: 文件大小
            peaks_json: 波形峰值 JSON
            tags: 标签 JSON

        Returns:
            是否成功
        """
        record = AudioFileRecord(
            path=path,
            filename=filename,
            duration=duration,
            sample_rate=sample_rate,
            channels=channels,
            file_size=file_size,
            peaks_json=peaks_json,
            tags=tags
        )
        return self.add_file(record)
    def get_file(self, path: str, project_id: str = None) -> Optional[AudioFileRecord]:
        """
        获取单个文件记录

        Args:
            path: 文件路径

        Returns:
            音频文件记录，如果不存在则返回 None
        """
        canonical_path = canonicalize_path(path)
        with self.get_cursor() as cursor:
            if project_id:
                cursor.execute(
                    "SELECT * FROM files WHERE canonical_path = ? AND project_id = ?",
                    (canonical_path, project_id),
                )
            else:
                cursor.execute("SELECT * FROM files WHERE canonical_path = ?", (canonical_path,))
            row = cursor.fetchone()
            if row:
                return self._row_to_record(row)
        return None
    def get_all_files(self) -> List[AudioFileRecord]:
        """
        获取所有文件记录

        Returns:
            音频文件记录列表
        """
        with self.get_cursor() as cursor:
            cursor.execute("SELECT * FROM files ORDER BY created_at DESC")
            return [self._row_to_record(row) for row in cursor.fetchall()]
    def get_files_paginated(
        self,
        offset: int = 0,
        limit: int = 100,
        project_id: Optional[str] = None,
    ) -> List[AudioFileRecord]:
        """
        分页获取文件记录

        Args:
            offset: 起始位置
            limit: 返回数量

        Returns:
            音频文件记录列表
        """
        with self.get_cursor() as cursor:
            if project_id:
                cursor.execute(
                    "SELECT * FROM files WHERE project_id=? ORDER BY id DESC LIMIT ? OFFSET ?",
                    (project_id, limit, offset),
                )
            else:
                cursor.execute(
                    "SELECT * FROM files ORDER BY id DESC LIMIT ? OFFSET ?",
                    (limit, offset),
                )
            return [self._row_to_record(row) for row in cursor.fetchall()]
    def get_files_cursor_page(
        self,
        project_id: str,
        limit: int = 200,
        before_id: Optional[int] = None,
        folder: Optional[str] = None,
    ) -> Tuple[List[Dict[str, Any]], Optional[int]]:
        """Return a metadata-only cursor page; waveform arrays are deliberately omitted."""
        limit = max(1, min(int(limit), 500))
        with self.get_cursor() as cursor:
            sql = """
                SELECT f.id, f.file_uuid, f.path, f.filename, f.duration,
                       f.sample_rate, f.channels, f.file_size, f.tags,
                       f.ai_description, COALESCE(f.is_favorite, 0) AS is_favorite,
                       COALESCE(f.source, 'user') AS source,
                       f.source_fingerprint, f.waveform_version,
                       MAX(CASE WHEN a.kind='waveform' THEN a.state END) AS waveform_state,
                       MAX(CASE WHEN a.kind='audio_vector' THEN a.state END) AS audio_index_state,
                       MAX(CASE WHEN a.kind='text_vector' THEN a.state END) AS text_index_state
                FROM files f
                LEFT JOIN file_artifacts a
                  ON a.project_id=f.project_id AND a.file_uuid=f.file_uuid
                WHERE f.project_id=?
            """
            params: List[Any] = [project_id]
            if folder:
                prefix = str(folder).rstrip('\\/') + '\\'
                sql += " AND substr(f.path, 1, length(?)) = ?"
                params.extend([prefix, prefix])
            if before_id is not None:
                sql += " AND f.id < ?"
                params.append(before_id)
            sql += " GROUP BY f.id ORDER BY f.id DESC LIMIT ?"
            params.append(limit + 1)
            rows = cursor.execute(sql, params).fetchall()
        has_more = len(rows) > limit
        rows = rows[:limit]
        items = []
        for row in rows:
            try:
                tags = json.loads(row["tags"] or "[]")
            except (TypeError, ValueError):
                tags = []
            items.append({
                "id": row["file_uuid"],
                "path": row["path"],
                "filename": row["filename"],
                "duration": row["duration"],
                "sample_rate": row["sample_rate"],
                "channels": row["channels"],
                "file_size": row["file_size"],
                "format": Path(row["path"]).suffix.lower().lstrip("."),
                "tags": tags,
                "ai_description": row["ai_description"] or "",
                "is_favorite": bool(row["is_favorite"]),
                "source": row["source"] or "user",
                "source_fingerprint": row["source_fingerprint"],
                "waveform_version": row["waveform_version"],
                "waveform_state": row["waveform_state"] or "pending",
                "audio_index_state": row["audio_index_state"] or "pending",
                "text_index_state": row["text_index_state"] or "pending",
            })
        next_cursor = rows[-1]["id"] if has_more and rows else None
        return items, next_cursor
    def get_file_by_uuid(
        self, file_uuid: str, project_id: Optional[str] = None
    ) -> Optional[AudioFileRecord]:
        with self.get_cursor() as cursor:
            if project_id:
                row = cursor.execute(
                    "SELECT * FROM files WHERE file_uuid=? AND project_id=?",
                    (file_uuid, project_id),
                ).fetchone()
            else:
                row = cursor.execute(
                    "SELECT * FROM files WHERE file_uuid=?", (file_uuid,)
                ).fetchone()
        return self._row_to_record(row) if row else None
    def file_exists(self, path: str, project_id: str = None) -> bool:
        """
        检查文件记录是否存在

        Args:
            path: 文件路径
            project_id: 工程ID（可选，如果提供则只检查该工程）

        Returns:
            是否存在
        """
        canonical_path = canonicalize_path(path)
        with self.get_cursor() as cursor:
            if project_id:
                cursor.execute(
                    "SELECT 1 FROM files WHERE canonical_path = ? AND project_id = ?",
                    (canonical_path, project_id),
                )
            else:
                cursor.execute("SELECT 1 FROM files WHERE canonical_path = ?", (canonical_path,))
            return cursor.fetchone() is not None
    def update_peaks(
        self,
        path: str,
        peaks: List[float],
        project_id: str = None,
        source_fingerprint: Optional[str] = None,
        waveform_fingerprint: Optional[str] = None,
        waveform_version: int = 1,
    ) -> bool:
        """
        更新波形峰值数据

        Args:
            path: 文件路径
            peaks: 波形峰值列表

        Returns:
            是否成功
        """
        try:
            if not peaks or not all(
                isinstance(value, (int, float)) and math.isfinite(value) and 0 <= value <= 1
                for value in peaks
            ):
                raise ValueError("waveform peaks must be a non-empty finite [0,1] array")
            peaks_json = json.dumps(peaks)
            canonical_path = canonicalize_path(path)
            source_fingerprint = source_fingerprint or make_source_fingerprint(path)
            effective_project = project_id or 'default'
            now = datetime.now().isoformat()
            with self.get_cursor() as cursor:
                if project_id:
                    existing_row = cursor.execute(
                        """
                        SELECT file_uuid, project_id, source_fingerprint
                        FROM files WHERE canonical_path=? AND project_id=?
                        LIMIT 1
                        """,
                        (canonical_path, project_id),
                    ).fetchone()
                else:
                    existing_row = cursor.execute(
                        """
                        SELECT file_uuid, project_id, source_fingerprint
                        FROM files WHERE canonical_path=?
                        LIMIT 1
                        """,
                        (canonical_path,),
                    ).fetchone()
                source_changed = bool(
                    existing_row
                    and existing_row["source_fingerprint"] != source_fingerprint
                )
                if project_id:
                    cursor.execute("""
                        UPDATE files SET peaks_json=?, source_fingerprint=?,
                            waveform_fingerprint=?, waveform_version=?, updated_at=?
                        WHERE canonical_path=? AND project_id=?
                    """, (
                        peaks_json, source_fingerprint, waveform_fingerprint,
                        waveform_version, now, canonical_path, project_id,
                    ))
                else:
                    cursor.execute("""
                        UPDATE files SET peaks_json=?, source_fingerprint=?,
                            waveform_fingerprint=?, waveform_version=?, updated_at=?
                        WHERE canonical_path=?
                    """, (
                        peaks_json, source_fingerprint, waveform_fingerprint,
                        waveform_version, now, canonical_path,
                    ))
                changed = cursor.rowcount > 0
                if changed:
                    file_row = existing_row or cursor.execute("""
                        SELECT file_uuid, project_id, source_fingerprint FROM files
                        WHERE canonical_path=? AND (? IS NULL OR project_id=?)
                        LIMIT 1
                    """, (canonical_path, project_id, project_id)).fetchone()
                    effective_project = file_row["project_id"]
                    if source_changed:
                        # A lazy waveform refresh must not make stale semantic
                        # vectors look current by advancing only files.source_fingerprint.
                        # Keep SQLite as the truth source and queue both vector
                        # artifacts for reconciliation against the new bytes.
                        cursor.execute("""
                            UPDATE file_artifacts
                            SET state='stale', source_fingerprint=?,
                                error_code=NULL, error_message=NULL, updated_at=?
                            WHERE project_id=? AND file_uuid=?
                              AND kind IN ('audio_vector', 'text_vector')
                        """, (
                            source_fingerprint, now, effective_project,
                            file_row["file_uuid"],
                        ))
                    cursor.execute("""
                        INSERT INTO file_artifacts
                        (project_id, file_uuid, kind, state, source_fingerprint,
                         engine_fingerprint, error_code, error_message, updated_at)
                        VALUES (?, ?, 'waveform', 'ready', ?, ?, NULL, NULL, ?)
                        ON CONFLICT(project_id, file_uuid, kind) DO UPDATE SET
                            state='ready', source_fingerprint=excluded.source_fingerprint,
                            engine_fingerprint=excluded.engine_fingerprint,
                            error_code=NULL, error_message=NULL, updated_at=excluded.updated_at
                    """, (
                        effective_project, file_row["file_uuid"], source_fingerprint,
                        waveform_fingerprint, now,
                    ))
            return changed
        except Exception as e:
            _get_logger().error(f"更新波形失败 {path}: {e}")
            return False
    def ai_description_stats(self, project_id: str = None) -> Dict[str, int]:
        """统计 AI 一句话描述完成情况。"""
        try:
            with self.get_cursor() as cursor:
                if project_id:
                    total = cursor.execute(
                        "SELECT COUNT(*) FROM files WHERE project_id = ?",
                        (project_id,),
                    ).fetchone()[0]
                    completed = cursor.execute(
                        "SELECT COUNT(*) FROM files WHERE project_id = ? "
                        "AND ai_description IS NOT NULL AND TRIM(ai_description) != '' "
                        "AND ai_description NOT LIKE '[auto]%'",
                        (project_id,),
                    ).fetchone()[0]
                    auto_count = cursor.execute(
                        "SELECT COUNT(*) FROM files WHERE project_id = ? "
                        "AND ai_description LIKE '[auto]%'",
                        (project_id,),
                    ).fetchone()[0]
                else:
                    total = cursor.execute(
                        "SELECT COUNT(*) FROM files"
                    ).fetchone()[0]
                    completed = cursor.execute(
                        "SELECT COUNT(*) FROM files WHERE ai_description IS NOT NULL "
                        "AND TRIM(ai_description) != '' AND ai_description NOT LIKE '[auto]%'"
                    ).fetchone()[0]
                    auto_count = cursor.execute(
                        "SELECT COUNT(*) FROM files WHERE ai_description LIKE '[auto]%'"
                    ).fetchone()[0]
            return {
                "total": total,
                "completed": completed,
                "auto_count": auto_count,
                "remaining": total - completed - auto_count,
            }
        except Exception as e:
            _get_logger().error(f"统计 AI 描述失败: {e}")
            return {"total": 0, "completed": 0, "auto_count": 0, "remaining": 0}
    def rename_file(self, path: str, new_name: str, project_id: str = None) -> bool:
        """更新数据库中的文件名记录（磁盘重命名由调用方完成）。

        Args:
            path: 原文件路径
            new_name: 新文件名（含扩展名）

        Returns:
            是否成功
        """
        try:
            canonical_path = canonicalize_path(path)
            now = datetime.now().isoformat()
            with self.get_cursor() as cursor:
                if project_id:
                    cursor.execute(
                        "UPDATE files SET filename = ?, updated_at = ?"
                        " WHERE canonical_path = ? AND project_id = ?",
                        (new_name, now, canonical_path, project_id),
                    )
                else:
                    cursor.execute(
                        "UPDATE files SET filename = ?, updated_at = ?"
                        " WHERE canonical_path = ?",
                        (new_name, now, canonical_path),
                    )
                changed = cursor.rowcount > 0
                if changed:
                    cursor.execute(
                        "UPDATE file_artifacts SET state='stale', error_code=NULL,"
                        " error_message=NULL, updated_at=? WHERE kind='text_vector'"
                        " AND file_uuid IN (SELECT file_uuid FROM files"
                        " WHERE canonical_path=? AND (? IS NULL OR project_id=?))",
                        (now, canonical_path, project_id, project_id),
                    )
            return changed
        except Exception as e:
            _get_logger().error(f"更新文件名失败 {path}: {e}")
            return False
    def delete_file(self, path: str, project_id: str = None) -> bool:
        """
        删除文件记录

        Args:
            path: 文件路径

        Returns:
            是否成功删除
        """
        canonical_path = canonicalize_path(path)
        self._invalidate_similar_cache(project_id)
        with self.get_cursor() as cursor:
            if project_id:
                cursor.execute(
                    "DELETE FROM files WHERE canonical_path = ? AND project_id = ?",
                    (canonical_path, project_id),
                )
            else:
                cursor.execute("DELETE FROM files WHERE canonical_path = ?", (canonical_path,))
            return cursor.rowcount > 0
    def delete_files_by_uuids(self, project_id: str, file_uuids: Iterable[str]) -> int:  # noqa: D401
        """按 file_uuid 批量删记录（files + artifacts + FTS），返回删除行数。

        比 delete_file(path) 可靠：路径的规范形式（斜杠方向）和库里存的可能不一致，
        用 uuid 不会因为斜杠方向不一致而匹配不上。
        """
        selected = [str(u) for u in dict.fromkeys(file_uuids) if u]
        if not selected:
            return 0
        removed = 0
        for offset in range(0, len(selected), 400):
            batch = selected[offset:offset + 400]
            marks = ",".join("?" for _ in batch)
            with self.get_cursor() as cursor:
                cursor.execute(
                    f"DELETE FROM file_artifacts WHERE project_id=? AND file_uuid IN ({marks})",
                    (str(project_id), *batch),
                )
                try:
                    cursor.execute(
                        f"DELETE FROM files_fts WHERE file_uuid IN ({marks})", tuple(batch)
                    )
                except Exception:
                    pass
                cursor.execute(
                    f"DELETE FROM files WHERE project_id=? AND file_uuid IN ({marks})",
                    (str(project_id), *batch),
                )
                removed += cursor.rowcount
        if removed:
            self._invalidate_similar_cache(project_id)
        return removed
    def get_broken_files(self, project_id: str = "default") -> List[Dict[str, Any]]:
        """列出所有索引失败的损坏文件（artifact state=failed）。

        每个文件聚合其失败的 artifact（waveform/audio_vector 等）与错误码。
        """
        with self.get_cursor() as cursor:
            cursor.execute(
                """
                SELECT DISTINCT f.file_uuid, f.path, f.filename, f.file_size,
                                f.duration
                FROM file_artifacts a
                JOIN files f ON f.file_uuid = a.file_uuid AND f.project_id = a.project_id
                WHERE a.project_id = ? AND a.state = 'failed'
                ORDER BY f.path
                """,
                (project_id,),
            )
            file_rows = cursor.fetchall()
            if not file_rows:
                return []
            uuids = [r["file_uuid"] for r in file_rows]
            placeholders = ",".join("?" * len(uuids))
            cursor.execute(
                f"""
                SELECT file_uuid, kind, error_code, error_message
                FROM file_artifacts
                WHERE project_id = ? AND file_uuid IN ({placeholders}) AND state = 'failed'
                ORDER BY kind
                """,
                (project_id, *uuids),
            )
            artifact_rows = cursor.fetchall()
        artifacts_by_uuid: Dict[str, List[Dict[str, Any]]] = {}
        for ar in artifact_rows:
            artifacts_by_uuid.setdefault(ar["file_uuid"], []).append(
                {
                    "kind": ar["kind"],
                    "error_code": ar["error_code"],
                    "error_message": ar["error_message"],
                }
            )
        result = []
        for fr in file_rows:
            result.append(
                {
                    "file_uuid": fr["file_uuid"],
                    "path": fr["path"],
                    "filename": fr["filename"],
                    "file_size": fr["file_size"] or 0,
                    "duration": fr["duration"] or 0.0,
                    "format": Path(fr["path"] or "").suffix.lower().lstrip("."),
                    "failed_artifacts": artifacts_by_uuid.get(fr["file_uuid"], []),
                }
            )
        return result
    def search_files(self, keyword: str) -> List[AudioFileRecord]:
        """
        搜索文件（按文件名和标签）

        Args:
            keyword: 搜索关键词

        Returns:
            匹配的文件列表
        """
        with self.get_cursor() as cursor:
            cursor.execute("""
                SELECT * FROM files 
                WHERE filename LIKE ? OR tags LIKE ?
                ORDER BY created_at DESC
            """, (f'%{keyword}%', f'%{keyword}%'))
            return [self._row_to_record(row) for row in cursor.fetchall()]
    def get_file_count(self, project_id: Optional[str] = None) -> int:
        """
        获取文件总数

        Returns:
            文件数量
        """
        with self.get_cursor() as cursor:
            if project_id:
                cursor.execute("SELECT COUNT(*) FROM files WHERE project_id=?", (project_id,))
            else:
                cursor.execute("SELECT COUNT(*) FROM files")
            return cursor.fetchone()[0]
    def get_file_ids_by_paths(self, paths, project_id: str) -> Dict[str, str]:
        """一次查出多个路径对应的 file_uuid，避免搜索结果逐条查库。"""
        wanted = [str(p) for p in paths if p]
        if not wanted:
            return {}
        mapping: Dict[str, str] = {}
        with self.get_cursor() as cursor:
            for start in range(0, len(wanted), 400):
                chunk = wanted[start:start + 400]
                marks = ",".join("?" * len(chunk))
                cursor.execute(
                    f"SELECT path, file_uuid FROM files WHERE project_id = ? AND path IN ({marks})",
                    [project_id, *chunk],
                )
                for path, file_uuid in cursor.fetchall():
                    mapping[path] = file_uuid
        return mapping
    def list_library_roots(self, project_id: str) -> List[str]:
        r"""列出库的真实根目录（按盘符分组后取公共前缀）。

        原来取「路径前两段」，`D:\回声AI音效管理器\CJ音效库整合包V2\x.wav`
        会被算成 `D:\回声AI音效管理器` —— 于是「重新读取目录」扫的是父目录，
        把同级的 AI生成音效 / 克隆测试 也扫进来，还提示补录（11-02 用户实测 9 个）。
        """
        by_drive: dict = {}
        with self.get_cursor() as cursor:
            for (path,) in cursor.execute("SELECT path FROM files WHERE project_id=?", (str(project_id),)):
                if not path:
                    continue
                drive, _rest = os.path.splitdrive(str(path))
                by_drive.setdefault(drive or '', []).append(str(path))
        roots: List[str] = []
        for _drive, items in by_drive.items():
            try:
                common = os.path.commonpath(items)
            except ValueError:
                common = os.path.dirname(items[0])
            # 公共前缀可能落在某个文件上（库里只有一个文件时），退一级到目录
            if not os.path.isdir(common):
                common = os.path.dirname(common)
            if common and os.path.isdir(common):
                roots.append(common)
        return sorted(set(roots))
    def get_file_identities(self, project_id: str) -> List[tuple]:
        """只取 (file_uuid, path, source_fingerprint)，给索引对账用。

        `get_files_by_project` 会把每行构造成 AudioFileRecord：实测 6.5 万条要
        12.7 秒，光这一步就把事件循环按住十几秒（B3 的元凶）。
        这里只走 SQL + 元组，同样 6.5 万条约 1 秒。
        """
        with self.get_cursor() as cursor:
            rows = cursor.execute(
                "SELECT file_uuid, path, source_fingerprint FROM files WHERE project_id=?",
                (str(project_id),),
            ).fetchall()
        return [(row[0], row[1], row[2]) for row in rows]
