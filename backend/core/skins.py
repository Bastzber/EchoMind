# -*- coding: utf-8 -*-
"""皮肤 / 主题包。

包结构（放在 %APPDATA%\\EchoMind\\skins\\<id>\\）：
    theme.json   必填，元信息 + 颜色变量
    theme.css    可选，附加样式（会做安全过滤）
    preview.png  可选

安全边界：
- 只允许覆盖白名单里的 CSS 变量
- 自定义 CSS 里禁止 @import / url(http…) / javascript:
- 单个皮肤目录不超过 50 MB
"""
from __future__ import annotations

import json
import os
import re
import shutil
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

MAX_SKIN_BYTES = 50 * 1024 * 1024

# 允许被皮肤覆盖的 CSS 变量（白名单）
ALLOWED_VARS = {
    "--bg-primary", "--bg-secondary", "--bg-tertiary",
    "--border-color", "--text-primary", "--text-secondary", "--text-muted",
    "--accent-color", "--accent-hover", "--waveform-color", "--waveform-active",
    "--sidebar-bg", "--header-bg", "--card-bg",
}

FORBIDDEN_PATTERNS = [
    re.compile(r"@import", re.IGNORECASE),
    re.compile(r"url\(\s*['\"]?https?:", re.IGNORECASE),
    re.compile(r"url\(\s*['\"]?//", re.IGNORECASE),
    re.compile(r"javascript:", re.IGNORECASE),
    re.compile(r"expression\s*\(", re.IGNORECASE),
    re.compile(r"<script", re.IGNORECASE),
]

BUILTIN: List[Dict[str, object]] = [
    {
        "id": "default",
        "name": "默认（深色）",
        "author": "回声",
        "version": "1.0",
        "builtin": True,
        "colors": {},
        "css": "",
    },
    {
        "id": "midnight",
        "name": "午夜蓝",
        "author": "回声",
        "version": "1.0",
        "builtin": True,
        "colors": {
            "--bg-primary": "#0b1020",
            "--bg-secondary": "#121a2e",
            "--bg-tertiary": "#1b2540",
            "--border-color": "#2b3a5c",
            "--text-primary": "#e6ecff",
            "--text-secondary": "#a9b8d8",
            "--accent-color": "#5b8cff",
            "--header-bg": "#0e1526",
            "--sidebar-bg": "#0d1424",
        },
        "css": "",
    },
    {
        "id": "graphite",
        "name": "石墨灰",
        "author": "回声",
        "version": "1.0",
        "builtin": True,
        "colors": {
            "--bg-primary": "#141414",
            "--bg-secondary": "#1c1c1c",
            "--bg-tertiary": "#262626",
            "--border-color": "#333333",
            "--text-primary": "#ededed",
            "--text-secondary": "#a8a8a8",
            "--accent-color": "#b0b0b0",
            "--header-bg": "#171717",
            "--sidebar-bg": "#151515",
        },
        "css": "",
    },
]


def skins_root() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home())
    path = Path(base) / "EchoMind" / "skins"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _sanitize_css(css: str) -> str:
    if not css:
        return ""
    for pattern in FORBIDDEN_PATTERNS:
        if pattern.search(css):
            raise ValueError("皮肤 CSS 含有不允许的内容（@import / 远程 url / 脚本）")
    return css[:200_000]


def _validate_colors(colors: Dict[str, str]) -> Dict[str, str]:
    clean = {}
    for key, value in (colors or {}).items():
        if key not in ALLOWED_VARS:
            continue
        text = str(value).strip()
        if not text or len(text) > 64:
            continue
        if re.search(r"[<>\"'();{}]", text):
            continue
        clean[key] = text
    return clean


def load_user_skin(directory: Path) -> Optional[Dict[str, object]]:
    manifest = directory / "theme.json"
    if not manifest.is_file():
        return None
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except Exception:
        return None
    skin_id = str(data.get("id") or directory.name)
    css = ""
    css_file = directory / "theme.css"
    if css_file.is_file():
        try:
            css = _sanitize_css(css_file.read_text(encoding="utf-8", errors="replace"))
        except ValueError:
            css = ""
    return {
        "id": skin_id,
        "name": str(data.get("name") or skin_id),
        "author": str(data.get("author") or "未知"),
        "version": str(data.get("version") or "1.0"),
        "builtin": False,
        "colors": _validate_colors(data.get("colors") or {}),
        "css": css,
    }


def list_skins() -> List[Dict[str, object]]:
    items = [dict(item) for item in BUILTIN]
    for directory in sorted(skins_root().iterdir()):
        if not directory.is_dir():
            continue
        skin = load_user_skin(directory)
        if skin:
            items.append(skin)
    return items


def find_skin(skin_id: str) -> Optional[Dict[str, object]]:
    for item in list_skins():
        if item["id"] == skin_id:
            return item
    return None


def import_skin(source: str) -> Dict[str, object]:
    """从目录导入一个皮肤（zip 由前端解压后再传目录）。"""
    source_path = Path(source)
    if not source_path.is_dir():
        raise ValueError("请选择一个皮肤文件夹")
    total = sum(f.stat().st_size for f in source_path.rglob("*") if f.is_file())
    if total > MAX_SKIN_BYTES:
        raise ValueError("皮肤包超过 50 MB")

    manifest = source_path / "theme.json"
    if not manifest.is_file():
        raise ValueError("缺少 theme.json")
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError(f"theme.json 解析失败: {exc}")

    skin_id = str(data.get("id") or "").strip() or source_path.name
    if not re.fullmatch(r"[\w\u4e00-\u9fff\-.]{1,40}", skin_id):
        raise ValueError("皮肤 id 只能是字母数字、中文、下划线或短横线")
    if skin_id in {item["id"] for item in BUILTIN}:
        raise ValueError("不能覆盖内置皮肤")

    target = skins_root() / skin_id
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    shutil.copytree(source_path, target)
    skin = load_user_skin(target)
    if not skin:
        raise ValueError("皮肤加载失败")
    return skin


def delete_skin(skin_id: str) -> bool:
    if skin_id in {item["id"] for item in BUILTIN}:
        raise ValueError("内置皮肤不能删除")
    target = skins_root() / skin_id
    if not target.is_dir():
        return False
    shutil.rmtree(target, ignore_errors=True)
    return True
