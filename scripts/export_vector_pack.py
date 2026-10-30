# -*- coding: utf-8 -*-
"""导出「预计算向量包」：把某个 collection 的向量按 sha256 落成二进制包。

用法（在仓库根目录、应用关闭或空闲时跑）：
  .venv\Scripts\python.exe scripts/export_vector_pack.py --kind text_vector --out D:/packs
  .venv\Scripts\python.exe scripts/export_vector_pack.py --kind audio_vector --out D:/packs
"""
import argparse
import hashlib
import json
import os
import struct
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'backend'))

MAGIC = b'ECHOVEC1'
DTYPE_FP16 = 1


def load_manifest(db, project_id, kind):
    with db.get_cursor() as cursor:
        row = cursor.execute(
            'SELECT collection_name, engine_fingerprint, model_id, model_revision, '
            '       dimensions, preprocessing_version, state '
            'FROM index_manifests WHERE project_id=? AND kind=? AND state=? '
            'ORDER BY rowid DESC LIMIT 1',
            (project_id, kind, 'ready'),
        ).fetchone()
    return dict(row) if row else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--kind', required=True, choices=['audio_vector', 'text_vector'])
    parser.add_argument('--out', required=True)
    parser.add_argument('--project', default='default')
    parser.add_argument('--batch', type=int, default=2000)
    args = parser.parse_args()

    from core.database import get_db_manager
    from core.indexer import get_chroma_client, safe_project_chroma_path

    import numpy as np

    db = get_db_manager()
    manifest = load_manifest(db, args.project, args.kind)
    if not manifest:
        raise SystemExit('找不到 ready 的 manifest')
    collection_name = manifest['collection_name']
    dim = int(manifest['dimensions'] or 512)
    print('collection :', collection_name)
    print('dimension  :', dim)

    print('读取 sha256 映射…', flush=True)
    t0 = time.time()
    sha_by_uuid = {}
    with db.get_cursor() as cursor:
        for row in cursor.execute(
            'SELECT file_uuid, sha256 FROM files WHERE project_id=?', (args.project,)
        ):
            sha = row['sha256'] if isinstance(row, dict) else row[1]
            uuid = row['file_uuid'] if isinstance(row, dict) else row[0]
            if sha:
                sha_by_uuid[str(uuid)] = bytes.fromhex(sha)
    print('  %d 条，%.1fs' % (len(sha_by_uuid), time.time() - t0), flush=True)

    client = get_chroma_client(str(safe_project_chroma_path(args.project, create=False)))
    collection = client.get_collection(collection_name)
    total = collection.count()
    print('collection 条数:', total, flush=True)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    bin_path = out_dir / ('%s.bin' % args.kind)

    written = 0
    skipped = 0
    digest = hashlib.sha256()
    t0 = time.time()
    with bin_path.open('wb') as fh:
        header = MAGIC + struct.pack('<IIIB', 1, 0, dim, DTYPE_FP16)
        fh.write(header)
        digest.update(header)
        offset = 0
        while offset < total:
            got = collection.get(limit=args.batch, offset=offset, include=['embeddings'])
            ids = got.get('ids') or []
            embeddings = got.get('embeddings')
            if embeddings is None:
                break
            for i, file_id in enumerate(ids):
                sha = sha_by_uuid.get(str(file_id))
                if sha is None:
                    skipped += 1
                    continue
                vec = np.asarray(embeddings[i], dtype=np.float16)
                record = sha + vec.tobytes()
                fh.write(record)
                digest.update(record)
                written += 1
            offset += len(ids)
            if not ids:
                break
            print('  %d/%d' % (offset, total), flush=True)
    # 回填 header 里的 count（布局：magic 8B + version 4B + count 4B + dim 4B + dtype 1B）
    with bin_path.open('r+b') as fh:
        fh.seek(12)
        fh.write(struct.pack('<I', written))

    checksum = hashlib.sha256()
    with bin_path.open('rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            checksum.update(chunk)

    pack = {
        'pack_version': 1,
        'pack_id': '%s-%s' % (args.project, args.kind),
        'created_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'kind': args.kind,
        'engine_fingerprint': manifest['engine_fingerprint'],
        'model_id': manifest['model_id'],
        'model_revision': manifest['model_revision'],
        'dimensions': dim,
        'dtype': 'float16',
        'metric': 'cosine',
        'preprocessing_version': manifest['preprocessing_version'],
        'key': 'sha256',
        'count': written,
        'skipped_no_sha': skipped,
        'source_collection': collection_name,
        'file': bin_path.name,
        'file_bytes': bin_path.stat().st_size,
        'checksum': checksum.hexdigest(),
    }
    (out_dir / ('manifest-%s.json' % args.kind)).write_text(
        json.dumps(pack, ensure_ascii=False, indent=2), encoding='utf-8'
    )
    print('完成：%d 条，跳过 %d 条（无 sha256），%.1f MB，%.1fs' % (
        written, skipped, bin_path.stat().st_size / 1024 / 1024, time.time() - t0))


if __name__ == '__main__':
    main()