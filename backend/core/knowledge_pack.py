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


def _import_metadata(db, project_id: str, meta_path: Path, progress=None) -> Dict[str, Any]:
    """把包里的描述/标签写进库。

    匹配走 metadata_pack 的四级规则（sha256 → 全路径 → 父目录+文件名 → 唯一文件名），
    **不是只有 sha256**。新工程刚导完音效库时哈希还在后台补算，只按 sha256 匹配
    会一条都对不上（用户 11-01 16:4x 遇到的就是这个：明明文件都在，却要等哈希）。
    """
    from core import metadata_pack

    items: List[Dict[str, Any]] = []
    with open(meta_path, 'r', encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                items.append(json.loads(line))
            except Exception:
                continue

    if progress:
        progress('metadata', 0, len(items))
    preview = metadata_pack.preview(project_id, items, db)
    pairs = preview.get('pairs') or []
    matched = len(pairs)
    missing = int(preview.get('unmatched') or 0) + int(preview.get('ambiguous') or 0)
    # 补时长：新库导入时 scanner 跳过了 probe（duration=0），这里用包里的值填上。
    # 只填空的，不覆盖本地已有的时长。
    durs = [
        (
            float(pair.get('duration') or 0.0),
            int(pair.get('sample_rate') or 0),
            int(pair.get('channels') or 0),
            str(pair.get('file_uuid') or ''),
        )
        for pair in pairs
        if float(pair.get('duration') or 0.0) > 0 and pair.get('file_uuid')
    ]
    if durs:
        try:
            with db.get_cursor() as cursor:
                cursor.executemany(
                    "UPDATE files SET duration=?, sample_rate=?, channels=? "
                    "WHERE file_uuid=? AND (duration IS NULL OR duration<=0)",
                    durs,
                )
        except Exception as exc:
            logger.warning('[KnowledgePack] 补时长失败: %s', exc)

    applied = 0
    if pairs:
        result = metadata_pack.apply(
            project_id, pairs, overwrite=False, db_manager=db,
            progress=(lambda stage, done, total: progress('metadata', done, total)) if progress else None,
        )
        applied = int(result.get('applied') or 0)
    return {
        'matched': matched,
        'missing': missing,
        'applied': applied,
        'by_kind': preview.get('by_kind') or {},
        'pairs': pairs,
    }


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
        report['metadata'] = {k: v for k, v in meta.items() if k != 'pairs'}
        logger.info('[KnowledgePack] 元数据：%s', report['metadata'])

        # 向量导入也要按「包内 sha → 本地文件」走：新库 sha256 还没算完时，
        # 只查 DB 的 sha 列会一条都匹配不上，向量进不去、工件永远 pending。
        sha_rows: Dict[str, Dict[str, Any]] = {}
        pairs = meta.get('pairs') or []
        if pairs:
            uuids = [str(p.get('file_uuid')) for p in pairs if p.get('file_uuid')]
            rows_by_uuid: Dict[str, Dict[str, Any]] = {}
            for start in range(0, len(uuids), 400):
                chunk = uuids[start:start + 400]
                marks = ','.join('?' for _ in chunk)
                with db_manager.get_cursor() as cursor:
                    for row in cursor.execute(
                        f"SELECT file_uuid, filename, path, duration, file_size, "
                        f"       ai_description, tags FROM files WHERE file_uuid IN ({marks})",
                        chunk,
                    ):
                        rows_by_uuid[str(row['file_uuid'])] = dict(row)
            for pair in pairs:
                sha_key = str(pair.get('sha256') or '').lower()
                row = rows_by_uuid.get(str(pair.get('file_uuid')))
                if sha_key and row:
                    sha_rows[sha_key] = row

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
                    sha_rows=sha_rows,
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

def _meta_signature(description: str, tags: Any) -> str:
    """描述+标签的稳定指纹：用来判断「这条文件的元数据变过没有」。"""
    names = [str(tag).strip() for tag in (tags or []) if str(tag).strip()]
    return json.dumps(
        {'description': str(description or '').strip(), 'tags': sorted(names)},
        ensure_ascii=False,
        sort_keys=True,
    )


def _read_pack_meta(pack_path: Path) -> Dict[str, Dict[str, Any]]:
    """读一个已有知识包：sha256 -> {description, tags, signature}（生成增量包用）。"""
    import zipfile

    meta: Dict[str, Dict[str, Any]] = {}
    with zipfile.ZipFile(pack_path) as zf:
        with zf.open('metadata.jsonl') as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except Exception:
                    continue
                key = str(item.get('sha256') or '').lower()
                if not key:
                    continue
                meta[key] = {
                    'description': str(item.get('description') or ''),
                    'tags': list(item.get('tags') or []),
                    'signature': _meta_signature(
                        item.get('description'), item.get('tags')
                    ),
                }
    return meta


def _read_pack_shas(pack_path: Path) -> set:
    """读一个已有知识包的 sha256 集合（兼容旧调用）。"""
    return set(_read_pack_meta(pack_path))


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
                'SELECT file_uuid, sha256, path, filename, ai_description, tags, '
                'duration, sample_rate, channels '
                'FROM files WHERE project_id=? AND sha256 IS NOT NULL ORDER BY path',
                (project_id,),
            ).fetchall()]
        if not rows:
            raise KnowledgePackError('库里没有带 sha256 的文件，先导入音效并补算哈希')

        pack_mode = 'full'
        base_count = 0
        new_count = 0
        changed_count = 0
        if base_pack:
            # 增量包带两类文件：
            #   1. 基线包里没有的（新增文件）；
            #   2. 基线包里已有、但描述或标签变了的（A4）。
            # 元数据没变的一律不动，避免把对方手工改过的内容覆盖掉。
            base_meta = _read_pack_meta(Path(base_pack))
            base_count = len(base_meta)
            before = len(rows)
            new_rows, changed_rows = _split_delta_rows(rows, base_meta)
            rows = new_rows + changed_rows
            new_count = len(new_rows)
            changed_count = len(changed_rows)
            pack_mode = 'delta'
            logger.info(
                '[KnowledgePack] 增量导出：基线 %d 条，新增 %d 条，描述/标签变更 %d 条（总 %d）',
                base_count, new_count, changed_count, before,
            )
            if not rows:
                raise KnowledgePackError('对比基线包后没有新增或变更的文件，不需要增量包')

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
                    # 时长/采样率/声道一起带走：新库不用再打开 6 万个文件重读
                    'duration': float(r.get('duration') or 0.0),
                    'sample_rate': int(r.get('sample_rate') or 0),
                    'channels': int(r.get('channels') or 0),
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
            'new_files': new_count,
            'changed_files': changed_count,
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
            'new_files': new_count,
            'changed_files': changed_count,
            'pack_mode': pack_mode,
            'size_mb': round(out_path.stat().st_size / 1024 / 1024, 1),
            'kinds': list(manifest['kinds'].keys()),
            'seconds': round(time.time() - started, 1),
        }
    finally:
        import shutil

        shutil.rmtree(work_dir, ignore_errors=True)

def _split_delta_rows(
    rows: List[Dict[str, Any]], base_meta: Dict[str, Dict[str, Any]]
) -> tuple:
    """按基线包把当前行分成「新增」和「描述/标签变更」两类（A4）。"""
    new_rows: List[Dict[str, Any]] = []
    changed_rows: List[Dict[str, Any]] = []
    for row in rows:
        base_item = base_meta.get(str(row['sha256']).lower())
        if base_item is None:
            new_rows.append(row)
            continue
        try:
            tags = json.loads(row['tags'] or '[]')
        except Exception:
            tags = []
        if _meta_signature(row['ai_description'], tags) != base_item['signature']:
            changed_rows.append(row)
    return new_rows, changed_rows
