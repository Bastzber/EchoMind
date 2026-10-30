# -*- coding: utf-8 -*-
"""知识包导入：描述 + 标签 + 两套向量，一个 zip 一次搞定。

包结构（由 scripts/export_knowledge_pack.py 生成）：
  manifest.json     版本、条数、模型指纹、两个 bin 的 checksum
  metadata.jsonl    每行 {sha256, rel, filename, description, tags[]}
  audio_vectors.bin / text_vectors.bin   定长二进制（21 字节头 + 1056 字节/条）
"""
from __future__ import annotations

import json
import logging
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


class KnowledgePackError(RuntimeError):
    """知识包不合法（消息直接给用户看）。"""


def inspect_pack(zip_path: Path) -> Dict[str, Any]:
    """只读 manifest，用来在导入前给用户看条数/大小。"""
    zip_path = Path(zip_path)
    if not zip_path.is_file():
        raise KnowledgePackError(f'找不到知识包: {zip_path}')
    try:
        with zipfile.ZipFile(zip_path) as zf:
            manifest = json.loads(zf.read('manifest.json').decode('utf-8'))
    except Exception as exc:
        raise KnowledgePackError(f'知识包解析失败: {exc}') from exc
    if manifest.get('pack_kind') != 'knowledge':
        raise KnowledgePackError('不是知识包（pack_kind 不对）')
    return {
        'files': int(manifest.get('files') or 0),
        'kinds': list((manifest.get('kinds') or {}).keys()),
        'size_mb': round(zip_path.stat().st_size / 1024 / 1024, 1),
        'created_at': manifest.get('created_at'),
        'library_root': manifest.get('library_root'),
    }


def _prepare_kind_manifests(manifest: Dict[str, Any], work_dir: Path) -> None:
    """把合并 manifest 里的 kinds 拆成 vector_pack 认识的分文件格式。"""
    for kind, info in (manifest.get('kinds') or {}).items():
        payload = {
            'pack_version': 1,
            'pack_id': 'knowledge-' + kind,
            'created_at': manifest.get('created_at'),
            'kind': kind,
            'file': info.get('file'),
            'count': info.get('count'),
            'dimensions': info.get('dim'),
            'dtype': info.get('dtype') or 'float16',
            'metric': info.get('metric') or 'cosine',
            'checksum': info.get('checksum'),
            'engine_fingerprint': info.get('engine_fingerprint'),
            'model_id': info.get('model_id'),
            'model_revision': info.get('model_revision'),
            'preprocessing_version': info.get('preprocessing_version'),
        }
        (work_dir / f'manifest-{kind}.json').write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8'
        )


def _import_metadata(db, project_id: str, meta_path: Path, progress=None) -> Dict[str, int]:
    """按 sha256 把描述/标签写进库；没命中的只统计不报错。"""
    from core import metadata_pack

    sha_to_row: Dict[str, Dict[str, Any]] = {}
    with db.get_cursor() as cursor:
        for row in cursor.execute(
            'SELECT file_uuid, sha256 FROM files WHERE project_id=? AND sha256 IS NOT NULL',
            (project_id,),
        ):
            data = dict(row)
            sha_to_row[str(data['sha256']).lower()] = data

    pairs: List[Dict[str, Any]] = []
    matched = 0
    missing = 0
    with open(meta_path, 'r', encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except Exception:
                continue
            row = sha_to_row.get(str(item.get('sha256') or '').lower())
            if row is None:
                missing += 1
                continue
            matched += 1
            if progress and matched % 2000 == 0:
                progress('metadata', matched, 0)
            pairs.append({
                'file_uuid': str(row['file_uuid']),
                'description': str(item.get('description') or ''),
                'tags': item.get('tags') or [],
            })
    applied = 0
    if pairs:
        result = metadata_pack.apply(project_id, pairs, overwrite=False, db_manager=db)
        applied = int(result.get('applied') or 0)
    return {'matched': matched, 'missing': missing, 'applied': applied}


def import_pack(
    db_manager,
    project_id: str,
    zip_path: Path,
    progress: Optional[Callable[[str, int, int], None]] = None,
    cancelled: Optional[Callable[[], bool]] = None,
) -> Dict[str, Any]:
    """导入知识包：解压 → 写描述标签 → 导入两套向量 → 汇总。"""
    from core import vector_pack

    started = time.time()
    zip_path = Path(zip_path)
    if not zip_path.is_file():
        raise KnowledgePackError(f'找不到知识包: {zip_path}')

    work_dir = Path(tempfile.mkdtemp(prefix='kpack-'))
    try:
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(work_dir)
        manifest = json.loads((work_dir / 'manifest.json').read_text(encoding='utf-8'))
        if manifest.get('pack_kind') != 'knowledge':
            raise KnowledgePackError('不是知识包（pack_kind 不对）')
        _prepare_kind_manifests(manifest, work_dir)

        report: Dict[str, Any] = {'files': int(manifest.get('files') or 0)}
        if progress:
            progress('metadata', 0, report['files'])
        meta = _import_metadata(db_manager, project_id, work_dir / 'metadata.jsonl', progress)
        report['metadata'] = meta
        logger.info('[KnowledgePack] 元数据：%s', meta)

        kinds_report: Dict[str, Any] = {}
        for kind, info in (manifest.get('kinds') or {}).items():
            if cancelled and cancelled():
                raise KnowledgePackError('已取消导入')
            if progress:
                progress(kind, 0, int(info.get('count') or 0))
            try:
                result = vector_pack.import_pack(
                    db_manager, project_id, kind, work_dir, None,
                    (lambda done, matched, _k=kind: progress(_k, done, int(info.get('count') or 0))) if progress else None,
                    cancelled,
                )
                kinds_report[kind] = result
            except vector_pack.VectorPackError as exc:
                # 向量缺失不该让整个包失败：元数据已经写进去了
                logger.warning('[KnowledgePack] %s 导入失败: %s', kind, exc)
                kinds_report[kind] = {'error': str(exc)}
        report['kinds'] = kinds_report
        report['seconds'] = round(time.time() - started, 1)
        return report
    finally:
        import shutil

        shutil.rmtree(work_dir, ignore_errors=True)