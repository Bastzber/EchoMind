# -*- coding: utf-8 -*-
"""自然语言搜索接口：给 PR 面板（CEP）用。

POST /api/v1/ai/nl-search
    一句话 → DeepSeek 解析成 {关键词, 标签, 时长, 声道}
    → ① 词命中检索（IDF 倒排，快且准）
      ② 混合语义检索（向量，慢一点，补「不像字面但听起来像」的）
    → 合并返回：词命中在前，语义命中在后，各自带 match 标记。

为什么两路都跑：这个库有 6.5 万条，纯向量搜索对中文短句并不敏感
（实测「低沉的猪哼」会返回鼓点），而「词命中」对「猪」「哼」这种词很准；
两路合并才既准又全。语义那路带超时，超时就静默跳过。

为什么放在后端而不是面板里：面板是明文 JS，Key 必须留在本机后端。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from core import nl_query
from core.llm_client import get_llm_client

logger = logging.getLogger(__name__)
router = APIRouter(tags=["ai"])

LLM_TIMEOUT_SECONDS = 12.0
SEMANTIC_TIMEOUT_SECONDS = 10.0


class NLSearchRequest(BaseModel):
    """一句话搜索。"""

    query: str = Field(..., min_length=1, description="用户的自然语言描述")
    project_id: str = Field(..., min_length=1)
    limit: int = Field(default=30, ge=1, le=100)
    use_llm: bool = Field(default=True, description="关掉就只做关键词搜索")
    include_semantic: bool = Field(
        default=False,
        description="是否再跑一遍向量语义检索（更全但慢很多，面板默认不开）",
    )


async def _parse_with_llm(text: str) -> Dict[str, Any]:
    """调一次 DeepSeek，把一句话翻成检索条件。失败抛异常，由调用方降级。"""
    client = get_llm_client()
    if not client.is_available:
        raise RuntimeError("LLM 未配置")

    async def _collect() -> str:
        chunks: List[str] = []
        async for chunk in client.chat(
            [{"role": "user", "content": text}],
            system_prompt=nl_query.SYSTEM_PROMPT,
            temperature=0.1,
            max_tokens=400,
            stream=False,
        ):
            kind = chunk.get("type")
            if kind == "content":
                chunks.append(chunk.get("content") or "")
            elif kind == "error":
                raise RuntimeError(chunk.get("message") or "LLM 调用失败")
        return "".join(chunks)

    content = await asyncio.wait_for(_collect(), timeout=LLM_TIMEOUT_SECONDS)
    parsed = nl_query._extract_json(content)
    if not parsed:
        raise RuntimeError("LLM 没有返回可解析的 JSON")
    return nl_query.normalize(parsed, text)


def _enrich(db_manager: Any, project_id: str, rows: List[Dict[str, Any]]) -> None:
    """给语义结果补上标签和一句话描述（一次 IN 查完，不逐条查）。"""
    ids = [str(row.get("id") or "") for row in rows if row.get("id")]
    if not ids:
        return
    info: Dict[str, Dict[str, Any]] = {}
    for start in range(0, len(ids), 400):
        chunk = ids[start : start + 400]
        marks = ",".join("?" for _ in chunk)
        try:
            with db_manager.get_cursor() as cursor:
                found = cursor.execute(
                    "SELECT file_uuid, ai_description, tags FROM files "
                    f"WHERE project_id=? AND file_uuid IN ({marks})",
                    (project_id, *chunk),
                ).fetchall()
        except Exception as exc:
            logger.warning("[NLSearch] 补标签失败: %s", exc)
            return
        for row in found:
            try:
                tags = json_loads(row["tags"])
            except Exception:
                tags = []
            info[str(row["file_uuid"])] = {
                "tags": [str(t) for t in tags if str(t).strip()],
                "description": str(row["ai_description"] or ""),
            }
    for row in rows:
        extra = info.get(str(row.get("id") or ""))
        if not extra:
            continue
        row.setdefault("tags", extra["tags"])
        row.setdefault("description", extra["description"])


def json_loads(raw: Any) -> List[Any]:
    import json

    try:
        value = json.loads(raw or "[]")
    except Exception:
        return []
    return value if isinstance(value, list) else []


@router.post("/api/v1/ai/nl-search")
async def nl_search(payload: NLSearchRequest):
    """自然语言搜索：词命中 + 语义混合，词命中优先。"""
    import main as _main
    from core import similar as _similar
    from models import schemas

    text_query = payload.query.strip()
    if payload.use_llm:
        try:
            interpreted = await _parse_with_llm(text_query)
        except Exception as exc:
            logger.warning("[NLSearch] 解析降级: %s", exc)
            interpreted = nl_query.fallback(text_query, "AI 解析失败")
    else:
        interpreted = nl_query.fallback(text_query)

    db_manager = _main.get_db_manager()
    project_id = payload.project_id
    query_text = nl_query.build_query_string(interpreted, text_query)

    # ① 词命中：快、准，先把「猪」「哼」这种字面就对得上的捞出来
    term_items: List[Dict[str, Any]] = []
    try:
        term_hits = await asyncio.to_thread(
            _similar.search_by_terms, db_manager, project_id, query_text,
        )
        for hit in term_hits:
            term_items.append(
                {
                    "id": hit.get("file_uuid"),
                    "path": hit.get("path") or "",
                    "filename": hit.get("filename") or "",
                    "duration": float(hit.get("duration") or 0.0),
                    "sample_rate": 0,
                    "channels": 0,
                    "format": (hit.get("filename") or "").rsplit(".", 1)[-1].lower(),
                    "score": float(hit.get("score") or 0.0),
                    "tags": hit.get("tags") or [],
                    "description": hit.get("description") or "",
                    "matched_terms": hit.get("matched_terms") or [],
                    "match": "term",
                }
            )
    except Exception as exc:
        logger.warning("[NLSearch] 词检索失败: %s", exc)

    # 时长/声道约束对词命中同样生效：LLM 说「短一点」提取出 max_duration 时，
    # 不能让 8.9 秒的猪叫混进来。全被滤掉就放宽（并告诉调用方）。
    min_d = interpreted.get("min_duration")
    max_d = interpreted.get("max_duration")
    filters_relaxed = False
    if (min_d or max_d) and term_items:
        kept = [
            item for item in term_items
            if (not min_d or item["duration"] >= float(min_d))
            and (not max_d or item["duration"] <= float(max_d))
        ]
        if kept:
            term_items = kept
        else:
            filters_relaxed = True

    # ② 语义：慢（实测单次 6~15 秒，向量检索把事件循环占住，超时也不一定能及时中断），
    # 所以**默认不跑**。要「更全但不至于等十秒」的时候，由调用方显式打开。
    semantic_items: List[Dict[str, Any]] = []
    semantic_ok = True
    semantic_budget = SEMANTIC_TIMEOUT_SECONDS
    if not payload.include_semantic:
        semantic_ok = False
    if payload.include_semantic:
        request = schemas.SearchRequest(
            query=query_text,
            project_id=project_id,
            top_k=max(60, payload.limit * 3),
            threshold=0.15,
            page=1,
            page_size=payload.limit,
            min_duration=interpreted.get("min_duration"),
            max_duration=interpreted.get("max_duration"),
            channels=interpreted.get("channels"),
        )
        try:
            response = await asyncio.wait_for(
                _main.search_audio(request), timeout=semantic_budget
            )
            for item in getattr(response, "results", []) or []:
                audio = getattr(item, "audio_file", None)
                semantic_items.append(
                    {
                        "id": getattr(audio, "id", None),
                        "path": getattr(audio, "path", "") or "",
                        "filename": getattr(audio, "filename", "") or "",
                        "duration": float(getattr(audio, "duration", 0) or 0),
                        "sample_rate": int(getattr(audio, "sample_rate", 0) or 0),
                        "channels": int(getattr(audio, "channels", 0) or 0),
                        "format": getattr(audio, "format", "") or "",
                        "score": float(getattr(item, "score", 0) or 0),
                        "tags": [],
                        "description": "",
                        "matched_terms": [],
                        "match": "semantic",
                    }
                )
            _enrich(db_manager, project_id, semantic_items)
        except asyncio.TimeoutError:
            semantic_ok = False
            logger.info("[NLSearch] 语义检索超过 %.0fs，只用词命中结果", SEMANTIC_TIMEOUT_SECONDS)
        except HTTPException:
            raise
        except Exception as exc:
            semantic_ok = False
            logger.warning("[NLSearch] 语义检索失败: %s", exc)

    # 合并：词命中在前；语义结果只补没被覆盖的
    results: List[Dict[str, Any]] = list(term_items)
    seen = {str(item.get("id") or "") for item in results}
    for item in semantic_items:
        if str(item.get("id") or "") in seen:
            continue
        results.append(item)
        if len(results) >= payload.limit:
            break
    results = [item for item in results if item.get("id")][: payload.limit]

    return {
        "success": True,
        "degraded": bool(interpreted.get("degraded")),
        "semantic_ok": semantic_ok,
        "filters_relaxed": filters_relaxed,
        "interpreted": interpreted,
        "query_used": query_text,
        "total": len(results),
        "counts": {"term": len(term_items), "semantic": len(semantic_items)},
        "results": results,
    }