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


class ProjectsMixin:
    def _ensure_user_folder_files_table(self, cursor) -> None:
        """用户文件夹的「单个音效」成员表（区别于整目录映射）。"""
        try:
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS user_folder_files (
                    project_id TEXT NOT NULL,
                    folder_id  TEXT NOT NULL,
                    file_uuid  TEXT NOT NULL,
                    created_at TEXT,
                    PRIMARY KEY (project_id, folder_id, file_uuid)
                )
                """
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_uff_folder ON user_folder_files(project_id, folder_id)"
            )
        except Exception as exc:
            _get_logger().warning("创建 user_folder_files 失败: %s", exc)
    def add_files_to_user_folder(self, project_id: str, folder_id: str, paths: List[str]) -> int:
        """把若干文件路径加入用户文件夹，返回新增数量。"""
        if not paths:
            return 0
        now = datetime.now().isoformat()
        added = 0
        with self.get_cursor() as cursor:
            for path in paths:
                row = cursor.execute(
                    "SELECT file_uuid FROM files WHERE project_id=? AND canonical_path=?",
                    (str(project_id), canonicalize_path(path)),
                ).fetchone()
                if not row:
                    continue
                cursor.execute(
                    "INSERT OR IGNORE INTO user_folder_files "
                    "(project_id, folder_id, file_uuid, created_at) VALUES (?,?,?,?)",
                    (str(project_id), str(folder_id), row[0], now),
                )
                added += cursor.rowcount
            cursor.connection.commit()
        return added
    def remove_file_from_user_folder(self, project_id: str, folder_id: str, file_uuid: str) -> bool:
        with self.get_cursor() as cursor:
            cursor.execute(
                "DELETE FROM user_folder_files WHERE project_id=? AND folder_id=? AND file_uuid=?",
                (str(project_id), str(folder_id), str(file_uuid)),
            )
            changed = cursor.rowcount > 0
            cursor.connection.commit()
        return changed
    def list_files_in_user_folder(self, project_id: str, folder_id: str) -> List[Dict[str, Any]]:
        with self.get_cursor() as cursor:
            rows = cursor.execute(
                """
                SELECT f.file_uuid, f.path, f.filename, f.duration, f.file_size,
                       f.sample_rate, f.channels, f.tags, f.ai_description
                FROM user_folder_files u
                JOIN files f ON f.file_uuid = u.file_uuid AND f.project_id = u.project_id
                WHERE u.project_id=? AND u.folder_id=?
                ORDER BY u.created_at DESC
                """,
                (str(project_id), str(folder_id)),
            ).fetchall()
        return [
            {
                "id": r[0],
                "file_uuid": r[0],
                "file_id": r[0],
                "path": r[1],
                "file_path": r[1],
                "filename": r[2],
                "duration": r[3],
                "size": r[4],
                "file_size": r[4],
                "sample_rate": r[5],
                "channels": r[6],
                "tags": _parse_tags(r[7]),
                "ai_description": r[8],
                "format": (r[2].rsplit(".", 1)[-1].lower() if r[2] and "." in r[2] else ""),
            }
            for r in rows
        ]
    def folder_stats(self, project_id: str, folder: str) -> Dict[str, int]:
        """统计某目录（含子目录）的文件数、有描述数、有标签数、总大小。"""
        prefix = str(folder).rstrip('\\/') + '\\'
        with self.get_cursor() as cursor:
            row = cursor.execute(
                """
                SELECT COUNT(*),
                       SUM(CASE WHEN ai_description IS NOT NULL
                                 AND TRIM(ai_description) != ''
                                 AND ai_description NOT LIKE '[auto]%' THEN 1 ELSE 0 END),
                       SUM(CASE WHEN tags IS NOT NULL AND tags != '[]' THEN 1 ELSE 0 END),
                       COALESCE(SUM(file_size), 0)
                FROM files
                WHERE project_id=? AND substr(path,1,length(?))=?
                """,
                (str(project_id), prefix, prefix),
            ).fetchone()
        return {
            "files": int(row[0] or 0),
            "with_description": int(row[1] or 0),
            "with_tags": int(row[2] or 0),
            "size_bytes": int(row[3] or 0),
        }
    def delete_files_in_folder(self, project_id: str, folder: str) -> List[Dict[str, str]]:
        """删除目录下所有文件记录（含 artifacts / FTS 行），返回被删文件列表。"""
        prefix = str(folder).rstrip('\\/') + '\\'
        with self.get_cursor() as cursor:
            rows = cursor.execute(
                "SELECT file_uuid, path FROM files "
                "WHERE project_id=? AND substr(path,1,length(?))=?",
                (str(project_id), prefix, prefix),
            ).fetchall()
        records = [{"file_uuid": r[0], "path": r[1]} for r in rows]
        if not records:
            return []
        with self.get_cursor() as cursor:
            for start in range(0, len(records), 400):
                chunk = records[start:start + 400]
                marks = ",".join("?" * len(chunk))
                uuids = [item["file_uuid"] for item in chunk]
                cursor.execute(
                    f"DELETE FROM file_artifacts WHERE project_id=? AND file_uuid IN ({marks})",
                    (str(project_id), *uuids),
                )
                cursor.execute(
                    f"DELETE FROM files WHERE project_id=? AND file_uuid IN ({marks})",
                    (str(project_id), *uuids),
                )
                try:
                    cursor.execute(
                        f"DELETE FROM files_fts WHERE file_uuid IN ({marks})", uuids
                    )
                except Exception:
                    pass
            cursor.connection.commit()
        return records
    def count_files_in_folder(self, project_id: str, folder: str) -> int:
        """统计某目录（含子目录）下的文件数。"""
        prefix = str(folder).rstrip('\\/') + '\\'
        with self.get_cursor() as cursor:
            row = cursor.execute(
                "SELECT COUNT(*) FROM files WHERE project_id=? AND substr(path,1,length(?))=?",
                (project_id, prefix, prefix),
            ).fetchone()
        return int(row[0] if row else 0)
    def get_files_by_folder(self, folder_path: str, project_id: str = None) -> List[AudioFileRecord]:
        """
        获取指定文件夹下的所有文件

        Args:
            folder_path: 文件夹路径

        Returns:
            文件列表
        """
        canonical_folder = canonicalize_path(folder_path).rstrip("/\\")
        escaped = canonical_folder.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"{escaped}/%"
        with self.get_cursor() as cursor:
            if project_id:
                cursor.execute("""
                    SELECT * FROM files
                    WHERE (canonical_path = ? OR canonical_path LIKE ? ESCAPE '\\')
                      AND project_id = ?
                    ORDER BY filename
                """, (canonical_folder, pattern, project_id))
            else:
                cursor.execute("""
                    SELECT * FROM files
                    WHERE canonical_path = ? OR canonical_path LIKE ? ESCAPE '\\'
                    ORDER BY filename
                """, (canonical_folder, pattern))
            return [self._row_to_record(row) for row in cursor.fetchall()]
    def remove_files_by_folder(self, folder_path: str, project_id: str = None) -> int:
        """
        删除指定文件夹下的所有文件记录

        Args:
            folder_path: 文件夹路径

        Returns:
            删除的文件数量
        """
        canonical_folder = canonicalize_path(folder_path).rstrip("/\\")
        escaped = canonical_folder.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"{escaped}/%"
        with self.get_cursor() as cursor:
            if project_id:
                cursor.execute("""
                    DELETE FROM files
                    WHERE (canonical_path = ? OR canonical_path LIKE ? ESCAPE '\\')
                      AND project_id = ?
                """, (canonical_folder, pattern, project_id))
            else:
                cursor.execute("""
                    DELETE FROM files
                    WHERE canonical_path = ? OR canonical_path LIKE ? ESCAPE '\\'
                """, (canonical_folder, pattern))
            return cursor.rowcount
    def mark_project_artifacts(
        self, project_id: str, kinds: Iterable[str], state: str = "stale"
    ) -> int:
        selected_kinds = tuple(kind for kind in kinds if kind in ARTIFACT_KINDS)
        if not selected_kinds or state not in ARTIFACT_STATES:
            return 0
        placeholders = ",".join("?" for _ in selected_kinds)
        with self.get_cursor() as cursor:
            cursor.execute(f"""
                UPDATE file_artifacts
                SET state=?, error_code=NULL, error_message=NULL, updated_at=?
                WHERE project_id=? AND kind IN ({placeholders})
            """, (
                state, datetime.now().isoformat(), project_id, *selected_kinds,
            ))
            return cursor.rowcount
    def mark_text_artifacts_for_folders(
        self,
        project_id: str,
        folder_paths: Iterable[str],
        state: str = "stale",
    ) -> int:
        """Invalidate text artifacts for files under any mapped folder.

        Matching happens against canonical path keys in Python and updates use
        exact file UUIDs.  This keeps Windows drive/case/separator semantics
        consistent while treating literal ``%`` and ``_`` path characters as
        ordinary filename characters.
        """
        if state not in ARTIFACT_STATES:
            raise ValueError(f"invalid artifact state: {state}")
        roots = {
            canonicalize_path(folder_path).rstrip("/\\")
            for folder_path in folder_paths
            if str(folder_path or "").strip()
        }
        roots.discard("")
        if not roots:
            return 0

        with self.get_cursor() as cursor:
            rows = cursor.execute(
                "SELECT file_uuid, canonical_path FROM files WHERE project_id=?",
                (project_id,),
            ).fetchall()
            affected = [
                str(row["file_uuid"])
                for row in rows
                if any(
                    canonical_path_is_within(row["canonical_path"], root)
                    for root in roots
                )
            ]
            if not affected:
                return 0

            now = datetime.now().isoformat()
            updated = 0
            # Stay comfortably below SQLite's default host-parameter limit.
            for offset in range(0, len(affected), 400):
                batch = affected[offset:offset + 400]
                placeholders = ",".join("?" for _ in batch)
                cursor.execute(f"""
                    UPDATE file_artifacts
                    SET state=?, error_code=NULL, error_message=NULL, updated_at=?
                    WHERE project_id=? AND kind='text_vector'
                      AND file_uuid IN ({placeholders})
                """, (state, now, project_id, *batch))
                updated += cursor.rowcount
            return updated
    def create_project(self, project_id: str, name: str, description: str = "", temp_dir: Optional[str] = None) -> bool:
        """
        创建新工程

        Args:
            project_id: 工程唯一ID
            name: 工程名称
            description: 工程描述
            temp_dir: 工程特定的临时文件目录

        Returns:
            是否成功
        """
        if not is_safe_project_id(project_id):
            _get_logger().warning(f"拒绝不安全的工程 ID: {project_id!r}")
            return False
        try:
            with self.get_cursor() as cursor:
                cursor.execute("""
                    INSERT INTO projects (id, name, description, temp_dir, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                """, (project_id, name, description, temp_dir, datetime.now().isoformat()))
            return True
        except Exception as e:
            _get_logger().error(f"创建工程失败 {project_id}: {e}")
            return False
    def get_project(self, project_id: str) -> Optional[Dict[str, Any]]:
        """
        获取工程信息

        Args:
            project_id: 工程ID

        Returns:
            工程信息字典
        """
        with self.get_cursor() as cursor:
            cursor.execute("SELECT * FROM projects WHERE id = ?", (project_id,))
            row = cursor.fetchone()
            if row:
                return {
                    'id': row['id'],
                    'name': row['name'],
                    'description': row['description'],
                    'temp_dir': row['temp_dir'],
                    'created_at': row['created_at'],
                    'updated_at': row['updated_at'],
                    'settings': json.loads(row['settings_json'] or '{}')
                }
        return None
    def get_all_projects(self) -> List[Dict[str, Any]]:
        """
        获取所有工程列表

        Returns:
            工程信息列表
        """
        with self.get_cursor() as cursor:
            cursor.execute("SELECT * FROM projects ORDER BY updated_at DESC")
            return [{
                'id': row['id'],
                'name': row['name'],
                'description': row['description'],
                'temp_dir': row['temp_dir'],
                'created_at': row['created_at'],
                'updated_at': row['updated_at'],
                'settings': json.loads(row['settings_json'] or '{}')
            } for row in cursor.fetchall()]
    def update_project(self, project_id: str, name: Optional[str] = None, 
                       description: Optional[str] = None, temp_dir: Optional[str] = None,
                       settings: Optional[Dict] = None) -> bool:
        """
        更新工程信息

        Args:
            project_id: 工程ID
            name: 新名称
            description: 新描述
            temp_dir: 新临时目录
            settings: 新配置

        Returns:
            是否成功
        """
        try:
            with self.get_cursor() as cursor:
                updates = []
                params = []
                if name is not None:
                    updates.append("name = ?")
                    params.append(name)
                if description is not None:
                    updates.append("description = ?")
                    params.append(description)
                if temp_dir is not None:
                    updates.append("temp_dir = ?")
                    params.append(temp_dir)
                if settings is not None:
                    updates.append("settings_json = ?")
                    params.append(json.dumps(settings))
                updates.append("updated_at = ?")
                params.append(datetime.now().isoformat())
                params.append(project_id)

                cursor.execute(f"""
                    UPDATE projects SET {', '.join(updates)} WHERE id = ?
                """, params)
            return True
        except Exception as e:
            _get_logger().error(f"更新工程失败 {project_id}: {e}")
            return False
    def delete_project(self, project_id: str) -> bool:
        """
        删除工程（会级联删除相关文件）

        Args:
            project_id: 工程ID

        Returns:
            是否成功
        """
        # B12：default 也允许删，调用方（API）删完会立刻重建一个空的默认工程，
        # 所以这里不再特判。只挡非法 id。
        if not is_safe_project_id(project_id):
            return False
        # 关掉外键级联，先把子表显式删干净再删主表。
        # 开着 FK 时 SQLite 每条 files 都要做一次级联检查：实测 100 个文件要 29.5 秒，
        # 2 万文件的工程 180 秒都删不完（B11）。显式删子表 500 条只要 0.09 秒。
        connection = self._get_connection()
        previous_fk = 1
        try:
            previous_fk = int(connection.execute("PRAGMA foreign_keys").fetchone()[0] or 0)
            connection.execute("PRAGMA foreign_keys=OFF")
        except Exception:
            previous_fk = 1
        try:
            with self.get_cursor() as cursor:
                for table in (
                    "file_artifacts",
                    "files_fts",
                    "file_tags",
                    "tags",
                    "files",
                    "imported_folder_mappings",
                    "user_folders",
                    "recent_projects",
                    "index_manifests",
                    "jobs",
                ):
                    try:
                        cursor.execute(f"DELETE FROM {table} WHERE project_id = ?", (project_id,))
                    except Exception as table_error:
                        # 老库里可能没有某张表，跳过即可
                        _get_logger().debug(f"删除 {table} 失败（忽略）: {table_error}")
                cursor.execute("DELETE FROM projects WHERE id = ?", (project_id,))
            return True
        except Exception as e:
            _get_logger().error(f"删除工程失败 {project_id}: {e}")
            return False
        finally:
            try:
                connection.execute("PRAGMA foreign_keys=%d" % (1 if previous_fk else 0))
            except Exception:
                pass
    def add_to_recent_projects(self, project_id: str) -> bool:
        """
        添加到最近工程列表

        Args:
            project_id: 工程ID

        Returns:
            是否成功
        """
        max_retries = 3
        for attempt in range(max_retries):
            try:
                with self.get_cursor() as cursor:
                    cursor.execute("""
                        INSERT OR REPLACE INTO recent_projects (project_id, opened_at)
                        VALUES (?, ?)
                    """, (project_id, datetime.now().isoformat()))
                return True
            except sqlite3.Error as e:
                if "acquire_write" in str(e) or "database is locked" in str(e):
                    _get_logger().warning(f"数据库忙，重试 {attempt+1}/{max_retries}: {e}")
                    if attempt == 0:
                        # 第一次失败，尝试修复
                        self._repair_database()
                    import time
                    time.sleep(0.1 * (attempt + 1))  # 递增延迟
                else:
                    _get_logger().error(f"添加最近工程失败 {project_id}: {e}")
                    return False
        return False
    def get_recent_projects(self, limit: int = 10) -> List[Dict[str, Any]]:
        """
        获取最近工程列表

        Args:
            limit: 返回数量

        Returns:
            工程信息列表
        """
        with self.get_cursor() as cursor:
            cursor.execute("""
                SELECT p.* FROM projects p
                JOIN recent_projects r ON p.id = r.project_id
                ORDER BY r.opened_at DESC
                LIMIT ?
            """, (limit,))
            return [{
                'id': row['id'],
                'name': row['name'],
                'description': row['description'],
                'temp_dir': row['temp_dir'],
                'created_at': row['created_at'],
                'updated_at': row['updated_at'],
                'settings': json.loads(row['settings_json'] or '{}')
            } for row in cursor.fetchall()]
    def get_project_file_count(self, project_id: str) -> int:
        """
        获取工程的文件数量

        Args:
            project_id: 工程ID

        Returns:
            文件数量
        """
        with self.get_cursor() as cursor:
            cursor.execute("SELECT COUNT(*) FROM files WHERE project_id = ?", (project_id,))
            return cursor.fetchone()[0]
    def get_folder_counts(self, project_id: str) -> List[tuple]:
        """返回 [(父目录, 直接文件数)]，用于左侧文件夹树。

        直接遍历 files.path 在 Python 侧聚合，比 SQL 里做字符串处理快得多，
        5 万条约 0.2 秒。
        """
        with self.get_cursor() as cursor:
            cursor.execute(
                "SELECT path FROM files WHERE project_id = ?", (project_id,)
            )
            rows = cursor.fetchall()
        counts: dict = {}
        for (path,) in rows:
            if not path:
                continue
            parent = os.path.dirname(str(path))
            if parent:
                counts[parent] = counts.get(parent, 0) + 1
        return list(counts.items())
    def get_files_by_project(self, project_id: str) -> List[AudioFileRecord]:
        """
        获取指定工程的所有文件

        Args:
            project_id: 工程ID

        Returns:
            文件列表
        """
        with self.get_cursor() as cursor:
            cursor.execute("""
                SELECT * FROM files WHERE project_id = ? ORDER BY created_at DESC
            """, (project_id,))
            return [self._row_to_record(row) for row in cursor.fetchall()]
    def add_file_with_project(self, record: AudioFileRecord, project_id: str = 'default') -> bool:
        """
        添加文件到指定工程

        Args:
            record: 音频文件记录
            project_id: 工程ID

        Returns:
            是否成功
        """
        return self.upsert_file(record, project_id) is not None
    def create_user_folder(self, folder_id: str, project_id: str, name: str,
                          description: str = None, color: str = '#3b82f6',
                          sort_order: int = 0) -> bool:
        """
        创建用户自定义文件夹

        Args:
            folder_id: 文件夹ID
            project_id: 所属工程ID
            name: 文件夹名称
            description: 描述
            color: 颜色
            sort_order: 排序顺序

        Returns:
            是否成功
        """
        try:
            with self.get_cursor() as cursor:
                cursor.execute("""
                    INSERT INTO user_folders (id, project_id, name, description, color, sort_order, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (folder_id, project_id, name, description, color, sort_order, datetime.now().isoformat()))
            return True
        except Exception as e:
            _get_logger().error(f"创建用户文件夹失败 {name}: {e}")
            return False
    def get_user_folders(self, project_id: str) -> List[Dict[str, Any]]:
        """
        获取指定工程的所有用户自定义文件夹

        Args:
            project_id: 工程ID

        Returns:
            文件夹列表
        """
        with self.get_cursor() as cursor:
            cursor.execute("""
                SELECT * FROM user_folders
                WHERE project_id = ?
                ORDER BY sort_order ASC, created_at ASC
            """, (project_id,))
            return [{
                'id': row['id'],
                'project_id': row['project_id'],
                'name': row['name'],
                'description': row['description'],
                'color': row['color'],
                'sort_order': row['sort_order'],
                'created_at': row['created_at'],
                'updated_at': row['updated_at']
            } for row in cursor.fetchall()]
    def get_user_folder(self, folder_id: str) -> Optional[Dict[str, Any]]:
        """
        获取单个用户文件夹

        Args:
            folder_id: 文件夹ID

        Returns:
            文件夹信息或None
        """
        with self.get_cursor() as cursor:
            cursor.execute("SELECT * FROM user_folders WHERE id = ?", (folder_id,))
            row = cursor.fetchone()
            if row:
                return {
                    'id': row['id'],
                    'project_id': row['project_id'],
                    'name': row['name'],
                    'description': row['description'],
                    'color': row['color'],
                    'sort_order': row['sort_order'],
                    'created_at': row['created_at'],
                    'updated_at': row['updated_at']
                }
            return None
    def update_user_folder(self, folder_id: str, name: str = None,
                          description: str = None, color: str = None,
                          sort_order: int = None) -> bool:
        """
        更新用户文件夹

        Args:
            folder_id: 文件夹ID
            name: 新名称
            description: 新描述
            color: 新颜色
            sort_order: 新排序顺序

        Returns:
            是否成功
        """
        try:
            with self.get_cursor() as cursor:
                updates = []
                params = []
                if name is not None:
                    updates.append("name = ?")
                    params.append(name)
                if description is not None:
                    updates.append("description = ?")
                    params.append(description)
                if color is not None:
                    updates.append("color = ?")
                    params.append(color)
                if sort_order is not None:
                    updates.append("sort_order = ?")
                    params.append(sort_order)
                updates.append("updated_at = ?")
                params.append(datetime.now().isoformat())
                params.append(folder_id)

                cursor.execute(f"""
                    UPDATE user_folders SET {', '.join(updates)} WHERE id = ?
                """, params)
            return True
        except Exception as e:
            _get_logger().error(f"更新用户文件夹失败 {folder_id}: {e}")
            return False
    def delete_user_folder(self, folder_id: str) -> bool:
        """
        删除用户文件夹

        Args:
            folder_id: 文件夹ID

        Returns:
            是否成功
        """
        try:
            with self.get_cursor() as cursor:
                cursor.execute("DELETE FROM user_folders WHERE id = ?", (folder_id,))
            return True
        except Exception as e:
            _get_logger().error(f"删除用户文件夹失败 {folder_id}: {e}")
            return False
    def add_imported_folder_mapping(self, project_id: str, folder_path: str,
                                    folder_name: str, user_folder_id: str = None,
                                    file_count: int = 0) -> bool:
        """
        添加或更新导入文件夹的映射

        Args:
            project_id: 工程ID
            folder_path: 导入的文件夹路径
            folder_name: 文件夹显示名称
            user_folder_id: 关联的用户文件夹ID
            file_count: 文件数量

        Returns:
            是否成功
        """
        try:
            with self.get_cursor() as cursor:
                canonical_folder = canonicalize_path(folder_path)
                existing = next((
                    row for row in cursor.execute("""
                        SELECT id, folder_path FROM imported_folder_mappings
                        WHERE project_id=?
                    """, (project_id,)).fetchall()
                    if canonicalize_path(str(row["folder_path"])) == canonical_folder
                ), None)
                if existing:
                    cursor.execute("""
                        UPDATE imported_folder_mappings
                        SET folder_name=?, file_count=?,
                            user_folder_id=COALESCE(?, user_folder_id)
                        WHERE id=?
                    """, (folder_name, file_count, user_folder_id, existing["id"]))
                    return True
                cursor.execute("""
                    INSERT INTO imported_folder_mappings
                    (project_id, folder_path, folder_name, user_folder_id, file_count, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(project_id, folder_path) DO UPDATE SET
                        folder_name=excluded.folder_name,
                        file_count=excluded.file_count,
                        user_folder_id=COALESCE(
                            excluded.user_folder_id,
                            imported_folder_mappings.user_folder_id
                        )
                """, (project_id, folder_path, folder_name, user_folder_id, file_count, datetime.now().isoformat()))
            return True
        except Exception as e:
            _get_logger().error(f"添加导入文件夹映射失败 {folder_path}: {e}")
            return False
    def get_imported_folder_mappings(self, project_id: str, user_folder_id: str = None) -> List[Dict[str, Any]]:
        """
        获取导入文件夹的映射

        Args:
            project_id: 工程ID
            user_folder_id: 筛选特定用户文件夹（可选）

        Returns:
            映射列表
        """
        with self.get_cursor() as cursor:
            if user_folder_id:
                cursor.execute("""
                    SELECT * FROM imported_folder_mappings
                    WHERE project_id = ? AND user_folder_id = ?
                    ORDER BY created_at DESC
                """, (project_id, user_folder_id))
            else:
                cursor.execute("""
                    SELECT * FROM imported_folder_mappings
                    WHERE project_id = ?
                    ORDER BY created_at DESC
                """, (project_id,))
            return [{
                'id': row['id'],
                'project_id': row['project_id'],
                'folder_path': row['folder_path'],
                'folder_name': row['folder_name'],
                'user_folder_id': row['user_folder_id'],
                'file_count': row['file_count'],
                'created_at': row['created_at']
            } for row in cursor.fetchall()]
    def update_imported_folder_mapping(self, project_id: str, folder_path: str,
                                       user_folder_id: str = None) -> bool:
        """
        更新导入文件夹的用户文件夹关联

        Args:
            project_id: 工程ID
            folder_path: 导入的文件夹路径
            user_folder_id: 新的用户文件夹ID

        Returns:
            是否成功
        """
        try:
            with self.get_cursor() as cursor:
                cursor.execute("""
                    UPDATE imported_folder_mappings
                    SET user_folder_id = ?
                    WHERE project_id = ? AND folder_path = ?
                """, (user_folder_id, project_id, folder_path))
                return cursor.rowcount > 0
        except Exception as e:
            _get_logger().error(f"更新导入文件夹映射失败 {folder_path}: {e}")
            return False
