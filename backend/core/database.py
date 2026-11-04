# -*- coding: utf-8 -*-
# SoundBot - AI 音效管理器
# Copyright (C) 2026 Nagisa_Huckrick (胡杨)
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.
# SQLite 数据库管理模块

"""
SQLite 持久化层：存储音频文件元数据和波形峰值数据。

表结构:
- path (TEXT PRIMARY KEY) - 文件唯一路径
- filename (TEXT) - 文件名
- duration (REAL) - 时长（秒）
- sample_rate (INTEGER) - 采样率
- channels (INTEGER) - 声道数
- file_size (INTEGER) - 文件大小（字节）
- peaks_json (TEXT) - 波形峰值 JSON（约2000个点）
- tags (TEXT) - 标签 JSON 数组
- created_at (TEXT) - 创建时间
- updated_at (TEXT) - 更新时间
"""

import sqlite3
import json
import ntpath
import os
import shutil
import threading
import hashlib
import math
import re
import time
import uuid
from pathlib import Path
from typing import List, Optional, Dict, Any, Iterable, Tuple
from contextlib import contextmanager
from dataclasses import dataclass, asdict
from datetime import datetime

logger = None  # 延迟初始化

SCHEMA_VERSION = 3
ARTIFACT_KINDS = ("waveform", "audio_vector", "text_vector")
ARTIFACT_STATES = ("pending", "processing", "ready", "failed", "stale")
SAFE_PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
WINDOWS_RESERVED_PROJECT_IDS = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}


def _parse_tags(raw) -> List[str]:
    """tags 列存的是 JSON 字符串，对外统一返回数组。"""
    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(t) for t in raw if str(t).strip()]
    text = str(raw).strip()
    if not text or text == "[]":
        return []
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return [str(t) for t in parsed if str(t).strip()]
    except Exception:
        return [t.strip() for t in text.split(",") if t.strip()]
    return []


def is_safe_project_id(project_id: str) -> bool:
    """Return whether an identifier is safe to use as an application key/path part."""
    value = str(project_id or "").strip()
    windows_stem = value.split(".", 1)[0].upper()
    return bool(
        value not in {"", ".", ".."}
        and not value.endswith(".")
        and windows_stem not in WINDOWS_RESERVED_PROJECT_IDS
        and SAFE_PROJECT_ID_RE.fullmatch(value)
    )


def _is_windows_style_path(path: str) -> bool:
    """Recognize native and foreign Windows drive/UNC paths."""
    raw = os.fspath(path)
    drive, _tail = ntpath.splitdrive(raw)
    return os.name == "nt" or bool(drive) or raw.startswith("\\\\")


def canonicalize_path(path: str) -> str:
    """Create a physical-path lookup key without changing the displayed path.

    POSIX aliases must resolve to the same key (notably macOS ``/tmp`` and
    ``/private/tmp``).  Foreign Windows drive and UNC paths are normalized with
    :mod:`ntpath` so testing or migration on macOS never prepends the POSIX
    working directory to a Windows path.
    """
    raw = os.fspath(path)
    if not raw:
        return ""
    if _is_windows_style_path(raw):
        if os.name == "nt":
            normalized = os.path.realpath(os.path.abspath(os.path.expanduser(raw)))
        else:
            normalized = ntpath.normpath(raw.replace("/", "\\"))
        return ntpath.normcase(normalized).replace("\\", "/")
    expanded = os.path.expanduser(raw)
    return os.path.normcase(os.path.realpath(os.path.abspath(expanded)))


def canonical_path_is_within(path: str, folder_path: str) -> bool:
    """Return whether *path* is *folder_path* or one of its descendants.

    Both operands use the same Windows-aware canonical key as SQLite file
    identity.  The explicit separator boundary avoids the classic
    ``C:/audio/foo`` versus ``C:/audio/foobar`` prefix bug and does not rely on
    SQL ``LIKE`` (where ``%`` and ``_`` have special meaning).
    """
    candidate_key = canonicalize_path(path)
    folder_key = canonicalize_path(folder_path)
    if not candidate_key or not folder_key:
        return False
    if folder_key in {"/", "\\"}:
        return candidate_key.startswith(("/", "\\"))
    candidate = candidate_key.rstrip("/\\")
    folder = folder_key.rstrip("/\\")
    return candidate == folder or candidate.startswith(f"{folder}/")


def make_source_fingerprint(path: str) -> str:
    """Fast invalidation fingerprint; this deliberately is not a content hash."""
    try:
        stat = os.stat(path)
        payload = f"{stat.st_size}:{stat.st_mtime_ns}"
    except OSError:
        payload = "missing"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _stable_file_uuid(project_id: str, canonical_path: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"soundbot:{project_id}:{canonical_path}"))


def _get_logger():
    """延迟获取 logger，避免循环导入"""
    global logger
    if logger is None:
        from utils.logger import get_logger
        logger = get_logger()
    return logger


# SQL 建表语句
CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 工程表
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    temp_dir TEXT,  -- 工程特定的临时文件目录
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    settings_json TEXT DEFAULT '{}'  -- 工程特定配置（JSON格式）
);

-- 插入默认工程
INSERT OR IGNORE INTO projects (id, name, description) VALUES ('default', '默认工程', '系统默认工程');

-- 音频文件表
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_uuid TEXT NOT NULL,
    path TEXT NOT NULL,
    canonical_path TEXT NOT NULL,
    project_id TEXT DEFAULT 'default',
    filename TEXT NOT NULL,
    duration REAL DEFAULT 0,
    sample_rate INTEGER DEFAULT 0,
    channels INTEGER DEFAULT 0,
    file_size INTEGER DEFAULT 0,
    source_fingerprint TEXT,
    peaks_json TEXT,
    waveform_fingerprint TEXT,
    waveform_version INTEGER DEFAULT 0,
    tags TEXT DEFAULT '[]',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, canonical_path),
    UNIQUE(file_uuid),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id);
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_files_canonical_path ON files(project_id, canonical_path);
CREATE INDEX IF NOT EXISTS idx_filename ON files(filename);
CREATE INDEX IF NOT EXISTS idx_created_at ON files(created_at);
CREATE INDEX IF NOT EXISTS idx_duration ON files(duration);

