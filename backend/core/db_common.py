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


# 波形峰值存 3 位小数就够：渲染端画的是像素柱，一个柱高 100 档都不到。
# 直接 json.dumps(float32 序列) 会把 float32 展开成 17 位有效数字
# （3.1982603104552254e-05），2000 个点一条 40 KB，6.5 万条 = 2.6 GB，
# 占整个库的 79%（11-10 实测）。
WAVEFORM_PEAK_DECIMALS = 3


def serialize_peaks(peaks) -> Optional[str]:
    """把波形峰值序列压成紧凑 JSON；None 原样返回。"""
    if peaks is None:
        return None
    if isinstance(peaks, str):
        return peaks
    try:
        values = [round(float(value), WAVEFORM_PEAK_DECIMALS) for value in peaks]
    except (TypeError, ValueError):
        return json.dumps(peaks)
    return json.dumps(values, separators=(",", ":"))


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
        self.peaks_json = serialize_peaks(peaks)

    def set_tags(self, tags: List[str]):
        """设置标签"""
        self.tags = json.dumps(tags)

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        result = asdict(self)
        result['peaks'] = self.get_peaks()
        result['tag_list'] = self.get_tags()
        return result


# ---------- 给拆分后的各个 mixin 用的 logger 代理 ----------
class _LoggerProxy:
    """各 mixin 模块里 logger 的转发器。

    logger 是延迟初始化的模块级变量；拆开之后每个模块 import 到的是导入那一刻的快照，
    会一直停在 None。用个代理每次现取，日志就不会丢。
    """
    __slots__ = ()

    def __getattr__(self, item):
        return getattr(_get_logger(), item)


logger_proxy = _LoggerProxy()
