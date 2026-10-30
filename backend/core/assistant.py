# -*- coding: utf-8 -*-
"""大肥鱼 AI 助理：事件式 agent 循环（简化版 Cortico 思路）。

设计：
1. 人设 + 工具清单写进 system prompt，模型每次只返回一个 JSON；
2. 循环最多 4 步：模型要工具 → 执行 → 结果塞回上下文 → 再问；
3. 模型给出 final 回复就结束。

不依赖 provider 的 function calling，任何 OpenAI 兼容模型都能用。
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from core.llm_client import get_llm_client

logger = logging.getLogger(__name__)

PERSONA = """你是「回声」，回声 EchoMind 音效管理器里的 AI 助理（形象是顶栏那位紫发双丸子头的少女）。
- 性格：活泼、嘴甜、偶尔自嘲，但回答要短、要准，不废话。
- 你住在软件顶栏，能帮用户找音效、看索引进度、整理标签、解释功能。
- 用户是中文使用者，默认用中文回答，一句到三句，必要时用列表。
- 关于声音：聊天面板上的「语音」开关打开后，你写下的每条回复都会由本地语音引擎
  （Breeze TTS，少女音）念出来，所以你是有语音输出的。被问到能不能说话时，照实说
  「语音开关打开我就能念出来」，不要说「我没有语音输出能力」。
  你听不到用户的声音，没有麦克风，语音输入不支持——这一半要讲清楚。
"""

TOOLS_DOC = """可用工具（每次只返回一个动作）：
{"action":"search","args":{"query":"纯中文短语，例如 雨声 / 玻璃碎裂","limit":8}}
    在音效库里搜索，返回文件名/路径/分数。
{"action":"stats","args":{}}
    返回库统计：文件总数、标签分布、索引进度。
{"action":"unclassified","args":{"limit":10}}
    返回待归类文件样例与总数。
{"action":"status","args":{}}
    返回索引任务状态。
{"action":"tag","args":{"file":"文件名或路径片段","tags":["标签1","标签2"]}}
    给匹配到的文件追加标签（只加不改）。
{"action":"move","args":{"file":"文件名或路径片段","target_dir":"目标文件夹绝对路径"}}
    把文件移动到目标目录（保留标签与索引）。
{"action":"transcode","args":{"file":"文件名或路径片段","target_format":"wav"}}
    给文件排一个转码任务（后台执行）。
{"action":"remember","args":{"fact":"用户偏好或事实"}}
    记住一条长期偏好（例如「他常找雨声环境音」）。
{"action":"reply","text":"给用户的回复"}
    直接回答，不再调用工具。
