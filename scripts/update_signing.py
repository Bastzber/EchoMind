# -*- coding: utf-8 -*-
"""更新包签名工具（Ed25519）。

包内 manifest 与文件 sha256 同源，只能防传输损坏，防不了伪造。
发版时用私钥签名，应用侧用硬编码公钥验签（见 lib/updater.js）。

私钥路径可用 ECHOMIND_UPDATE_SIGNING_KEY 覆盖，默认在项目外的固定位置，
绝不进仓库。
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path

DEFAULT_KEY = r"E:\AI音效管理器\update-signing-private.pem"


def canonical_manifest_body(manifest: dict) -> str:
    """与 lib/updater.js 的 canonicalManifestBody 逐字节一致。"""
    files = sorted(
        (
            {
                "path": str(item.get("path") or ""),
                "sha256": str(item.get("sha256") or ""),
                "size": int(item.get("size") or 0),
            }
            for item in (manifest.get("files") or [])
        ),
        key=lambda item: item["path"],
    )
    payload = {
        "version": str(manifest.get("version") or ""),
        "baseVersion": str(manifest.get("baseVersion") or ""),
        "remove": sorted(manifest.get("remove") or []),
        "files": files,
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def sign_manifest(manifest: dict, key_path: str | None = None) -> str:
    """用 Ed25519 私钥签名 manifest，返回 base64 字符串。私钥缺失时返回空串。"""
    path = Path(key_path or os.environ.get("ECHOMIND_UPDATE_SIGNING_KEY") or DEFAULT_KEY)
    if not path.is_file():
        print("[WARN] 找不到签名私钥，生成的包没有 signature，应用侧会拒装")
        return ""
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    except Exception as exc:
        print("[WARN] 缺少 cryptography，跳过签名: %s" % exc)
        return ""
    key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        print("[WARN] 私钥不是 Ed25519，跳过签名")
        return ""
    body = canonical_manifest_body(manifest).encode("utf-8")
    return base64.b64encode(key.sign(body)).decode("ascii")


def attach_signature(manifest: dict, key_path: str | None = None) -> dict:
    """返回带 signature 字段的 manifest 副本。"""
    signature = sign_manifest(manifest, key_path)
    if not signature:
        return dict(manifest)
    signed = dict(manifest)
    signed["signature"] = signature
    print("已签名（Ed25519）")
    return signed
