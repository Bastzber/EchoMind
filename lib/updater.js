'use strict';

/**
 * 增量更新的纯逻辑：解析 manifest、和本地文件清单比对，算出要替换 / 删除哪些文件。
 * 真正的文件读写、解压、重启在 main.js 里做。
 */

const REQUIRED_FIELDS = ['path', 'sha256'];

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
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
    totalBytes: clean.reduce((sum, item) => sum + item.size, 0)
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

module.exports = { parseManifest, planUpdate, normalizePath, formatBytes };
