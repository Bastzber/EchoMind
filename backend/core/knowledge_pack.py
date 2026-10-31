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

        pack_mode = str(manifest.get('pack_mode') or 'full')
        report: Dict[str, Any] = {
            'files': int(manifest.get('files') or 0),
            'pack_mode': pack_mode,
        }
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
                    # 增量包必须并进现有集合：新建 shadow 再切换会把旧向量丢掉
                    merge_into_active=(pack_mode == 'delta'),
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

def _read_pack_shas(pack_path: Path) -> set:
    """读一个已有知识包的 sha256 集合（生成增量包时用来排除已包含的文件）。"""
    import zipfile

    shas = set()
    with zipfile.ZipFile(pack_path) as zf:
        with zf.open('metadata.jsonl') as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    shas.add(str(json.loads(line).get('sha256') or '').lower())
                except Exception:
                    continue
    return shas


def export_pack(
    db_manager,
    project_id: str,
    out_path: Path,
    progress: Optional[Callable[[str, int, int], None]] = None,
    base_pack: Optional[Path] = None,
) -> Dict[str, Any]:
    """把当前库导出成知识包（描述 + 标签 + 两套向量），返回汇总。"""
    import hashlib
    import os
    import struct
    import zipfile

    import numpy as np

    from core.indexer import get_chroma_client, safe_project_chroma_path

    MAGIC = b'ECHOVEC1'
    started = time.time()
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    work_dir = Path(tempfile.mkdtemp(prefix='kpack-out-'))
    try:
        with db_manager.get_cursor() as cursor:
            rows = [dict(r) for r in cursor.execute(
                'SELECT file_uuid, sha256, path, filename, ai_description, tags '
                'FROM files WHERE project_id=? AND sha256 IS NOT NULL ORDER BY path',
                (project_id,),
            ).fetchall()]
        if not rows:
            raise KnowledgePackError('库里没有带 sha256 的文件，先导入音效并补算哈希')

        pack_mode = 'full'
        base_count = 0
        if base_pack:
            # 增量包：只带「基线包里没有的文件」（新增的），已存在的一律不动，
            # 避免把对方手工改过的描述覆盖掉。
            base_shas = _read_pack_shas(Path(base_pack))
            base_count = len(base_shas)
            before = len(rows)
            rows = [r for r in rows if str(r['sha256']).lower() not in base_shas]
            pack_mode = 'delta'
            logger.info(
                '[KnowledgePack] 增量导出：基线 %d 条，本次新增 %d 条（总 %d）',
                base_count, len(rows), before,
            )
            if not rows:
                raise KnowledgePackError('对比基线包后没有新增文件，不需要增量包')

        paths = [str(r['path']) for r in rows]
        try:
            root = os.path.commonpath(paths)
        except Exception:
            root = os.path.dirname(paths[0])
        if os.path.isfile(root):
            root = os.path.dirname(root)

        meta_path = work_dir / 'metadata.jsonl'
        vocab: Dict[str, int] = {}
        with open(meta_path, 'w', encoding='utf-8', newline='\n') as fh:
            for index, r in enumerate(rows):
                try:
                    tags = json.loads(r['tags'] or '[]')
                except Exception:
                    tags = []
                for tag in tags:
                    vocab[str(tag)] = vocab.get(str(tag), 0) + 1
                fh.write(json.dumps({
                    'sha256': str(r['sha256']).lower(),
                    'rel': os.path.relpath(str(r['path']), root),
                    'filename': r['filename'],
                    'description': r['ai_description'] or '',
                    'tags': tags,
                }, ensure_ascii=False) + '\n')
                if progress and index % 5000 == 0:
                    progress('metadata', index, len(rows))

        sha_by_uuid = {str(r['file_uuid']): bytes.fromhex(str(r['sha256'])) for r in rows}
        manifest: Dict[str, Any] = {
            'pack_version': 1,
            'pack_kind': 'knowledge',
            'created_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'project_source': project_id,
            'library_root': root,
            'pack_mode': pack_mode,
            'base_pack_files': base_count,
            'files': len(rows),
            'vocabulary': sorted(vocab.items(), key=lambda kv: -kv[1])[:4000],
            'kinds': {},
        }

        with db_manager.get_cursor() as cursor:
            manifests = {
                str(r['kind']): dict(r)
                for r in cursor.execute(
                    'SELECT kind, collection_name, engine_fingerprint, model_id, model_revision, '
                    '       dimensions, preprocessing_version FROM index_manifests '
                    'WHERE project_id=? AND state=?', (project_id, 'ready'),
                ).fetchall()
            }

        client = get_chroma_client(str(safe_project_chroma_path(project_id, create=False)))
        for kind in ('audio_vector', 'text_vector'):
            mf = manifests.get(kind)
            if not mf:
                logger.warning('[KnowledgePack] 跳过 %s（没有 ready manifest）', kind)
                continue
            collection = client.get_collection(mf['collection_name'])
            dim = int(mf['dimensions'] or 512)
            bin_path = work_dir / f'{kind}.bin'
            written = 0
            offset = 0
            total = collection.count()
            with open(bin_path, 'wb') as fh:
                fh.write(MAGIC + struct.pack('<IIIB', 1, 0, dim, 1))
                while offset < total:
                    got = collection.get(limit=2000, offset=offset, include=['embeddings'])
                    ids = got.get('ids') or []
                    embeddings = got.get('embeddings')
                    if not ids or embeddings is None:
                        break
                    for i, file_id in enumerate(ids):
                        sha = sha_by_uuid.get(str(file_id))
                        if sha is None:
                            continue
                        vec = np.asarray(embeddings[i], dtype=np.float16)
                        fh.write(sha + vec.tobytes())
                        written += 1
                    offset += len(ids)
                    if progress:
                        progress(kind, offset, total)
            with open(bin_path, 'r+b') as fh:
                fh.seek(12)
                fh.write(struct.pack('<I', written))

            digest = hashlib.sha256()
            with open(bin_path, 'rb') as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b''):
                    digest.update(chunk)
            manifest['kinds'][kind] = {
                'file': bin_path.name,
                'count': written,
                'dim': dim,
                'dtype': 'float16',
                'metric': 'cosine',
                'file_bytes': bin_path.stat().st_size,
                'checksum': digest.hexdigest(),
                'engine_fingerprint': mf.get('engine_fingerprint'),
                'model_id': mf.get('model_id'),
                'model_revision': mf.get('model_revision'),
                'preprocessing_version': mf.get('preprocessing_version'),
            }

        (work_dir / 'manifest.json').write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8'
        )
        with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_STORED) as zf:
            zf.write(work_dir / 'manifest.json', 'manifest.json')
            zf.write(meta_path, 'metadata.jsonl')
            for info in manifest['kinds'].values():
                zf.write(work_dir / info['file'], info['file'])

        return {
            'path': str(out_path),
            'files': len(rows),
            'size_mb': round(out_path.stat().st_size / 1024 / 1024, 1),
            'kinds': list(manifest['kinds'].keys()),
            'seconds': round(time.time() - started, 1),
        }
    finally:
        import shutil

        shutil.rmtree(work_dir, ignore_errors=True)