-- 最近工程列表（用于快速切换）
CREATE TABLE IF NOT EXISTS recent_projects (
    project_id TEXT PRIMARY KEY,
    opened_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 用户自定义文件夹表
CREATE TABLE IF NOT EXISTS user_folders (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    color TEXT DEFAULT '#3b82f6',  -- 文件夹颜色（用于UI显示）
    sort_order INTEGER DEFAULT 0,   -- 排序顺序
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_folders_project ON user_folders(project_id);
CREATE INDEX IF NOT EXISTS idx_user_folders_order ON user_folders(sort_order);

-- 导入文件夹与用户文件夹的关联表（用于分类管理）
CREATE TABLE IF NOT EXISTS imported_folder_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    folder_path TEXT NOT NULL,      -- 导入的文件夹路径
    user_folder_id TEXT,            -- 关联的用户自定义文件夹ID（可为空表示未分类）
    folder_name TEXT,               -- 文件夹显示名称
    file_count INTEGER DEFAULT 0,   -- 文件数量
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_folder_id) REFERENCES user_folders(id) ON DELETE SET NULL,
    UNIQUE(project_id, folder_path)
);

CREATE INDEX IF NOT EXISTS idx_imported_mappings_project ON imported_folder_mappings(project_id);
CREATE INDEX IF NOT EXISTS idx_imported_mappings_user_folder ON imported_folder_mappings(user_folder_id);

CREATE TABLE IF NOT EXISTS file_artifacts (
    project_id TEXT NOT NULL,
    file_uuid TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('waveform', 'audio_vector', 'text_vector')),
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK(state IN ('pending', 'processing', 'ready', 'failed', 'stale')),
    source_fingerprint TEXT,
    engine_fingerprint TEXT,
    error_code TEXT,
    error_message TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, file_uuid, kind),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (file_uuid) REFERENCES files(file_uuid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_file_artifacts_state
ON file_artifacts(project_id, kind, state);

CREATE TABLE IF NOT EXISTS index_manifests (
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('audio_vector', 'text_vector')),
    collection_name TEXT,
    engine_fingerprint TEXT,
    model_id TEXT,
    model_revision TEXT,
    dimensions INTEGER,
    preprocessing_version TEXT,
    metric TEXT NOT NULL DEFAULT 'cosine',
    revision INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, kind),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    stage TEXT,
    processed INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_jobs_project_state ON jobs(project_id, state);
"""


def _execute_sql_statements(cursor: sqlite3.Cursor, script: str) -> None:
    """Execute a SQL script without sqlite3.executescript's implicit commit."""
    pending: List[str] = []
    for character in script:
        pending.append(character)
        if character != ";":
            continue
        statement = "".join(pending)
        if not sqlite3.complete_statement(statement):
            continue
        cursor.execute(statement)
        pending.clear()

    remainder = "".join(pending).strip()
    if remainder:
        raise sqlite3.ProgrammingError("incomplete SQL statement in schema definition")


@dataclass
class AudioFileRecord:
    """音频文件数据库记录"""
    path: str
    filename: str
    duration: float = 0.0
    sample_rate: int = 0
    channels: int = 0
    file_size: int = 0
    peaks_json: Optional[str] = None
    tags: str = '[]'
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    file_uuid: Optional[str] = None
    project_id: str = 'default'
    canonical_path: Optional[str] = None
    source_fingerprint: Optional[str] = None
    waveform_fingerprint: Optional[str] = None
    waveform_version: int = 0

    def get_peaks(self) -> Optional[List[float]]:
        """获取波形峰值列表"""
        if self.peaks_json:
            try:
                peaks = json.loads(self.peaks_json)
                if (
                    isinstance(peaks, list)
                    and peaks
                    and all(isinstance(value, (int, float)) and math.isfinite(value) for value in peaks)
                ):
                    return peaks
                return None
            except (json.JSONDecodeError, TypeError, ValueError):
                return None
        return None

    def get_tags(self) -> List[str]:
        """获取标签列表"""
        if self.tags:
            try:
                return json.loads(self.tags)
            except json.JSONDecodeError:
                return []
        return []

    def set_peaks(self, peaks: List[float]):
        """设置波形峰值"""
        self.peaks_json = json.dumps(peaks)

    def set_tags(self, tags: List[str]):
        """设置标签"""
        self.tags = json.dumps(tags)

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        result = asdict(self)
        result['peaks'] = self.get_peaks()
        result['tag_list'] = self.get_tags()
        return result

# 这个文件原来是四千多行，按职责拆成几块：
#   连接/事务/建表/迁移 留在这里（DatabaseManager 本体）
#   文件、标签、工程与目录、向量与工件、任务 各自一个 mixin
from core.db_files import FilesMixin
from core.db_jobs import JobsMixin
from core.db_projects import ProjectsMixin
from core.db_tags import TagsMixin
from core.db_vectors import VectorsMixin

