'use strict';

/**
 * 匿名使用统计（只回答"大概多少人在用"，不收集任何个人信息）。
 *
 * 上报内容只有三类，全部拼进 URL 的计数键里：
 *   - launch      每次启动 +1
 *   - day-YYYYMMDD 当天启动次数（近似日活）
 *   - ver-x.y.z   版本分布
 *   - plat-win32  平台分布
 *   - installs    只在首次启动 +1（≈ 安装人数）
 *
 * 不发送：安装 ID、路径、文件名、标签、描述、任何可定位个人的信息。
 * 计数服务是第三方的免费计数器，挂了就静默跳过，绝不影响使用。
 */

const COUNTER_BASE = 'https://abacus.jasoncameron.com'.replace('abacus.jasoncameron.com', 'abacus.jasoncameron.dev');
const NAMESPACE = 'echomind';

function dayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return 'day-' + year + month + day;
}

function versionKey(version) {
  const safe = String(version || 'unknown').toLowerCase().replace(/[^0-9a-z.\-]/g, '');
  return 'ver-' + (safe || 'unknown');
}

function platformKey(platform) {
  const safe = String(platform || 'unknown').toLowerCase().replace(/[^0-9a-z]/g, '');
  return 'plat-' + (safe || 'unknown');
}

/** 返回本次启动要打的计数 URL 列表。firstRun=true 时多记一次安装。 */
function buildPings(options) {
  const opts = options || {};
  const keys = [dayKey(opts.date || new Date()), versionKey(opts.version), platformKey(opts.platform)];
  if (opts.firstRun) keys.unshift('installs');
  keys.unshift('launch');
  return keys.map(key => COUNTER_BASE + '/hit/' + NAMESPACE + '/' + encodeURIComponent(key));
}

/** 统计状态：默认开启，用户可以在设置里关掉。 */
function normalizeState(raw) {
  const state = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: state.enabled !== false,
    firstRunDone: state.firstRunDone === true,
    createdAt: typeof state.createdAt === 'string' ? state.createdAt : ''
  };
}

/** 只读接口：给设置界面显示"当前是开还是关"。 */
function describeState(state) {
  return normalizeState(state).enabled ? '匿名统计：已开启' : '匿名统计：已关闭';
}

module.exports = { COUNTER_BASE, NAMESPACE, dayKey, versionKey, platformKey, buildPings, normalizeState, describeState };
