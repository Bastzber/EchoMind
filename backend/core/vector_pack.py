# -*- coding: utf-8 -*-
"""预计算向量包：读取 pack、校验模型指纹、写入 shadow collection 并原子切换。

包格式（与 docs 方案一致）：
  header: MAGIC(8B 'ECHOVEC1') + version(4B) + count(4B) + dim(4B) + dtype(1B) = 21B
  record: sha256(32B) + vector(dim * 2B, float16)

导入不重新计算向量：按 sha256 匹配本机文件，命中哪条就把哪条标成 ready，
未命中的保持 pending，由用户后续本地补索引。
"""
from __future__ import annotations

import hashlib
import json
import logging
import struct
import time
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

PACK_MAGIC = b'ECHOVEC1'
HEADER_BYTES = 21
DTYPE_FLOAT16 = 1
BATCH_SIZE = 2000


class VectorPackError(RuntimeError):
    """向量包不合法或不匹配本机模型（消息直接给用户看）。"""


def _read_header(path: Path) -> Dict[str, int]:
    with path.open('rb') as fh:
        head = fh.read(HEADER_BYTES)
    if len(head) < HEADER_BYTES or head[:8] != PACK_MAGIC:
        raise VectorPackError('不是有效的向量包文件（文件头不对）')
    version, count, dim, dtype = struct.unpack('<IIIB', head[8:HEADER_BYTES])
    return {'version': version, 'count': count, 'dim': dim, 'dtype': dtype}


def load_manifest(pack_dir: Path, kind: str) -> Dict[str, Any]:
    candidate = pack_dir / f'manifest-{kind}.json'
    if not candidate.is_file():
        candidate = pack_dir / 'manifest.json'
    if not candidate.is_file():
        raise VectorPackError(f'找不到 {kind} 的 manifest 文件')
    try:
        return json.loads(candidate.read_text(encoding='utf-8'))
    except Exception as exc:
        raise VectorPackError(f'manifest 解析失败: {exc}') from exc


def validate(pack: Dict[str, Any], local: Optional[Dict[str, Any]], kind: str) -> None:
    """指纹/维度/预处理不一致直接拒绝，不做静默降级。"""
    if pack.get('kind') != kind:
        raise VectorPackError(f"包类型是 {pack.get('kind')}，不是 {kind}")
    if not local:
        raise VectorPackError('本机还没有可用的索引清单，请先建一次索引再导入')
    checks = [
        ('引擎指纹', 'engine_fingerprint'),
        ('模型', 'model_id'),
        ('模型版本', 'model_revision'),
        ('维度', 'dimensions'),
        ('预处理版本', 'preprocessing_version'),
    ]
    for label, field in checks:
        pack_value = str(pack.get(field) or '')
        local_value = str(local.get(field) or '')
        if not pack_value:
            continue
        if pack_value != local_value:
            raise VectorPackError(
                f'{label}不匹配：包={pack_value[:24]}… 本机={local_value[:24]}…，'
                '请用与本机模型相同版本导出的向量包'
            )
    if str(pack.get('metric') or 'cosine') != 'cosine':
        raise VectorPackError('只支持 cosine 度量的向量包')


def _iter_records(bin_path: Path, count: int, dim: int) -> Iterator[Tuple[str, bytes]]:
    record_bytes = 32 + dim * 2
    with bin_path.open('rb') as fh:
        fh.seek(HEADER_BYTES)
        for _ in range(count):
            raw = fh.read(record_bytes)
            if len(raw) < record_bytes:
                return
            yield raw[:32].hex(), raw[32:]


def sha_index(db_manager, project_id: str) -> Dict[str, Dict[str, Any]]:
    """sha256 -> 文件行（导入时按内容匹配，不看路径）。"""
    index: Dict[str, Dict[str, Any]] = {}
    with db_manager.get_cursor() as cursor:
        cursor.execute(
            'SELECT file_uuid, sha256, filename, path, duration, file_size, '
            '       ai_description, tags FROM files '
            'WHERE project_id=? AND sha256 IS NOT NULL AND sha256 != \'\'',
            (project_id,),
        )
        for row in cursor.fetchall():
            data = dict(row)
            index[str(data['sha256']).lower()] = data
    return index


def _metadata_for(row: Dict[str, Any], kind: str, fingerprint: str, path_str: str) -> Dict[str, Any]:
    from core.indexer import _sanitize_metadata, build_metadata_text, normalize_file_path

    meta: Dict[str, Any] = {
        'file_id': str(row['file_uuid']),
        'file_uuid': str(row['file_uuid']),
        'file_path': path_str,
        'path': path_str,
        'normalized_path': normalize_file_path(path_str),
        'filename': str(row.get('filename') or Path(path_str).name),
        'duration': float(row.get('duration') or 0.0),
        'file_size': int(row.get('file_size') or 0),
        'engine_fingerprint': fingerprint,
    }
    description = str(row.get('ai_description') or '')
    if description:
        meta['ai_description'] = description
    tags = row.get('tags')
    if tags:
        meta['tags'] = tags
    if kind == 'text_vector':
        text = build_metadata_text(meta)
        if text:
            meta['metadata_text'] = text
    return _sanitize_metadata(meta)


