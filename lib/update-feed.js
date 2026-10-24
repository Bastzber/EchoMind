'use strict';

/**
 * 「检查更新」用到的纯逻辑：版本号比较 + update.json 解析。
 * 主进程 require 它；tests/frontend/check_update_feed.js 也直接测它。
 */

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function parseVersion(raw) {
  const match = VERSION_RE.exec(String(raw === undefined || raw === null ? '' : raw).trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] || ''
  };
}

/** 返回 -1 / 0 / 1；预发布段按数字优先、文本兜底比较（beta.9 < beta.10）。 */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error('版本号格式无效: ' + (!left ? a : b));
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (!left.pre && !right.pre) return 0;
  if (!left.pre) return 1;      // 正式版比任何预发布都新
  if (!right.pre) return -1;
  const leftParts = left.pre.split('.');
  const rightParts = right.pre.split('.');
  const size = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < size; i += 1) {
    const x = leftParts[i];
    const y = rightParts[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      if (Number(x) !== Number(y)) return Number(x) > Number(y) ? 1 : -1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

function isNewer(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

function normalizeNotes(raw) {
  const list = Array.isArray(raw) ? raw : String(raw === undefined || raw === null ? '' : raw).split(/\r?\n/);
  return list.map(line => String(line).trim()).filter(Boolean);
}

/** 校验并规整 update.json；字段不全或格式不对就抛错（调用方当作「没有更新」处理）。 */
function normalizeFeed(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('版本信息格式错误：不是对象');
  const version = String(raw.version || '').trim();
  if (!parseVersion(version)) throw new Error('版本信息格式错误：version 无效');

  let url = String(raw.url || '').trim();
  if (!url && Array.isArray(raw.artifacts)) {
    const win = raw.artifacts.find(item => item && item.platform === 'win32' && item.arch === 'x64');
    url = String((win && win.url) || '').trim();
  }
  if (url && !/^https?:\/\//i.test(url)) throw new Error('版本信息格式错误：url 必须是 http(s)');

  return {
    version: version.replace(/^v/i, ''),
    notes: normalizeNotes(raw.notes),
    url,
    code: String(raw.code || '').trim(),
    releasedAt: String(raw.released_at || raw.releasedAt || '').trim()
  };
}

module.exports = { parseVersion, compareVersions, isNewer, normalizeFeed };