"""

SYSTEM_PROMPT = PERSONA + "\n" + TOOLS_DOC + """
规则：
- 只输出一个 JSON 对象，不要代码块，不要多余文字。
- 需要库数据时先调工具，拿到结果再回答。
- search 的 query 只写中文短语，不要中英混排，不要加解释词。
- 工具结果不足以回答时如实说明，不要编造文件。
"""


def _stats(db) -> Dict[str, Any]:
    with db.get_cursor() as cursor:
        total = cursor.execute("SELECT COUNT(*) FROM files WHERE project_id='default'").fetchone()[0]
        rows = cursor.execute("SELECT tags FROM files WHERE project_id='default'").fetchall()
        dist = {"0": 0, "1-5": 0, "6+": 0}
        for (tags,) in rows:
            try:
                n = len(json.loads(tags)) if tags else 0
            except Exception:
                n = 0
            dist["0" if n == 0 else ("1-5" if n < 6 else "6+")] += 1
        artifacts: Dict[str, Dict[str, int]] = {}
        for kind, state, count in cursor.execute(
            "SELECT kind, state, COUNT(*) FROM file_artifacts WHERE project_id='default' GROUP BY kind, state"
        ):
            artifacts.setdefault(kind, {})[state] = count
    return {"total_files": total, "tags": dist, "artifacts": artifacts}


def _unclassified(db, limit: int = 10) -> Dict[str, Any]:
    limit = max(1, min(int(limit or 10), 30))
    with db.get_cursor() as cursor:
        total = cursor.execute(
            "SELECT COUNT(*) FROM files WHERE project_id='default' "
            "AND (path LIKE '%_待归类%' OR path LIKE '%待人工判断%')"
        ).fetchone()[0]
        rows = cursor.execute(
            "SELECT filename, path FROM files WHERE project_id='default' "
            "AND (path LIKE '%_待归类%' OR path LIKE '%待人工判断%') ORDER BY path LIMIT ?",
            (limit,),
        ).fetchall()
    return {"total": total, "samples": [{"name": r[0], "path": r[1]} for r in rows]}


async def _search_once(query: str, limit: int) -> list:
    from core.search_engine import get_optimized_searcher_sync

    searcher = get_optimized_searcher_sync(project_id="default")
    results, _info = await searcher.search_async(
        query=query,
        top_k=max(1, min(int(limit or 8), 20)),
        min_similarity=0.15,
        filters=None,
        use_cache=True,
        fast=False,
    )
    items = []
    for r in results:
        items.append({
            "name": getattr(r, "filename", ""),
            "path": getattr(r, "file_path", ""),
            "score": round(float(getattr(r, "similarity", 0) or getattr(r, "score", 0) or 0), 3),
            "tags": (getattr(r, "metadata", {}) or {}).get("tags") or "",
        })
    return items


async def _search(query: str, limit: int = 8) -> Dict[str, Any]:
    """中英混排的查询会同时拉低两侧向量匹配；先按原句搜，再按纯中文补一次，取更优。"""
    import re as _re

    items = await _search_once(query, limit)
    best = max((i["score"] for i in items), default=0.0)
    cjk = "".join(_re.findall(r"[\u4e00-\u9fff]+", query))
    if cjk and cjk != query.strip() and best < 0.6:
        alt = await _search_once(cjk, limit)
        alt_best = max((i["score"] for i in alt), default=0.0)
        if alt_best > best:
            items, best = alt, alt_best
            query = cjk
    return {"query": query, "count": len(items), "items": items, "top_score": best}

def _status() -> Dict[str, Any]:
    from core import index_progress

    return {"active": index_progress.stats()}



def _ensure_memory(db) -> None:
    with db.get_cursor() as cursor:
        cursor.execute(
            "CREATE TABLE IF NOT EXISTS assistant_memory ("
            "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "  fact TEXT NOT NULL UNIQUE,"
            "  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
        )


def load_memory(db, limit: int = 12) -> List[str]:
    _ensure_memory(db)
    with db.get_cursor() as cursor:
        rows = cursor.execute(
            "SELECT fact FROM assistant_memory ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [r[0] for r in rows]


def save_memory(db, fact: str) -> bool:
    _ensure_memory(db)
    fact = (fact or '').strip()[:200]
    if not fact:
        return False
    with db.get_cursor() as cursor:
        cursor.execute("INSERT OR IGNORE INTO assistant_memory (fact) VALUES (?)", (fact,))
    return True


def _find_file(db, needle: str) -> Optional[Dict[str, Any]]:
    needle = (needle or '').strip()
    if not needle:
        return None
    with db.get_cursor() as cursor:
        row = cursor.execute(
            "SELECT file_uuid, filename, path, COALESCE(tags,'[]') FROM files "
            "WHERE project_id='default' AND (path = ? OR filename = ?) ORDER BY path LIMIT 1",
            (needle, needle),
        ).fetchone()
        if row is None:
            like = f"%{needle}%"
            row = cursor.execute(
                "SELECT file_uuid, filename, path, COALESCE(tags,'[]') FROM files "
                "WHERE project_id='default' AND (filename LIKE ? OR path LIKE ?) "
                "ORDER BY LENGTH(filename), path LIMIT 1",
                (like, like),
            ).fetchone()
    if row is None:
        return None
    return {"file_uuid": row[0], "filename": row[1], "path": row[2], "tags": row[3]}


def _tool_tag(db, args: Dict[str, Any]) -> Dict[str, Any]:
    target = _find_file(db, str(args.get("file") or ""))
    if not target:
        return {"error": "没找到这个文件"}
    new_tags = [str(x).strip() for x in (args.get("tags") or []) if str(x).strip()]
    if not new_tags:
        return {"error": "tags 不能为空"}
    try:
        current = json.loads(target["tags"]) if target["tags"] else []
    except Exception:
        current = []
    merged = current + [x for x in new_tags if x not in current]
    with db.get_cursor() as cursor:
        cursor.execute(
            "UPDATE files SET tags=? WHERE project_id='default' AND file_uuid=?",
            (json.dumps(merged, ensure_ascii=False), target["file_uuid"]),
        )
    return {"ok": True, "file": target["filename"], "tags": merged}


def _tool_move(db, args: Dict[str, Any]) -> Dict[str, Any]:
    import shutil

    from core.database import canonicalize_path

    target = _find_file(db, str(args.get("file") or ""))
    if not target:
        return {"error": "没找到这个文件"}
    src = Path(target["path"])
    dest_dir = Path(str(args.get("target_dir") or ""))
    if not src.is_file():
        return {"error": "源文件不存在"}
    if not dest_dir.is_dir():
        return {"error": "目标目录不存在"}
    dest = dest_dir / src.name
    if dest.exists() and dest.resolve() != src.resolve():
        return {"error": "目标目录已有同名文件"}
    try:
        if dest.resolve() != src.resolve():
            shutil.move(str(src), str(dest))
        with db.get_cursor() as cursor:
            cursor.execute(
                "UPDATE files SET path=?, canonical_path=? WHERE project_id='default' AND file_uuid=?",
                (str(dest), canonicalize_path(str(dest)), target["file_uuid"]),
            )
    except Exception as exc:
        return {"error": f"移动失败: {exc}"}
    return {"ok": True, "file": dest.name, "path": str(dest)}


def _tool_transcode(db, args: Dict[str, Any]) -> Dict[str, Any]:
    target = _find_file(db, str(args.get("file") or ""))
    if not target:
        return {"error": "没找到这个文件"}
    fmt = str(args.get("target_format") or "wav").lower().lstrip(".")
    try:
        from core.transcode import target_extension, transcode_file

        ext = target_extension(fmt)
        src = Path(target["path"])
        dest = src.with_suffix(ext)
        result = transcode_file(str(src), str(dest), fmt)
    except Exception as exc:
        return {"error": f"转码失败: {exc}"}
    return {"ok": bool(result), "file": target["filename"], "target_format": fmt}

async def _run_tool(db, action: str, args: Dict[str, Any]) -> Dict[str, Any]:
    if action == "search":
        return await _search(str(args.get("query") or ""), args.get("limit") or 8)
    if action == "stats":
        return _stats(db)
    if action == "unclassified":
        return _unclassified(db, args.get("limit") or 10)
    if action == "status":
        return _status()
    if action == "tag":
        return _tool_tag(db, args)
    if action == "move":
        return _tool_move(db, args)
    if action == "transcode":
        return _tool_transcode(db, args)
    if action == "remember":
        ok = save_memory(db, str(args.get("fact") or ""))
        return {"ok": ok}
    return {"error": "未知工具: " + str(action)}


def _parse_json(text: str) -> Optional[Dict[str, Any]]:
    text = (text or "").strip()
    fence = chr(96) * 3
    if text.startswith(fence):
        text = text.strip(chr(96))
        if text.startswith("json"):
            text = text[4:]
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        return json.loads(text[start:end + 1])
    except Exception:
        return None


async def run_assistant(messages: List[Dict[str, str]], project_id: str = "default") -> Dict[str, Any]:
    """执行一轮助理对话，返回 {reply, traces}。"""
    from core.database import get_db_manager

    db = get_db_manager()
    client = get_llm_client()
    history: List[Dict[str, str]] = list(messages or [])
    traces: List[Dict[str, Any]] = []
    memories = load_memory(db)
    system_prompt = SYSTEM_PROMPT
    if memories:
        system_prompt += "\n关于用户的已知偏好：\n" + "\n".join("- " + m for m in memories)

    for _step in range(4):
        content = ""
        async for chunk in client.chat(history, system_prompt=system_prompt, temperature=0.5, max_tokens=800, stream=False):
            if chunk.get("type") == "content":
                content += chunk.get("content") or ""
            if chunk.get("type") == "error":
                return {"reply": "大肥鱼暂时连不上模型：" + str(chunk.get("content") or ""), "traces": traces}
        parsed = _parse_json(content)
        if not parsed:
            return {"reply": content.strip()[:800] or "（没听懂，再说一次？）", "traces": traces}

        action = str(parsed.get("action") or "reply")
        if action == "reply":
            return {"reply": str(parsed.get("text") or "").strip() or "…", "traces": traces}

        args = parsed.get("args") or {}
        try:
            result = await _run_tool(db, action, args if isinstance(args, dict) else {})
        except Exception as exc:
            logger.warning("[助理] 工具执行失败 %s: %s", action, exc)
            result = {"error": f"{type(exc).__name__}: {exc}"}
        traces.append({"action": action, "args": args, "result": result})
        history.append({"role": "assistant", "content": json.dumps(parsed, ensure_ascii=False)})
        history.append({
            "role": "user",
            "content": "工具 " + action + " 的结果：\n" + json.dumps(result, ensure_ascii=False)[:3000] + "\n\n请基于结果给出最终回复（action=reply）。",
        })

    return {"reply": "我想了太久，先说到这里。你可以再说具体点。", "traces": traces}