class DatabaseManager(FilesMixin, JobsMixin, ProjectsMixin, TagsMixin, VectorsMixin):
    """SQLite 数据库管理器（线程安全）"""
    def __init__(self, db_path: str):
        """
        初始化数据库管理器

        Args:
            db_path: 数据库文件路径
        """
        self.db_path = db_path
        # A thread-local must belong to this manager instance. A class-level
        # local could reuse a connection from a different project/database.
        self._local = threading.local()
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._init_db()
        _get_logger().info(f"DatabaseManager 初始化完成: {db_path}")
    def close(self) -> None:
        """关闭当前线程的数据库连接。

        Windows 上未关闭的连接会锁住 .db 文件，导致删除工程/清理临时目录时报
        WinError 32。
        """
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            try:
                conn.close()
            except sqlite3.Error:
                pass
            self._local.conn = None
    def __del__(self):
        try:
            self.close()
        except Exception:
            pass
    def _get_connection(self) -> sqlite3.Connection:
        """获取线程局部的数据库连接"""
        conn = getattr(self._local, 'conn', None)
        if conn is None:
            try:
                conn = sqlite3.connect(
                    self.db_path,
                    check_same_thread=False,
                    timeout=30.0
                )
                conn.row_factory = sqlite3.Row
                conn.execute("PRAGMA foreign_keys=ON")
                # WAL：导入时每个文件要提交好几个小事务，DELETE 模式每次 commit 都 fsync
                # （实测 6ms/次 vs 0.03ms/次）。单进程写入，WAL 足够安全。
                try:
                    mode = conn.execute("PRAGMA journal_mode=WAL").fetchone()
                    if not mode or str(mode[0]).lower() != "wal":
                        conn.execute("PRAGMA journal_mode=DELETE")
                except sqlite3.Error:
                    conn.execute("PRAGMA journal_mode=DELETE")
                conn.execute("PRAGMA synchronous=NORMAL")
                conn.execute("PRAGMA wal_autocheckpoint=1000")
                # 索引任务与描述包写入同时跑时会撞写锁：默认 5 秒内自动重试，
                # 而不是立刻抛 database is locked（B6 的一半）。
                try:
                    # 15 秒：批量写（描述包 800 条一批、向量包 4000 条一批）
                    # 的单个事务可能超过原来的 5 秒阈值。
                    conn.execute("PRAGMA busy_timeout=15000")
                except sqlite3.Error:
                    pass
                self._local.conn = conn
            except sqlite3.Error as e:
                _get_logger().error(f"数据库连接失败: {e}")
                self._repair_database()
                raise
        return conn
    def _repair_database(self):
        """Run a read-only integrity diagnostic; never delete WAL/SHM files."""
        try:
            _get_logger().warning(f"数据库完整性诊断: {self.db_path}")
            diagnostic = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True)
            try:
                result = diagnostic.execute("PRAGMA quick_check").fetchone()
                _get_logger().warning(f"数据库 quick_check: {result[0] if result else 'unknown'}")
            finally:
                diagnostic.close()
        except Exception as e:
            _get_logger().error(f"数据库诊断失败: {e}")
    def begin_batch(self) -> None:
        """批量写入模式：get_cursor 退出时不 commit，由 flush_batch 统一提交。

        导入 6.5 万条时逐条 commit 要几十分钟（每次 fsync 5~10ms）；
        批量模式把「1 次/条」降到「1 次/200 条」。
        """
        self._local.batch = True
    def flush_batch(self) -> None:
        """提交当前线程累积的写事务。"""
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.commit()
    def end_batch(self) -> None:
        """退出批量模式并落盘。"""
        self._local.batch = False
        self.flush_batch()
    @contextmanager
    def get_cursor(self):
        """获取数据库游标的上下文管理器"""
        conn = self._get_connection()
        cursor = conn.cursor()
        try:
            yield cursor
            if not getattr(self._local, "batch", False):
                conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cursor.close()
    def _init_db(self):
        """Initialize safely, restoring the immutable snapshot on failure."""
        self._migration_backup_in_progress: Optional[str] = None
        try:
            self._init_db_once()
        except Exception as exc:
            backup_path = self._migration_backup_in_progress
            connection = getattr(self._local, "conn", None)
            if connection is not None:
                try:
                    connection.rollback()
                    connection.close()
                finally:
                    self._local.conn = None
            if backup_path and os.path.isfile(backup_path):
                try:
                    shutil.copy2(backup_path, self.db_path)
                    _get_logger().error(
                        "数据库迁移失败，已从只读升级快照恢复原库；备份保留在 %s",
                        backup_path,
                    )
                except Exception as restore_error:
                    _get_logger().critical(
                        "数据库迁移与自动恢复均失败；原始备份仍保留在 %s: %s",
                        backup_path,
                        restore_error,
                    )
            raise RuntimeError("数据库迁移失败，应用已停止以保护用户数据") from exc
        finally:
            self._migration_backup_in_progress = None
    def _ensure_content_hash_columns(self, cursor) -> None:
        """幂等添加 sha256 / hash_state 列（加列不触发整库备份）。"""
        try:
            columns = {
                row[1] for row in cursor.execute("PRAGMA table_info(files)").fetchall()
            }
            if "sha256" not in columns:
                cursor.execute("ALTER TABLE files ADD COLUMN sha256 TEXT")
            if "hash_state" not in columns:
                cursor.execute("ALTER TABLE files ADD COLUMN hash_state INTEGER DEFAULT 0")
            if "source" not in columns:
                cursor.execute("ALTER TABLE files ADD COLUMN source TEXT DEFAULT 'user'")
                cursor.execute(
                    "UPDATE files SET source='ai' WHERE path LIKE '%AI生成音效%' OR path LIKE '%AI生成%'"
                )
            if "is_favorite" not in columns:
                cursor.execute("ALTER TABLE files ADD COLUMN is_favorite INTEGER DEFAULT 0")
                cursor.execute(
                    "CREATE INDEX IF NOT EXISTS idx_files_favorite ON files(is_favorite)"
                )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files(sha256)"
            )
        except Exception as exc:
            _get_logger().warning("添加内容哈希列失败: %s", exc)
    def find_by_hash(self, project_id: str, sha256: str) -> Optional[Dict[str, Any]]:
        if not sha256:
            return None
        with self.get_cursor() as cursor:
            row = cursor.execute(
                "SELECT file_uuid, path, filename, ai_description, tags FROM files "
                "WHERE project_id=? AND sha256=? LIMIT 1",
                (str(project_id), sha256),
            ).fetchone()
        if not row:
            return None
        return {
            "file_uuid": row[0],
            "path": row[1],
            "filename": row[2],
            "ai_description": row[3],
            "tags": row[4],
        }
    def _init_db_once(self):
        """初始化数据库，并且每个 schema 版本只迁移一次。"""
        with self.get_cursor() as cursor:
            self._ensure_content_hash_columns(cursor)
            self._ensure_user_folder_files_table(cursor)
            self._ensure_tag_layers(cursor)
            schema_version_pending = False
            # 检查 files 表是否存在
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='files'")
            files_table_exists = cursor.fetchone() is not None

            # 检查 projects 表是否存在
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'")
            projects_table_exists = cursor.fetchone() is not None

            if not files_table_exists:
                # 全新数据库，直接创建所有表
                cursor.execute("BEGIN IMMEDIATE")
                _execute_sql_statements(cursor, CREATE_TABLE_SQL)
                integrity = cursor.execute("PRAGMA quick_check").fetchone()
                if not integrity or integrity[0] != "ok":
                    raise sqlite3.DatabaseError(
                        f"database initialization quick_check failed: {integrity}"
                    )
                schema_version_pending = True
                # 上面那三个 _ensure_*（内容哈希列 / 用户文件夹表 / 双层标签）
                # 在表还不存在时静默失败过，全新库必须在这里再补一遍——
                # 否则新装用户缺 is_favorite / sha256 / hash_state / source，
                # 文件列表接口会直接抛 no such column: f.is_favorite。
                self._ensure_content_hash_columns(cursor)
                self._ensure_user_folder_files_table(cursor)
                self._ensure_tag_layers(cursor)
                _get_logger().info("数据库初始化完成：创建新表")
            else:
                cursor.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'"
                )
                if cursor.fetchone():
                    version_row = cursor.execute(
                        "SELECT value FROM schema_meta WHERE key='schema_version'"
                    ).fetchone()
                    current_version = int(version_row[0]) if version_row else 0
                else:
                    current_version = 0

                if current_version < SCHEMA_VERSION:
                    backup_path = self._create_migration_backup(current_version)
                    self._migration_backup_in_progress = backup_path
                    _get_logger().info(
                        f"数据库从 v{current_version} 迁移到 v{SCHEMA_VERSION}; "
                        f"原始备份保留在 {backup_path}"
                    )
                    if current_version < 2:
                        self._migrate_db_v2(
                            cursor, projects_table_exists, current_version
                        )
                        current_version = 2
                    if current_version < 3:
                        # v2 already owns artifact/index state.  Its path-key
                        # upgrade must be incremental and must not rebuild the
                        # files table or reset ready artifacts.
                        self._migrate_db_v3(cursor)
                        current_version = 3
                    schema_version_pending = True

            # 轻量幂等列迁移：ai_description（AI 生成的一句话描述）。
            # 不 bump SCHEMA_VERSION——ALTER ADD COLUMN 可安全重复执行。
            cursor.execute("PRAGMA table_info(files)")
            _file_cols = {row[1] for row in cursor.fetchall()}
            if "ai_description" not in _file_cols:
                cursor.execute("ALTER TABLE files ADD COLUMN ai_description TEXT")
                _get_logger().info("files 表新增 ai_description 列")

            # A process can stop between claiming an artifact/job and recording
            # its result.  Recover those durable states on the next startup so
            # repair jobs can safely resume instead of leaving them stuck.
            now = datetime.now().isoformat()
            cursor.execute("""
                UPDATE file_artifacts
                SET state='pending', error_code='interrupted',
                    error_message='Previous process stopped during processing',
                    updated_at=?
                WHERE state='processing'
            """, (now,))
            cursor.execute("""
                UPDATE jobs
                SET state='failed', stage='interrupted',
                    error_code='job_interrupted',
                    error_message='Previous process stopped before the job completed',
                    updated_at=?
                WHERE state IN ('pending', 'running')
            """, (now,))
            if schema_version_pending:
                # This must be the final write in the schema transaction.  A
                # failed migration must never advertise the new version.
                cursor.execute("""
                    INSERT INTO schema_meta(key, value, updated_at)
                    VALUES ('schema_version', ?, ?)
                    ON CONFLICT(key) DO UPDATE
                    SET value=excluded.value, updated_at=excluded.updated_at
                """, (str(SCHEMA_VERSION), now))
    def _create_migration_backup(self, current_version: int) -> str:
        """Create one immutable SQLite snapshot for a schema transition."""
        backup_path = f"{self.db_path}.pre-v{current_version}-to-v{SCHEMA_VERSION}.bak"
        if os.path.exists(backup_path):
            return backup_path
        connection = self._get_connection()
        # sqlite3 的 backup() 需要对源库拿共享锁。源连接上还有未提交的写事务时，
        # 它会一直重试 SQLITE_BUSY —— Windows 上表现为**永久挂起**（实测 20s+ 不动，
        # CPU 为 0）。迁移前那几个幂等的补列 / 补表 / 种子数据本来就该落盘，
        # 先提交再快照不改变"迁移前保底"的语义。
        if connection.in_transaction:
            connection.commit()
        destination = sqlite3.connect(backup_path)
        try:
            connection.backup(destination)
        finally:
            destination.close()
        return backup_path
    def _migrate_db_v2(
        self,
        cursor: sqlite3.Cursor,
        projects_table_exists: bool,
        current_version: int,
    ) -> None:
        """Add recoverable waveform/vector state while retaining legacy metadata."""
        if not cursor.connection.in_transaction:
            cursor.execute("BEGIN IMMEDIATE")
        if not projects_table_exists:
            cursor.execute("""
                CREATE TABLE projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT,
                    temp_dir TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    settings_json TEXT DEFAULT '{}'
                )
            """)
        cursor.execute("""
            INSERT OR IGNORE INTO projects (id, name, description)
            VALUES ('default', '默认工程', '系统默认工程')
        """)

        project_map: Dict[str, str] = {}
        project_rows = cursor.execute("SELECT * FROM projects").fetchall()
        for project in project_rows:
            old_id = project["id"]
            if is_safe_project_id(old_id):
                project_map[old_id] = old_id
                continue
            new_id = f"legacy_{hashlib.sha256(old_id.encode('utf-8')).hexdigest()[:16]}"
            project_map[old_id] = new_id
            cursor.execute("""
                INSERT OR IGNORE INTO projects
                (id, name, description, temp_dir, created_at, updated_at, settings_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                new_id,
                project["name"],
                project["description"],
                project["temp_dir"],
                project["created_at"],
                project["updated_at"],
                project["settings_json"],
            ))
            _get_logger().warning(f"不安全工程 ID 已迁移: {old_id!r} -> {new_id}")

        legacy_columns = {
            row[1] for row in cursor.execute("PRAGMA table_info(files)").fetchall()
        }
        cursor.execute("ALTER TABLE files RENAME TO files_legacy_v2")
        cursor.execute("""
            CREATE TABLE files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_uuid TEXT NOT NULL UNIQUE,
                path TEXT NOT NULL,
                canonical_path TEXT NOT NULL,
                project_id TEXT DEFAULT 'default',
                filename TEXT NOT NULL,
                duration REAL DEFAULT 0,
                sample_rate INTEGER DEFAULT 0,
                channels INTEGER DEFAULT 0,
                file_size INTEGER DEFAULT 0,
                source_fingerprint TEXT,
                peaks_json TEXT,
                waveform_fingerprint TEXT,
                waveform_version INTEGER DEFAULT 0,
                tags TEXT DEFAULT '[]',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(project_id, canonical_path),
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
            )
        """)

        legacy_rows = cursor.execute(
            "SELECT rowid AS legacy_rowid, * FROM files_legacy_v2"
        ).fetchall()
        used_keys: set[Tuple[str, str]] = set()
        used_uuids: set[str] = set()
        for row in legacy_rows:
            path = row["path"] if "path" in legacy_columns else None
            if not path:
                continue
            legacy_project = (
                row["project_id"] if "project_id" in legacy_columns else "default"
            ) or "default"
            project_id = project_map.get(legacy_project, legacy_project)
            if not cursor.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                if not is_safe_project_id(project_id):
                    project_id = f"legacy_{hashlib.sha256(project_id.encode('utf-8')).hexdigest()[:16]}"
                cursor.execute(
                    "INSERT OR IGNORE INTO projects(id, name, description) VALUES (?, ?, ?)",
                    (project_id, project_id, "Migrated legacy project"),
                )
            canonical = canonicalize_path(path)
            key = (project_id, canonical)
            if key in used_keys:
                canonical = f"{canonical}#legacy-{row['legacy_rowid']}"
                key = (project_id, canonical)
            used_keys.add(key)
            file_uuid = (
                row["file_uuid"]
                if "file_uuid" in legacy_columns and row["file_uuid"]
                else _stable_file_uuid(project_id, canonical)
            )
            if file_uuid in used_uuids:
                file_uuid = str(uuid.uuid4())
            used_uuids.add(file_uuid)

            def legacy_value(name: str, default: Any) -> Any:
                return row[name] if name in legacy_columns and row[name] is not None else default

            source_fingerprint = legacy_value(
                "source_fingerprint", make_source_fingerprint(path)
            )
            cursor.execute("""
                INSERT INTO files
                (file_uuid, path, canonical_path, project_id, filename, duration,
                 sample_rate, channels, file_size, source_fingerprint, peaks_json,
                 waveform_fingerprint, waveform_version, tags, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                file_uuid,
                path,
                canonical,
                project_id,
                legacy_value("filename", os.path.basename(path)),
                legacy_value("duration", 0),
                legacy_value("sample_rate", 0),
                legacy_value("channels", 0),
                legacy_value("file_size", 0),
                source_fingerprint,
                legacy_value("peaks_json", None),
                legacy_value("waveform_fingerprint", None),
                legacy_value("waveform_version", 0),
                legacy_value("tags", "[]"),
                legacy_value("created_at", datetime.now().isoformat()),
                legacy_value("updated_at", datetime.now().isoformat()),
            ))
        cursor.execute("DROP TABLE files_legacy_v2")

        # CREATE IF NOT EXISTS keeps all user tables and adds v2 support tables.
        # Execute each statement on the active transaction: executescript()
        # would commit the destructive legacy-table rewrite before backfill.
        _execute_sql_statements(cursor, CREATE_TABLE_SQL)
        for old_id, new_id in project_map.items():
            if old_id == new_id:
                continue
            for table in ("recent_projects", "user_folders", "imported_folder_mappings"):
                exists = cursor.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
                ).fetchone()
                if exists:
                    cursor.execute(
                        f"UPDATE OR IGNORE {table} SET project_id=? WHERE project_id=?",
                        (new_id, old_id),
                    )
            cursor.execute("DELETE FROM projects WHERE id=?", (old_id,))

        now = datetime.now().isoformat()
        migrated_files = cursor.execute("""
            SELECT file_uuid, project_id, source_fingerprint, peaks_json FROM files
        """).fetchall()
        for row in migrated_files:
            try:
                peaks = json.loads(row["peaks_json"]) if row["peaks_json"] else None
                valid_peaks = bool(
                    isinstance(peaks, list)
                    and peaks
                    and all(
                        isinstance(value, (int, float)) and math.isfinite(value)
                        for value in peaks
                    )
                )
            except (ValueError, TypeError):
                valid_peaks = False
            for kind, state in (
                ("waveform", "stale" if valid_peaks else "pending"),
                ("audio_vector", "pending"),
                ("text_vector", "pending"),
            ):
                cursor.execute("""
                    INSERT OR REPLACE INTO file_artifacts
                    (project_id, file_uuid, kind, state, source_fingerprint, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (
                    row["project_id"],
                    row["file_uuid"],
                    kind,
                    state,
                    row["source_fingerprint"],
                    now,
                ))
        integrity = cursor.execute("PRAGMA quick_check").fetchone()
        if not integrity or integrity[0] != "ok":
            raise sqlite3.DatabaseError(f"migration quick_check failed: {integrity}")
        _get_logger().info(f"数据库迁移完成: v{current_version} -> v2")
    def _migrate_db_v3(self, cursor: sqlite3.Cursor) -> None:
        """Merge physical-path aliases without resetting v2 artifact state.

        The richer row remains the authority and keeps its UUID.  If a ready
        vector only exists under a discarded alias UUID it is marked stale,
        because Chroma must recreate that vector under the surviving UUID.
        """
        if not cursor.connection.in_transaction:
            cursor.execute("BEGIN IMMEDIATE")

        rows = [dict(row) for row in cursor.execute(
            "SELECT * FROM files ORDER BY id"
        ).fetchall()]
        artifacts_by_uuid: Dict[str, Dict[str, Dict[str, Any]]] = {}
        for artifact_row in cursor.execute("SELECT * FROM file_artifacts").fetchall():
            artifact = dict(artifact_row)
            artifacts_by_uuid.setdefault(str(artifact["file_uuid"]), {})[
                str(artifact["kind"])
            ] = artifact

        def valid_peaks(value: Any) -> bool:
            try:
                peaks = json.loads(value) if value else None
            except (TypeError, ValueError):
                return False
            return bool(
                isinstance(peaks, list)
                and peaks
                and all(
                    isinstance(item, (int, float)) and math.isfinite(item)
                    for item in peaks
                )
            )

        def tags_from(value: Any) -> List[str]:
            try:
                tags = json.loads(value) if value else []
            except (TypeError, ValueError):
                return []
            return [str(tag) for tag in tags] if isinstance(tags, list) else []

        def row_score(row: Dict[str, Any]) -> Tuple[Any, ...]:
            artifacts = artifacts_by_uuid.get(str(row["file_uuid"]), {})
            ready_vectors = sum(
                artifacts.get(kind, {}).get("state") == "ready"
                for kind in ("audio_vector", "text_vector")
            )
            ready_total = sum(
                artifact.get("state") == "ready" for artifact in artifacts.values()
            )
            return (
                ready_vectors,
                ready_total,
                valid_peaks(row.get("peaks_json")),
                float(row.get("duration") or 0) > 0,
                int(row.get("sample_rate") or 0) > 0,
                int(row.get("channels") or 0) > 0,
                len(tags_from(row.get("tags"))),
                int(row.get("file_size") or 0),
                str(row.get("updated_at") or ""),
                -int(row.get("id") or 0),
            )

        groups: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
        for row in rows:
            canonical = canonicalize_path(str(row.get("path") or ""))
            if not canonical:
                canonical = str(row.get("canonical_path") or "")
            groups.setdefault((str(row["project_id"]), canonical), []).append(row)

        merged_aliases = 0
        dirty_projects: Dict[str, set[str]] = {}
        state_rank = {
            "ready": 5,
            "processing": 4,
            "stale": 3,
            "failed": 2,
            "pending": 1,
        }
        now = datetime.now().isoformat()

        for (project_id, canonical), group in groups.items():
            if len(group) == 1:
                row = group[0]
                if str(row.get("canonical_path") or "") != canonical:
                    cursor.execute(
                        "UPDATE files SET canonical_path=?, updated_at=? WHERE id=?",
                        (canonical, now, row["id"]),
                    )
                continue

            survivor = max(group, key=row_score)
            survivor_uuid = str(survivor["file_uuid"])
            losers = [row for row in group if row["id"] != survivor["id"]]
            loser_uuids = {str(row["file_uuid"]) for row in losers}
            metadata_donor = max(
                group,
                key=lambda row: (
                    float(row.get("duration") or 0) > 0,
                    int(row.get("sample_rate") or 0) > 0,
                    int(row.get("channels") or 0) > 0,
                    int(row.get("file_size") or 0),
                    str(row.get("updated_at") or ""),
                ),
            )
            peak_rows = [row for row in group if valid_peaks(row.get("peaks_json"))]
            peak_donor = max(peak_rows, key=row_score) if peak_rows else None

            merged_tags: List[str] = []
            for row in sorted(group, key=row_score, reverse=True):
                for tag in tags_from(row.get("tags")):
                    if tag not in merged_tags:
                        merged_tags.append(tag)

            artifact_candidates: Dict[str, List[Dict[str, Any]]] = {
                kind: [] for kind in ARTIFACT_KINDS
            }
            for row in group:
                for kind, artifact in artifacts_by_uuid.get(
                    str(row["file_uuid"]), {}
                ).items():
                    artifact_candidates[kind].append(artifact)

            # Remove conflicting canonical keys and their cascading artifact
            # rows before assigning the new physical key to the survivor.
            cursor.executemany(
                "DELETE FROM files WHERE id=?",
                [(row["id"],) for row in losers],
            )
            stored_path = str(metadata_donor["path"])
            if not _is_windows_style_path(stored_path):
                stored_path = canonical
            source_fingerprint = (
                (peak_donor or metadata_donor).get("source_fingerprint")
                or survivor.get("source_fingerprint")
            )
            cursor.execute("""
                UPDATE files SET
                    path=?, canonical_path=?, filename=?, duration=?, sample_rate=?,
                    channels=?, file_size=?, source_fingerprint=?, peaks_json=?,
                    waveform_fingerprint=?, waveform_version=?, tags=?,
                    created_at=?, updated_at=?
                WHERE id=?
            """, (
                stored_path,
                canonical,
                metadata_donor.get("filename") or Path(stored_path).name,
                metadata_donor.get("duration") or 0,
                metadata_donor.get("sample_rate") or 0,
                metadata_donor.get("channels") or 0,
                metadata_donor.get("file_size") or 0,
                source_fingerprint,
                peak_donor.get("peaks_json") if peak_donor else None,
                peak_donor.get("waveform_fingerprint") if peak_donor else None,
                peak_donor.get("waveform_version") if peak_donor else 0,
                json.dumps(merged_tags, ensure_ascii=False),
                min(str(row.get("created_at") or now) for row in group),
                max(str(row.get("updated_at") or now) for row in group),
                survivor["id"],
            ))

            for kind in ARTIFACT_KINDS:
                candidates = artifact_candidates[kind]
                chosen = max(
                    candidates,
                    key=lambda artifact: (
                        state_rank.get(str(artifact.get("state")), 0),
                        str(artifact.get("file_uuid")) == survivor_uuid,
                        str(artifact.get("updated_at") or ""),
                    ),
                ) if candidates else {}
                state = str(chosen.get("state") or "pending")
                error_code = chosen.get("error_code")
                error_message = chosen.get("error_message")
                engine_fingerprint = chosen.get("engine_fingerprint")
                if kind == "waveform" and peak_donor:
                    state = "ready"
                    engine_fingerprint = peak_donor.get("waveform_fingerprint")
                    error_code = None
                    error_message = None
                elif (
                    kind in {"audio_vector", "text_vector"}
                    and chosen.get("file_uuid") in loser_uuids
                    and state == "ready"
                ):
                    state = "stale"
                    error_code = "path_alias_uuid_merged"
                    error_message = "Vector must be recreated under the surviving file UUID"
                if kind in {"audio_vector", "text_vector"} and any(
                    artifact.get("file_uuid") in loser_uuids
                    and artifact.get("state") == "ready"
                    for artifact in candidates
                ):
                    dirty_projects.setdefault(project_id, set()).add(kind)
                cursor.execute("""
                    INSERT INTO file_artifacts
                    (project_id, file_uuid, kind, state, source_fingerprint,
                     engine_fingerprint, error_code, error_message, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(project_id, file_uuid, kind) DO UPDATE SET
                        state=excluded.state,
                        source_fingerprint=excluded.source_fingerprint,
                        engine_fingerprint=excluded.engine_fingerprint,
                        error_code=excluded.error_code,
                        error_message=excluded.error_message,
                        updated_at=excluded.updated_at
                """, (
                    project_id,
                    survivor_uuid,
                    kind,
                    state,
                    chosen.get("source_fingerprint") or source_fingerprint,
                    engine_fingerprint,
                    error_code,
                    error_message,
                    now,
                ))
            merged_aliases += len(losers)

        # Folder mappings used raw-path uniqueness in v2.  Merge aliases here
        # and make future writes use the same physical identity.
        mapping_rows = [dict(row) for row in cursor.execute(
            "SELECT * FROM imported_folder_mappings ORDER BY id"
        ).fetchall()]
        mapping_groups: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
        for row in mapping_rows:
            mapping_groups.setdefault(
                (str(row["project_id"]), canonicalize_path(str(row["folder_path"]))),
                [],
            ).append(row)
        for (_project_id, canonical), group in mapping_groups.items():
            if not canonical:
                continue
            winner = max(
                group,
                key=lambda row: (
                    bool(row.get("user_folder_id")),
                    int(row.get("file_count") or 0),
                    -int(row["id"]),
                ),
            )
            losers = [row for row in group if row["id"] != winner["id"]]
            if losers:
                cursor.executemany(
                    "DELETE FROM imported_folder_mappings WHERE id=?",
                    [(row["id"],) for row in losers],
                )
            stored_folder = str(winner["folder_path"])
            if not _is_windows_style_path(stored_folder):
                stored_folder = canonical
            cursor.execute("""
                UPDATE imported_folder_mappings
                SET folder_path=?, folder_name=?, user_folder_id=?, file_count=?
                WHERE id=?
            """, (
                stored_folder,
                winner.get("folder_name") or Path(stored_folder).name,
                winner.get("user_folder_id"),
                max(int(row.get("file_count") or 0) for row in group),
                winner["id"],
            ))

        for project_id, kinds in dirty_projects.items():
            for kind in kinds:
                cursor.execute("""
                    UPDATE index_manifests
                    SET state='stale', revision=revision + 1, updated_at=?
                    WHERE project_id=? AND kind=?
                """, (now, project_id, kind))

        integrity = cursor.execute("PRAGMA quick_check").fetchone()
        if not integrity or integrity[0] != "ok":
            raise sqlite3.DatabaseError(f"v3 migration quick_check failed: {integrity}")
        _get_logger().info(
            "数据库迁移完成: v2 -> v3; 合并 %s 条物理路径别名", merged_aliases
        )
    def _row_to_record(self, row: sqlite3.Row) -> AudioFileRecord:
        """将数据库行转换为记录对象"""
        return AudioFileRecord(
            path=row['path'],
            filename=row['filename'],
            duration=row['duration'],
            sample_rate=row['sample_rate'],
            channels=row['channels'],
            file_size=row['file_size'],
            peaks_json=row['peaks_json'],
            tags=row['tags'],
            created_at=row['created_at'],
            updated_at=row['updated_at'],
            file_uuid=row['file_uuid'],
            project_id=row['project_id'],
            canonical_path=row['canonical_path'],
            source_fingerprint=row['source_fingerprint'],
            waveform_fingerprint=row['waveform_fingerprint'],
            waveform_version=row['waveform_version'],
        )
    def _invalidate_similar_cache(self, project_id: Optional[str] = None) -> None:
        """文件集合或标签/描述变了：「找相似」的词表倒排要重建。

        之前只靠 10 分钟 TTL，新导入的文件在 10 分钟内点「找相似」是搜不到的。
        """
        try:
            from core import similar as _similar

            _similar.invalidate(project_id)
        except Exception:
            pass
    def remove_mappings_under(self, project_id: str, folder: str) -> int:
        """删掉目录（含子目录）在「我的文件夹」里的映射。

        只删记录不删源文件时，映射行会留下，左侧「我的文件夹」还挂着一个空目录，
        看起来就像"删了没生效"。
        """
        base = str(folder).rstrip('\\/')
        if not base:
            return 0
        try:
            with self.get_cursor() as cursor:
                cursor.execute(
                    "DELETE FROM imported_folder_mappings "
                    "WHERE project_id=? AND (folder_path=? OR folder_path LIKE ? OR folder_path LIKE ?)",
                    (str(project_id), base, base + '\\%', base + '/%'),
                )
                return cursor.rowcount or 0
        except Exception as exc:
            _get_logger().error(f"清理目录映射失败: {exc}")
            return 0
    def update_ai_description(
        self, path: str, description: str, project_id: str = None,
        file_uuid: str = None,
    ) -> bool:
        """写入 AI 生成的一句话描述。

        Returns:
            是否成功
        """
        try:
            canonical_path = canonicalize_path(path)
            now = datetime.now().isoformat()
            with self.get_cursor() as cursor:
                if project_id:
                    cursor.execute("""
                        UPDATE files SET ai_description = ?, updated_at = ?
                        WHERE canonical_path = ? AND project_id = ?
                    """, (description, now, canonical_path, project_id))
                else:
                    cursor.execute("""
                        UPDATE files SET ai_description = ?, updated_at = ?
                        WHERE canonical_path = ?
                    """, (description, now, canonical_path))
                changed = cursor.rowcount > 0
                # canonical_path 对不上就用 file_uuid 兜底：路径规范化（大小写 / 分隔符 /
                # 长路径前缀）任何一处不一致，原来都静默 rowcount=0，接口只能回
                # 「写入描述失败」，界面显示「保存失败，再点重试」（11-02 用户实测）。
                if not changed and file_uuid:
                    cursor.execute(
                        "UPDATE files SET ai_description = ?, updated_at = ? WHERE file_uuid = ?",
                        (description, now, str(file_uuid)),
                    )
                    changed = cursor.rowcount > 0
                    if changed:
                        logger.info(
                            "[描述] canonical_path 未命中，已按 file_uuid 写入: %s", file_uuid
                        )
                if not changed:
                    logger.warning(
                        "[描述] 没有写入任何行: path=%s canonical=%s project=%s uuid=%s",
                        path, canonical_path, project_id, file_uuid,
                    )
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
            _get_logger().error(f"更新 AI 描述失败 {path}: {e}")
            return False
    def list_missing_ai_descriptions(
        self, project_id: str = None, limit: int = 100
    ) -> List[Dict[str, Any]]:
        """列出尚无 AI 一句话描述的文件（断点续跑：只取描述为空/未设置的）。"""
        try:
            with self.get_cursor() as cursor:
                if project_id:
                    rows = cursor.execute("""
                        SELECT file_uuid, path, filename
                        FROM files
                        WHERE project_id = ? AND (
                            ai_description IS NULL OR TRIM(ai_description) = ''
                            OR ai_description LIKE '[auto]%'
                        )
                        ORDER BY created_at DESC
                        LIMIT ?
                    """, (project_id, limit)).fetchall()
                else:
                    rows = cursor.execute("""
                        SELECT file_uuid, path, filename
                        FROM files
                        WHERE ai_description IS NULL OR TRIM(ai_description) = ''
                            OR ai_description LIKE '[auto]%'
                        ORDER BY created_at DESC
                        LIMIT ?
                    """, (limit,)).fetchall()
            return [
                {"file_uuid": row[0], "path": row[1], "filename": row[2]}
                for row in rows
            ]
        except Exception as e:
            _get_logger().error(f"查询缺失 AI 描述失败: {e}")
            return []
    def get_total_duration(self, project_id: Optional[str] = None) -> float:
        """
        获取所有文件的总时长

        Returns:
            总时长（秒）
        """
        with self.get_cursor() as cursor:
            if project_id:
                cursor.execute(
                    "SELECT SUM(duration) FROM files WHERE project_id=?", (project_id,)
                )
            else:
                cursor.execute("SELECT SUM(duration) FROM files")
            result = cursor.fetchone()[0]
            return result if result else 0.0
    def clear_all(self) -> bool:
        """
        清空所有文件记录（谨慎使用）

        Returns:
            是否成功
        """
        try:
            with self.get_cursor() as cursor:
                cursor.execute("DELETE FROM files")
            return True
        except Exception as e:
            _get_logger().error(f"清空数据库失败: {e}")
            return False
    def ensure_excluded_table(self) -> None:
        """记录「用户主动从库里移除」的路径，重读目录时跳过它们。

        没有这张表时，用户清掉的损坏文件会在下一次重读目录时被当成
        「磁盘上有、库里没有的新文件」重新补录，用户会误会是软件又出问题。
        """
        with self.get_cursor() as cursor:
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS excluded_files (
                    project_id TEXT NOT NULL,
                    path TEXT NOT NULL,
                    reason TEXT,
                    created_at TEXT,
                    PRIMARY KEY (project_id, path)
                )
                """
            )
    def add_excluded_paths(self, project_id: str, paths: Iterable[str], reason: str = "removed") -> int:
        self.ensure_excluded_table()
        items = [str(p) for p in dict.fromkeys(paths) if p]
        if not items:
            return 0
        stamp = datetime.now().isoformat()
        with self.get_cursor() as cursor:
            cursor.executemany(
                "INSERT OR REPLACE INTO excluded_files(project_id, path, reason, created_at) "
                "VALUES (?,?,?,?)",
                [(str(project_id), p, reason, stamp) for p in items],
            )
        return len(items)
    def list_excluded_paths(self, project_id: str) -> List[str]:
        self.ensure_excluded_table()
        with self.get_cursor() as cursor:
            return [
                str(row[0])
                for row in cursor.execute(
                    "SELECT path FROM excluded_files WHERE project_id=?", (str(project_id),)
                ).fetchall()
            ]
    def clear_excluded_paths(self, project_id: str) -> int:
        self.ensure_excluded_table()
        with self.get_cursor() as cursor:
            return cursor.execute(
                "DELETE FROM excluded_files WHERE project_id=?", (str(project_id),)
            ).rowcount
    def get_search_rows(self, project_id: str) -> List[tuple]:
        """关键词搜索用的轻量行集。

        `get_files_by_project` 会为 5 万条记录逐条构造 AudioFileRecord，
        在桌面机上要 9~11 秒；搜索只需要少数字段，直接用游标取元组即可。
        """
        with self.get_cursor() as cursor:
            cursor.execute(
                """
                SELECT file_uuid, path, filename, duration, file_size,
                       sample_rate, channels, tags, ai_description
                FROM files WHERE project_id = ? ORDER BY created_at DESC
                """,
                (project_id,),
            )
            return cursor.fetchall()


# ========== 全局单例 ==========

_db_manager: Optional[DatabaseManager] = None


def get_db_manager(db_path: Optional[str] = None) -> DatabaseManager:
    """
    获取数据库管理器单例

    Args:
        db_path: 数据库文件路径，如果为 None 则使用默认路径

    Returns:
        DatabaseManager 实例
    """
    global _db_manager
    if _db_manager is None:
        if db_path is None:
            # 延迟导入避免循环依赖
            import config
            db_path = str(config.get_db_path() / "soundmind.db")
        _db_manager = DatabaseManager(db_path)
    return _db_manager


def reset_db_manager() -> None:
    """重置数据库管理器（用于关闭或重新初始化）"""
    global _db_manager
    if _db_manager is not None:
        # 关闭连接
        if hasattr(_db_manager._local, 'conn') and _db_manager._local.conn:
            try:
                _db_manager._local.conn.close()
            except Exception:
                pass
        _db_manager._local.conn = None
    _db_manager = None


def init_db(db_path: Optional[str] = None) -> DatabaseManager:
    """
    初始化数据库

    Args:
        db_path: 数据库文件路径

    Returns:
        DatabaseManager 实例
    """
    return get_db_manager(db_path)
