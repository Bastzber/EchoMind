# -*- coding: utf-8 -*-
"""导出「知识包」：描述 + 标签 + 两套向量，合成一个 zip。

用法（应用关闭或空闲时）：
  .venv\\Scripts\\python.exe scripts/export_knowledge_pack.py --out E:/packs/EchoMind-知识包.zip
"""
import argparse
import hashlib
import json
import os
import struct
import sys
import tempfile
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'backend'))

MAGIC = b'ECHOVEC1'
DTYPE_FP16 = 1


def load_manifest(db, project_id, kind):
    with db.get_cursor() as cursor:
        row = cursor.execute(
            'SELECT collection_name, engine_fingerprint, model_id, model_revision, '
            '       dimensions, preprocessing_version FROM index_manifests '
            'WHERE project_id=? AND kind=? AND state=? ORDER BY rowid DESC LIMIT 1',
            (project_id, kind, 'ready'),
        ).fetchone()
    return dict(row) if row else None


def export_vectors(db, project_id, kind, manifest, out_path, allowed_shas=None):
    """按 sha256 把向量写成定长二进制（与 export_vector_pack 同格式）。"""
    import numpy as np

    from core.indexer import get_chroma_client, safe_project_chroma_path

    sha_by_uuid = {}
    with db.get_cursor() as cursor:
        for row in cursor.execute(
            'SELECT file_uuid, sha256 FROM files WHERE project_id=? AND sha256 IS NOT NULL',
            (project_id,),
        ):
            data = dict(row)
            sha_by_uuid[str(data['file_uuid'])] = bytes.fromhex(str(data['sha256']))

    client = get_chroma_client(str(safe_project_chroma_path(project_id, create=False)))
    collection = client.get_collection(manifest['collection_name'])
    total = collection.count()
    dim = int(manifest['dimensions'] or 512)
    written = 0
    skipped = 0
    offset = 0
    with open(out_path, 'wb') as fh:
        fh.write(MAGIC + struct.pack('<IIIB', 1, 0, dim, DTYPE_FP16))
        while offset < total:
            got = collection.get(limit=2000, offset=offset, include=['embeddings'])
            ids = got.get('ids') or []
            embeddings = got.get('embeddings')
            if not ids or embeddings is None:
                break
            for i, file_id in enumerate(ids):
                sha = sha_by_uuid.get(str(file_id))
                if sha is None:
                    skipped += 1
                    continue
                if allowed_shas is not None and sha.hex() not in allowed_shas:
                    skipped += 1
                    continue
                vec = np.asarray(embeddings[i], dtype=np.float16)
                fh.write(sha + vec.tobytes())
                written += 1
            offset += len(ids)
    with open(out_path, 'r+b') as fh:
        fh.seek(12)
        fh.write(struct.pack('<I', written))
    return {'count': written, 'skipped': skipped, 'dim': dim, 'source': total}


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    parser.add_argument('--project', default='default')
    parser.add_argument('--limit', type=int, default=0, help='只导前 N 条（调试用）')
    args = parser.parse_args()

    from core.database import get_db_manager

    db = get_db_manager()
    t0 = time.time()
    with db.get_cursor() as cursor:
        rows = cursor.execute(
            'SELECT file_uuid, sha256, path, filename, ai_description, tags, duration '
            'FROM files WHERE project_id=? AND sha256 IS NOT NULL '
            'ORDER BY path', (args.project,)
        ).fetchall()
    rows = [dict(r) for r in rows]
    if not rows:
        raise SystemExit('库里没有带 sha256 的文件')
    # 库根目录用**全量**路径算，否则 --limit 时 commonpath 会退化成某个子目录，
    # rel 里就会带上一截多余前缀。
    paths = [str(r['path']) for r in rows]
    try:
        root = os.path.commonpath(paths)
    except Exception:
        root = os.path.dirname(paths[0])
    if os.path.isfile(root):
        root = os.path.dirname(root)
    if args.limit:
        rows = rows[: args.limit]
    print('文件 %d 条' % len(rows), flush=True)
    print('库根目录:', root, flush=True)

    tmp = Path(tempfile.mkdtemp(prefix='kpack-'))
    meta_path = tmp / 'metadata.jsonl'
    tag_vocab = {}
    with open(meta_path, 'w', encoding='utf-8', newline='\n') as fh:
        for r in rows:
            try:
                tags = json.loads(r['tags'] or '[]')
            except Exception:
                tags = []
            for tag in tags:
                tag_vocab[str(tag)] = tag_vocab.get(str(tag), 0) + 1
            rel = os.path.relpath(str(r['path']), root)
            fh.write(json.dumps({
                'sha256': str(r['sha256']).lower(),
                'rel': rel,
                'filename': r['filename'],
                'description': r['ai_description'] or '',
                'tags': tags,
            }, ensure_ascii=False) + '\n')
    print('metadata.jsonl %.1f MB' % (meta_path.stat().st_size / 1024 / 1024), flush=True)

    allowed_shas = {str(r['sha256']).lower() for r in rows}
    manifest = {
        'pack_version': 1,
        'pack_kind': 'knowledge',
        'created_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'project_source': args.project,
        'library_root': root,
        'files': len(rows),
        'vocabulary': sorted(tag_vocab.items(), key=lambda kv: -kv[1])[:4000],
        'kinds': {},
    }

    for kind in ('audio_vector', 'text_vector'):
        mf = load_manifest(db, args.project, kind)
        if not mf:
            print('跳过 %s（没有 ready 的 manifest）' % kind, flush=True)
            continue
        out_bin = tmp / ('%s.bin' % kind)
        info = export_vectors(db, args.project, kind, mf, out_bin, allowed_shas)
        info.update({
            'file': out_bin.name,
            'checksum': sha256_file(out_bin),
            'file_bytes': out_bin.stat().st_size,
            'engine_fingerprint': mf['engine_fingerprint'],
            'model_id': mf['model_id'],
            'model_revision': mf['model_revision'],
            'preprocessing_version': mf['preprocessing_version'],
            'dtype': 'float16',
            'metric': 'cosine',
        })
        manifest['kinds'][kind] = info
        print('%s: %d 条, %.1f MB' % (kind, info['count'], info['file_bytes'] / 1024 / 1024), flush=True)

    (tmp / 'manifest.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8'
    )
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_STORED) as zf:
        for name in ('manifest.json', 'metadata.jsonl'):
            zf.write(tmp / name, name)
        for kind, info in manifest['kinds'].items():
            zf.write(tmp / info['file'], info['file'])
    print('知识包: %s (%.1f MB) 用时 %.0f 秒' % (out, out.stat().st_size / 1024 / 1024, time.time() - t0))


if __name__ == '__main__':
    main()