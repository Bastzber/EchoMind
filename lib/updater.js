'use strict';

/**
 * 增量更新的纯逻辑：解析 manifest、和本地文件清单比对，算出要替换 / 删除哪些文件。
 * 真正的文件读写、解压、重启在 main.js 里做。
 */

const crypto = require('crypto');

const REQUIRED_FIELDS = ['path', 'sha256'];

// 更新包签名公钥（Ed25519）。只信这把写死在应用里的钥匙——
// 包内 manifest 与 sha256 同源，只能防传输损坏，防不了伪造。
const UPDATE_PUBLIC_KEY_PEM = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEAYzgKkZcU0ZspX9V/EZyXn65lLV3A55J0L2w+OiY+Xk4=',
  '-----END PUBLIC KEY-----'
] .join('\n');

/**
 * 校验 update.json / manifest 的签名。
 * 签名对象是「规范化后的 manifest 字符串」，签名值放在包内 signature 字段。
 * 返回 { ok, reason }，不抛异常——调用方决定是阻断还是仅告警。
 */
function verifyManifestSignature(manifest, signatureBase64) {
  const sig = String(signatureBase64 || '').trim();
  if (!sig) return { ok: false, reason: 'missing-signature' };
  const body = canonicalManifestBody(manifest);
  if (!body) return { ok: false, reason: 'bad-manifest' };
  try {
    const key = crypto.createPublicKey(UPDATE_PUBLIC_KEY_PEM);
    const ok = crypto.verify(null, Buffer.from(body, 'utf8'), key, Buffer.from(sig, 'base64'));
    return ok ? { ok: true } : { ok: false, reason: 'bad-signature' };
  } catch (error) {
    return { ok: false, reason: 'verify-error: ' + (error && error.message) };
  }
}

/**
 * 签名用的规范化正文：字段顺序固定、去掉 signature 自身、保留关键字段。
 * 打包端与应用端必须用同一套规则，否则验签永远对不上。
 */
function canonicalManifestBody(manifest) {
  if (!manifest || typeof manifest !== 'object') return '';
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const cleaned = files
    .map((item) => ({
      path: String((item && item.path) || ''),
      sha256: String((item && item.sha256) || ''),
      size: Number((item && item.size) || 0)
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const payload = {
    version: String(manifest.version || ''),
    baseVersion: String(manifest.baseVersion || ''),
    remove: (Array.isArray(manifest.remove) ? manifest.remove.slice() : []).sort(),
    files: cleaned
  };
  return JSON.stringify(payload);
}

// manifest 里的 path 会直接参与 path.join(installRoot, rel)，
// 所以必须在这里把「跳出安装目录」的形状全挡掉：
// 绝对路径、盘符、.. 段、UNC 前缀、以及 NUL 字符。
// 只在后面某一步校验不够 —— 打包脚本、更新器、批处理三处都会拼路径。
function normalizePath(value) {
  const raw = String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\u0000/g, '');
  if (!raw) return '';
  if (/^[a-zA-Z]:/.test(raw)) return '';        // C:/ 这种盘符绝对路径
  if (raw.startsWith('//')) return '';           // //server/share
  const segments = raw.split('/');
  // 只要出现 .. 就整条拒绝，不做「把 .. 吃掉」的归一化：
  // 归一化虽然能保证不越界，但会把恶意构造的路径悄悄改成安装目录里的另一个文件，
  // 让人看不出包被改过。宁可整个包判非法，让用户重新下载。
  if (segments.some((s) => s === '..')) return '';
  const parts = segments.filter((s) => s && s !== '.');
  if (!parts.length) return '';
  return parts.join('/');
}

function parseManifest(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || typeof data !== 'object') throw new Error('manifest 不是对象');
  const files = Array.isArray(data.files) ? data.files : [];
  const clean = [];
  for (const item of files) {
    if (!item || typeof item !== 'object') continue;
    const missing = REQUIRED_FIELDS.filter((key) => !item[key]);
    if (missing.length) throw new Error('manifest 文件项缺少字段: ' + missing.join(','));
    clean.push({
      path: normalizePath(item.path),
      sha256: String(item.sha256).toLowerCase(),
      size: Number(item.size || 0)
    });
  }
  if (!clean.length) throw new Error('manifest 里没有文件');
  return {
    version: String(data.version || ''),
    baseVersion: String(data.baseVersion || ''),
    createdAt: String(data.createdAt || ''),
    files: clean,
    remove: Array.isArray(data.remove) ? data.remove.map(normalizePath).filter(Boolean) : [],
    totalBytes: clean.reduce((sum, item) => sum + item.size, 0),
    // 签名带在原 manifest 上：验签要用原始 files 顺序与字段，所以这里照原样保留。
    signature: String(data.signature || '')
  };
}

/**
 * @param {object} manifest parseManifest 的结果
 * @param {Record<string,string>} localHashes 相对路径(小写, 正斜杠) -> sha256
 */
function planUpdate(manifest, localHashes) {
  const replace = [];
  const skip = [];
  const hashes = localHashes || {};
  for (const file of manifest.files) {
    const key = file.path.toLowerCase();
    const current = hashes[key];
    if (current === file.sha256) {
      skip.push(file.path);
    } else {
      replace.push(file);
    }
  }
  const remove = (manifest.remove || []).filter((path) => {
    const key = path.toLowerCase();
    return Object.prototype.hasOwnProperty.call(hashes, key);
  });
  return {
    replace,
    skip,
    remove,
    replaceBytes: replace.reduce((sum, item) => sum + item.size, 0),
    totalBytes: manifest.totalBytes,
    // 一个文件都不需要换，说明已经是目标版本
    upToDate: replace.length === 0 && remove.length === 0
  };
}

function formatBytes(value) {
  const size = Number(value || 0);
  if (size < 1024) return size + ' B';
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
  if (size < 1024 * 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + ' MB';
  return (size / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

module.exports = {
  parseManifest,
  planUpdate,
  normalizePath,
  formatBytes,
  verifyManifestSignature,
  canonicalManifestBody
};
