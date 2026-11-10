# -*- coding: utf-8 -*-
"""导出随包附带的两个资源包：EchoMind-描述包.json 和 EchoMind-标签包.json。

为什么要脚本：这两个包一直是「从运行中的应用点导出」的，发版时容易忘、或者拿着上一版
的旧文件去打包（V20 那次就是 11-04 导出的，跟当时库里的数目对不上）。直接读库生成，
随时能重来，也不受后端令牌和界面影响。

格式跟应用导出的一模一样（描述包见 api/routers/descriptions.py 的 export，
标签包是「系统标签 + 我的标签 + 词表」三件套），导入端不用改。

用法：
    python scripts/export_packs.py --out dist-v11-build/win-unpacked
    python scripts/export_packs.py --out <目录> --only desc
    python scripts/export_packs.py --out <目录> --only tags

知识包（带向量，很慢）不在这里：用 scripts/export_knowledge_pack.py。
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def default_db_path() -> Path:
    appdata = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    return Path(appdata) / "EchoMind" / "db" / "soundmind.db"


def detect_library_root(paths: list[str]) -> str:
    """和应用一致的库根推断：按「盘符+首层」分组，取文件数最多那组的公共前缀。"""
    parts_list = [[seg for seg in str(p).replace("/", "\\").split("\\") if seg] for p in paths]
    if not parts_list:
        return ""

    def group_key(parts):
        return ((parts[0] if parts else "") + "\\" + (parts[1] if len(parts) > 1 else "")).lower()

    counts: dict[str, int] = {}
    for parts in parts_list:
        counts[group_key(parts)] = counts.get(group_key(parts), 0) + 1
    main_key = max(counts, key=counts.get)
    common: list[str] = []
    for parts in parts_list:
        if group_key(parts) != main_key:
            continue
        if not common:
            common = parts[:-1]
            continue
        i = 0
        while i < len(common) and i < len(parts) - 1 and common[i].lower() == parts[i].lower():
            i += 1
        common = common[:i]
    return "\\".join(common)


def relative_to_root(path: str, root: str) -> str:
    if not root:
        return str(path)
    norm_path = str(path).replace("/", "\\")
    norm_root = root.replace("/", "\\").rstrip("\\")
    if norm_path.lower().startswith(norm_root.lower() + "\\"):
        return norm_path[len(norm_root) + 1:]
    return norm_path


def load_rows(db: Path, project_id: str):
    con = sqlite3.connect("file:" + db.as_posix() + "?mode=ro", uri=True, timeout=60)
    con.row_factory = sqlite3.Row
    try:
        rows = [dict(r) for r in con.execute(
            "SELECT file_uuid, path, filename, tags, ai_description "
            "FROM files WHERE project_id=? ORDER BY path", (project_id,)
        )]
        tag_name = {r["id"]: r["name"] for r in con.execute("SELECT id, name FROM tags")}
        user_tags: dict[str, list[str]] = {}
        for r in con.execute("SELECT file_uuid, tag_id FROM file_tags"):
            name = tag_name.get(r["tag_id"])
            if name:
                user_tags.setdefault(r["file_uuid"], []).append(name)
        return rows, user_tags
    finally:
        con.close()


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False)
    print("  %s  %.1f MB" % (path.name, path.stat().st_size / 1024 / 1024))


def export_desc(rows, root: str, out: Path) -> int:
    items = []
    for row in rows:
        description = str(row["ai_description"] or "").strip()
        # 跟 api/routers/descriptions.py 的导出保持同一口径：
        # 空描述和 [auto] 兜底描述不进包（导过去也没用）
        if not description or description.startswith("[auto]"):
            continue
        items.append({
            "rel": relative_to_root(row["path"], root),
            "filename": row["filename"],
            "description": description,
            "tags": row["tags"] or "[]",
        })
    write_json(out / "EchoMind-描述包.json", {
        "success": True,
        "version": 1,
        "root": root,
        "count": len(items),
        "items": items,
    })
    return len(items)


def export_tags(rows, user_tags, root: str, out: Path) -> int:
    vocab = collections.Counter()
    items = []
    for row in rows:
        try:
            tags = [str(t) for t in json.loads(row["tags"] or "[]")]
        except Exception:
            tags = []
        mine = sorted(set(user_tags.get(row["file_uuid"], [])))
        for tag in tags + mine:
            vocab[tag] += 1
        items.append({
            "rel": relative_to_root(row["path"], root),
            "filename": row["filename"],
            "tags": tags,
            "user_tags": mine,
        })
    write_json(out / "EchoMind-标签包.json", {
        "version": 1,
        "root": root,
        "count": len(items),
        "vocabulary": [[name, cnt] for name, cnt in vocab.most_common()],
        "items": items,
    })
    return len(items)


def main() -> int:
    parser = argparse.ArgumentParser(description="导出描述包 / 标签包")
    parser.add_argument("--out", required=True, help="输出目录（通常是 win-unpacked）")
    parser.add_argument("--db", default=str(default_db_path()))
    parser.add_argument("--project", default="default")
    parser.add_argument("--only", choices=("desc", "tags"), help="只导一个")
    args = parser.parse_args()

    db = Path(args.db)
    if not db.exists():
        print("[失败] 找不到库:", db)
        return 2
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    started = time.time()
    rows, user_tags = load_rows(db, args.project)
    root = detect_library_root([r["path"] for r in rows])
    print("库      : %s" % db)
    print("文件    : %d 条，我的标签 %d 条记录" % (len(rows), sum(len(v) for v in user_tags.values())))
    print("库根    : %s" % root)
    print("输出    : %s" % out)

    if args.only in (None, "desc"):
        n = export_desc(rows, root, out)
        print("描述包  : %d 条" % n)
    if args.only in (None, "tags"):
        n = export_tags(rows, user_tags, root, out)
        print("标签包  : %d 条" % n)
    print("用时    : %.1f 秒" % (time.time() - started))
    return 0


if __name__ == "__main__":
    sys.exit(main())
