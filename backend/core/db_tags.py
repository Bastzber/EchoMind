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


class TagsMixin:
    def _ensure_tag_layers(self, cursor) -> None:
        """M4：标签双层表 + 首次迁移（files.tags → tags/file_tags）。"""
        try:
            from core import tag_layers

            tag_layers.ensure_schema(cursor)
            marker = cursor.execute(
                "SELECT value FROM app_meta WHERE key='tag_migrated_v1'"
            ).fetchone()
            if marker:
                return
            linked = tag_layers.migrate_from_files(cursor)
            cursor.execute(
                "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('tag_migrated_v1', ?)",
                (str(linked),),
            )
            cursor.connection.commit()
            _get_logger().info("[Tags] 双层标签迁移完成，关联 %s 条", linked)
        except Exception as exc:
            _get_logger().warning("[Tags] 双层标签初始化失败: %s", exc)
    def _user_tag_text(self, cursor, project_id: str, file_uuid: str) -> str:
        """「我的标签」拼成文本，供 FTS 收录（系统标签 + 用户标签都能搜到）。"""
        try:
            rows = cursor.execute(
                "SELECT t.name FROM file_tags ft "
                "JOIN tags t ON t.id = ft.tag_id AND t.project_id = ft.project_id "
                "WHERE ft.project_id=? AND ft.file_uuid=?",
                (str(project_id), str(file_uuid)),
            ).fetchall()
        except Exception:
            return ""
        return " ".join(str(r[0]) for r in rows if r[0])
    def update_tags(self, path: str, tags: List[str], project_id: str = None) -> bool:
        """
        更新文件标签

        Args:
            path: 文件路径
            tags: 标签列表

        Returns:
            是否成功
        """
        try:
            tags_json = json.dumps(tags)
            canonical_path = canonicalize_path(path)
            now = datetime.now().isoformat()
            with self.get_cursor() as cursor:
                if project_id:
                    cursor.execute("""
                        UPDATE files SET tags = ?, updated_at = ?
                        WHERE canonical_path = ? AND project_id = ?
                    """, (tags_json, now, canonical_path, project_id))
                else:
                    cursor.execute("""
                        UPDATE files SET tags = ?, updated_at = ?
                        WHERE canonical_path = ?
                    """, (tags_json, now, canonical_path))
                changed = cursor.rowcount > 0
                if changed:
                    cursor.execute("""
                        UPDATE file_artifacts SET state='stale', error_code=NULL,
                            error_message=NULL, updated_at=?
                        WHERE kind='text_vector' AND file_uuid IN (
                            SELECT file_uuid FROM files
                            WHERE canonical_path=? AND (? IS NULL OR project_id=?)
                        )
                    """, (now, canonical_path, project_id, project_id))
            if changed:
                self._sync_fts_for_path(canonical_path, project_id)
                # 标签/描述改了，「找相似」的词表要重建（签名检查也会兜住）
                self._invalidate_similar_cache(project_id)
            return changed
        except Exception as e:
            _get_logger().error(f"更新标签失败 {path}: {e}")
            return False
    def list_all_tags(self, project_id: str = None) -> List[Dict[str, Any]]:
        """统计工程内所有标签及使用次数，按次数降序返回。

        Returns:
            [{"name": "钟声", "count": 12}, ...]
        """
        # json_each 版本在 19.5 万行上仍要 2.1 秒（库内展开不便宜）。
        # 标签统计变化很慢，缓存 60 秒；改标签时会主动失效。
        now = time.monotonic()
        cached = getattr(self, '_all_tags_cache', None)
        if cached and cached.get('project_id') == (project_id or '') and now - cached.get('at', 0) < 60.0:
            return [dict(item) for item in cached['value']]

        counts: Dict[str, int] = {}
        try:
            with self.get_cursor() as cursor:
                # 原来是拉 6.5 万行 JSON 进 Python 逐条 json.loads；
                # json_each 在库内展开语法更干净、结果一致，但耗时相近。
                # 改成 SQLite 的 json_each 在库内展开 + GROUP BY，数据不进 Python。
                # json_valid 挡掉坏 JSON（否则整条查询直接报错），
                # trim 保留原来的去空格语义，CAST 保住数字标签当字符串的行为。
                if project_id:
                    rows = cursor.execute(
                        """
                        SELECT trim(CAST(j.value AS TEXT)) AS name, COUNT(*) AS c
                        FROM files f, json_each(f.tags) j
                        WHERE f.project_id = ?
                          AND json_valid(f.tags)
                          AND j.value IS NOT NULL
                          AND trim(CAST(j.value AS TEXT)) != ''
                        GROUP BY name
                        """,
                        (project_id,),
                    ).fetchall()
                else:
                    rows = cursor.execute(
                        """
                        SELECT trim(CAST(j.value AS TEXT)) AS name, COUNT(*) AS c
                        FROM files f, json_each(f.tags) j
                        WHERE json_valid(f.tags)
                          AND j.value IS NOT NULL
                          AND trim(CAST(j.value AS TEXT)) != ''
                        GROUP BY name
                        """,
                    ).fetchall()
            for name, count in rows:
                if name:
                    counts[str(name)] = int(count)
        except Exception as e:
            _get_logger().error(f"统计标签失败: {e}")
        result = [{"name": name, "count": count} for name, count in counts.items()]
        result.sort(key=lambda item: (-item["count"], item["name"]))
        self._all_tags_cache = {
            'project_id': project_id or '',
            'at': time.monotonic(),
            'value': [dict(item) for item in result],
        }
        return result
    def invalidate_all_tags(self) -> None:
        """标签变了就清缓存（保存标签、批量改标签后调用）。"""
        self._all_tags_cache = None
    def rename_tag(self, project_id: str, old: str, new: str) -> int:
        """全局重命名标签：把所有文件中的 old 替换为 new。

        Returns:
            受影响文件数
        """
        old = str(old or "").strip()
        new = str(new or "").strip()
        if not old or not new:
            return 0
        changed_count = 0
        try:
            now = datetime.now().isoformat()
            with self.get_cursor() as cursor:
                if project_id:
                    rows = cursor.execute(
                        "SELECT file_uuid, tags FROM files WHERE project_id = ?",
                        (project_id,),
                    ).fetchall()
                else:
                    rows = cursor.execute("SELECT file_uuid, tags FROM files").fetchall()
                for file_uuid, tags_json in rows:
                    try:
                        tags = json.loads(tags_json or "[]")
                    except Exception:
                        continue
                    if not isinstance(tags, list):
                        continue
                    new_tags = []
                    changed = False
                    for tag in tags:
                        if str(tag) == old:
                            new_tags.append(new)
                            changed = True
                        else:
                            new_tags.append(tag)
                    if changed:
                        cursor.execute(
                            "UPDATE files SET tags = ?, updated_at = ? WHERE file_uuid = ?",
                            (json.dumps(new_tags, ensure_ascii=False), now, file_uuid),
                        )
                        cursor.execute(
                            "UPDATE file_artifacts SET state='stale', error_code=NULL,"
                            " error_message=NULL, updated_at=? WHERE kind='text_vector'"
                            " AND file_uuid=?",
                            (now, file_uuid),
                        )
                        changed_count += 1
        except Exception as e:
            _get_logger().error(f"重命名标签失败 {old} -> {new}: {e}")
        return changed_count
    def delete_tag(self, project_id: str, tag: str) -> int:
        """全局删除标签：从所有文件中移除指定标签。

        Returns:
            受影响文件数
        """
        tag = str(tag or "").strip()
        if not tag:
            return 0
        changed_count = 0
        try:
            now = datetime.now().isoformat()
            with self.get_cursor() as cursor:
                if project_id:
                    rows = cursor.execute(
                        "SELECT file_uuid, tags FROM files WHERE project_id = ?",
                        (project_id,),
                    ).fetchall()
                else:
                    rows = cursor.execute("SELECT file_uuid, tags FROM files").fetchall()
                for file_uuid, tags_json in rows:
                    try:
                        tags = json.loads(tags_json or "[]")
                    except Exception:
                        continue
                    if not isinstance(tags, list):
                        continue
                    if tag not in [str(t) for t in tags]:
                        continue
                    new_tags = [t for t in tags if str(t) != tag]
                    cursor.execute(
                        "UPDATE files SET tags = ?, updated_at = ? WHERE file_uuid = ?",
                        (json.dumps(new_tags, ensure_ascii=False), now, file_uuid),
                    )
                    cursor.execute(
                        "UPDATE file_artifacts SET state='stale', error_code=NULL,"
                        " error_message=NULL, updated_at=? WHERE kind='text_vector'"
                        " AND file_uuid=?",
                        (now, file_uuid),
                    )
                    changed_count += 1
        except Exception as e:
            _get_logger().error(f"删除标签失败 {tag}: {e}")
        return changed_count
    def sync_tags_from_layers(self, project_id: str, file_uuid: str) -> bool:
        """把双层标签（tags/file_tags）的标签名回写到 files.tags。

        列表显示、FTS、以及文本向量的输入都读 files.tags 这一列；分层标签接口
        只写 file_tags 的话，改完标签列表里看不到、搜索也搜不到。写完顺手把
        这一行的文本向量标脏并同步 FTS —— 跟改描述一样。
        """
        try:
            now = datetime.now().isoformat()
            with self.get_cursor() as cursor:
                rows = cursor.execute(
                    """
                    SELECT t.name FROM file_tags ft
                    JOIN tags t ON t.id = ft.tag_id
                    WHERE ft.project_id=? AND ft.file_uuid=?
                    ORDER BY t.name
                    """,
                    (project_id, file_uuid),
                ).fetchall()
                names = [str(r[0]) for r in rows if r and r[0]]
                cursor.execute(
                    "UPDATE files SET tags=?, updated_at=? WHERE project_id=? AND file_uuid=?",
                    (json.dumps(names, ensure_ascii=False), now, project_id, file_uuid),
                )
                changed = cursor.rowcount > 0
                if changed:
                    cursor.execute(
                        """
                        UPDATE file_artifacts SET state='stale', error_code=NULL,
                            error_message=NULL, updated_at=?
                        WHERE project_id=? AND file_uuid=? AND kind='text_vector'
                        """,
                        (now, project_id, file_uuid),
                    )
            if changed:
                self.update_fts_row(project_id, file_uuid)
                self._invalidate_similar_cache(project_id)
            return changed
        except Exception as e:
            _get_logger().error(f"回写标签失败 {file_uuid}: {e}")
            return False
    def _files_touched_by_tag(self, cursor, project_id: str, tag_id: str) -> List[str]:
        return [
            row[0]
            for row in cursor.execute(
                "SELECT file_uuid FROM file_tags WHERE project_id=? AND tag_id=?",
                (str(project_id), str(tag_id)),
            )
        ]
    def rename_tag_by_name(self, project_id: str, old_name: str, new_name: str) -> Dict[str, int]:
        """按名字改名；如果新名字已存在就合并成一个标签。返回 {renamed, merged, files}。"""
        old_name = str(old_name or "").strip()
        new_name = str(new_name or "").strip()
        if not old_name or not new_name or old_name == new_name:
            return {"renamed": 0, "merged": 0, "files": 0}

        from core import tag_layers

        files: List[str] = []
        merged = 0
        with self.get_cursor() as cursor:
            old_row = cursor.execute(
                "SELECT id FROM tags WHERE project_id=? AND name=?",
                (str(project_id), old_name),
            ).fetchone()
            if not old_row:
                return {"renamed": 0, "merged": 0, "files": 0}
            old_id = old_row[0]

            new_row = cursor.execute(
                "SELECT id FROM tags WHERE project_id=? AND name=?",
                (str(project_id), new_name),
            ).fetchone()

            if new_row:
                # 合并：把 old 的文件关联指向 new，然后删掉 old
                new_id = new_row[0]
                files = self._files_touched_by_tag(cursor, project_id, old_id)
                cursor.execute(
                    "INSERT OR IGNORE INTO file_tags (project_id, file_uuid, tag_id, created_at) "
                    "SELECT project_id, file_uuid, ?, created_at FROM file_tags WHERE project_id=? AND tag_id=?",
                    (new_id, str(project_id), old_id),
                )
                cursor.execute(
                    "DELETE FROM file_tags WHERE project_id=? AND tag_id=?",
                    (str(project_id), old_id),
                )
                cursor.execute("DELETE FROM tags WHERE id=?", (old_id,))
                merged = 1
            else:
                files = self._files_touched_by_tag(cursor, project_id, old_id)
                cursor.execute("UPDATE tags SET name=? WHERE id=?", (new_name, old_id))

        return {"renamed": 0 if merged else 1, "merged": merged, "files": len(files)}
    def delete_tag_by_name(self, project_id: str, name: str) -> Dict[str, int]:
        """删除「我的标签」里的一个标签（只动 tags/file_tags）。

        注意：这是**用户自定义标签**，和 files.tags 里的 6 维标签是两套东西，
        删这里不会改动音效自带的标签。以前逐文件回写 files.tags，标签挂几千个
        文件时界面会卡死；现在只有两条 DELETE，毫秒级。
        """
        name = str(name or "").strip()
        if not name:
            return {"deleted": 0, "files": 0}
        with self.get_cursor() as cursor:
            rows = cursor.execute(
                "SELECT id, project_id FROM tags WHERE project_id=? AND name=?",
                (str(project_id), name),
            ).fetchall()
            if not rows:
                # 老数据里标签可能建在 default 工程（创建时没带 project_id），
                # 而删除按当前工程过滤，于是一条都删不掉。这里退回按名字全局找。
                rows = cursor.execute(
                    "SELECT id, project_id FROM tags WHERE name=?", (name,)
                ).fetchall()
                if rows:
                    logger.info(
                        "[Tags] 标签「%s」不在工程 %s 下，改为按 id 删除（属于 %s）",
                        name, project_id, rows[0][1],
                    )
            if not rows:
                return {"deleted": 0, "files": 0}
            total_files = 0
            for tag_id, owner in rows:
                total_files += len(self._files_touched_by_tag(cursor, owner, tag_id))
                cursor.execute(
                    "DELETE FROM file_tags WHERE project_id=? AND tag_id=?",
                    (str(owner), tag_id),
                )
                cursor.execute("DELETE FROM tags WHERE id=?", (tag_id,))
        return {"deleted": len(rows), "files": total_files}
    def list_tag_usage(self, project_id: str) -> List[Dict[str, Any]]:
        """标签 + 使用次数，按次数降序（用于标签管理面板）。"""
        with self.get_cursor() as cursor:
            rows = cursor.execute(
                """
                SELECT t.id, t.name, t.layer, COUNT(ft.file_uuid) AS usage
                FROM tags t
                LEFT JOIN file_tags ft ON ft.project_id = t.project_id AND ft.tag_id = t.id
                WHERE t.project_id = ?
                GROUP BY t.id
                ORDER BY usage DESC, t.name
                """,
                (str(project_id),),
            ).fetchall()
        return [
            {"id": row[0], "name": row[1], "layer": row[2], "usage": int(row[3] or 0)}
            for row in rows
        ]
    def sync_layers_from_files_tags(
        self,
        project_id: str,
        *,
        path: Optional[str] = None,
        file_uuid: Optional[str] = None,
    ) -> int:
        """把 files.tags 的标签名同步到 tags/file_tags（老标签入口写完时调用）。

        反方向（分层 → files.tags）在 sync_tags_from_layers 里；两边都跑，
        列表、搜索、侧栏标签树才不会各看各的。
        """
        from core import tag_layers

        try:
            now = datetime.now().isoformat()
            with self.get_cursor() as cursor:
                if file_uuid:
                    row = cursor.execute(
                        "SELECT file_uuid, tags FROM files WHERE project_id=? AND file_uuid=?",
                        (project_id, file_uuid),
                    ).fetchone()
                else:
                    row = cursor.execute(
                        "SELECT file_uuid, tags FROM files WHERE project_id=? AND canonical_path=?",
                        (project_id, canonicalize_path(path or "")),
                    ).fetchone()
                if not row:
                    return 0

                target_uuid = row["file_uuid"]
                try:
                    raw = json.loads(row["tags"] or "[]")
                except (TypeError, ValueError):
                    raw = []
                names = [str(name).strip() for name in (raw if isinstance(raw, list) else []) if str(name).strip()]

                existing = {
                    name: tag_id
                    for tag_id, name in cursor.execute(
                        "SELECT id, name FROM tags WHERE project_id=?", (project_id,)
                    ).fetchall()
                }
                cursor.execute(
                    "DELETE FROM file_tags WHERE project_id=? AND file_uuid=?",
                    (project_id, target_uuid),
                )
                for name in names:
                    tag_id = existing.get(name)
                    if not tag_id:
                        tag_id = "tag_" + uuid.uuid4().hex[:10]
                        cursor.execute(
                            "INSERT OR IGNORE INTO tags "
                            "(id, project_id, name, layer, sort_order, created_at) "
                            "VALUES (?,?,?,?,?,?)",
                            (tag_id, project_id, name, tag_layers.LAYER_ATTR, 0, now),
                        )
                        existing[name] = tag_id
                    cursor.execute(
                        "INSERT OR IGNORE INTO file_tags "
                        "(project_id, file_uuid, tag_id, created_at) VALUES (?,?,?,?)",
                        (project_id, target_uuid, tag_id, now),
                    )
                return len(names)
        except Exception as exc:
            _get_logger().error(f"同步标签到分层表失败: {exc}")
            return 0
    def list_file_uuids_by_tag(self, project_id: str, tag_id: str) -> List[str]:
        with self.get_cursor() as cursor:
            return [
                str(r[0])
                for r in cursor.execute(
                    "SELECT file_uuid FROM file_tags WHERE project_id=? AND tag_id=?",
                    (project_id, tag_id),
                ).fetchall()
            ]