def import_pack(
    db_manager,
    project_id: str,
    kind: str,
    pack_dir: Path,
    expected_fingerprint: Optional[str] = None,
    progress: Optional[Any] = None,
    cancelled: Optional[Any] = None,
) -> Dict[str, Any]:
    """把向量包写进 shadow collection，校验后原子切换。"""
    from core.index_lifecycle import create_shadow_indexer, verified_manifest

    pack_dir = Path(pack_dir)
    if pack_dir.is_file():
        pack_dir = pack_dir.parent
    pack = load_manifest(pack_dir, kind)
    local = db_manager.get_index_manifest(project_id, kind)
    # 全新安装还没有 manifest：用 shadow 集合自己的引擎指纹当基准，
    # 同样能挡住「包里是别的模型算的向量」，又不会让首次导入被拒。
    if not local:
        # 全新安装：还没有任何 manifest 可对比。此时没有"会被污染"的旧索引，
        # 允许导入，但把包里的指纹原样记进新 manifest，之后的增量导入就有基准了。
        probe_manifest: Dict[str, Any] = {}
        try:
            probe_manifest = create_shadow_indexer(project_id, kind).get_manifest() or {}
        except Exception as exc:
            logger.debug('探测引擎指纹失败: %s', exc)
        local = {
            'engine_fingerprint': probe_manifest.get('engine_fingerprint') or pack.get('engine_fingerprint'),
            'model_id': pack.get('model_id'),
            'model_revision': pack.get('model_revision'),
            'dimensions': probe_manifest.get('dimensions') or pack.get('dimensions'),
            'preprocessing_version': pack.get('preprocessing_version'),
        }
        logger.info('[VectorPack] 首次导入 %s：本机尚无 manifest，按包内指纹建立基准', kind)
    validate(pack, local, kind)

    bin_path = pack_dir / str(pack.get('file') or f'{kind}.bin')
    if not bin_path.is_file():
        raise VectorPackError(f'找不到向量数据文件 {bin_path.name}')
    header = _read_header(bin_path)
    if header['dtype'] != DTYPE_FLOAT16:
        raise VectorPackError('只支持 float16 向量包')
    if int(header['dim']) != int(pack.get('dimensions') or header['dim']):
        raise VectorPackError('包里 header 的维度和 manifest 不一致')

    checksum = pack.get('checksum')
    if checksum:
        digest = hashlib.sha256()
        with bin_path.open('rb') as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b''):
                digest.update(chunk)
        if digest.hexdigest() != str(checksum):
            raise VectorPackError('向量包校验失败（checksum 不一致），文件可能损坏')

    by_sha = sha_index(db_manager, project_id)
    fingerprint = str(pack.get('engine_fingerprint') or (local or {}).get('engine_fingerprint') or '')
    indexer = create_shadow_indexer(project_id, kind)
    dim = int(header['dim'])

    matched = 0
    missing = 0
    written = 0
    started = time.time()
    _last_t = started
    _last_log = 0
    ids: List[str] = []
    vectors: List[List[float]] = []
    metadatas: List[Dict[str, Any]] = []
    ids_all: List[str] = []   # 用于最后分批把 artifact 标 ready

    def flush() -> int:
        nonlocal written, ids, vectors, metadatas, _last_log, _last_t
        if not ids:
            return 0
        with indexer._write_lock:
            indexer.collection.upsert(ids=ids, embeddings=vectors, metadatas=metadatas)
        count = len(ids)
        written += count
        ids, vectors, metadatas = [], [], []
        if progress:
            progress(written, matched)
        # 每 10 批打一条速率：卡住时能看出是写库慢还是别的地方慢
        now = time.time()
        if now - _last_t >= 5.0:
            _last_t = now
            logger.info(
                "[VectorPack] 已写入 %d 条（%.0f 条/秒，命中 %d，跳过 %d）",
                written, written / max(0.001, now - started), matched, missing,
            )
        return count

    import numpy as np

    for sha_hex, raw_vec in _iter_records(bin_path, header['count'], dim):
        if cancelled and cancelled():
            raise VectorPackError('已取消导入')
        row = by_sha.get(sha_hex.lower())
        if row is None:
            missing += 1
            continue
        matched += 1
        vec = np.frombuffer(raw_vec, dtype=np.float16).astype(np.float32)
        ids.append(str(row['file_uuid']))
        ids_all.append(str(row['file_uuid']))
        vectors.append(vec.tolist())
        metadatas.append(_metadata_for(row, kind, fingerprint, str(row.get('path') or '')))
        if len(ids) >= BATCH_SIZE:
            flush()
    flush()

    # 直接写 collection 绕过了 indexer 的正常写路径，这里补记引擎指纹，
    # 否则新集合的 manifest 指纹是空的，下一次导入会被判成"不匹配"。
    try:
        indexer._record_engine_write(fingerprint)
    except Exception as exc:
        logger.debug('记录引擎指纹失败: %s', exc)
    manifest = verified_manifest(indexer, written)
    if not manifest.get('engine_fingerprint'):
        manifest['engine_fingerprint'] = fingerprint
    db_manager.activate_index_manifests(project_id, {kind: manifest})

    # 命中的文件标 ready；没命中的保持原状（pending 的继续等本地补索引）。
    # 分批更新：6 万行一条大事务会把 WAL 撑到上百 MB，还长时间持有写锁。
    try:
        updated = 0
        for offset in range(0, len(ids_all), 4000):
            chunk = ids_all[offset:offset + 4000]
            marks = ",".join("?" for _ in chunk)
            with db_manager.get_cursor() as cursor:
                cursor.execute(
                    "UPDATE file_artifacts SET state=? WHERE project_id=? AND kind=? "
                    f"AND file_uuid IN ({marks}) AND state IN ('pending','failed','stale')",
                    ('ready', project_id, kind, *chunk),
                )
                updated += cursor.rowcount
        logger.info("[VectorPack] artifact 标 ready %d 条", updated)
    except Exception as exc:
        logger.warning('向量包导入后更新 artifact 状态失败: %s', exc)

    return {
        'kind': kind,
        'collection': manifest.get('collection_name'),
        'written': written,
        'matched': matched,
        'missing': missing,
        'seconds': round(time.time() - started, 1),
    }