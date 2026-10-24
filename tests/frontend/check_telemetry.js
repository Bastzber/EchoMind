#!/usr/bin/env node
// 匿名统计的纯逻辑：只允许发计数，不允许带任何可识别信息。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const { buildPings, dayKey, versionKey, platformKey, normalizeState } = require(path.join(root, 'lib', 'telemetry.js'));

assert.strictEqual(dayKey(new Date('2026-10-24T23:30:00Z')), 'day-20261024');
assert.strictEqual(versionKey('0.3.0-beta.10'), 'ver-0.3.0-beta.10');
assert.strictEqual(versionKey('0.3.0 beta/../x'), 'ver-0.3.0beta..x', '非法字符要清掉');
assert.strictEqual(platformKey('win32'), 'plat-win32');

const normal = buildPings({ version: '0.3.0-beta.10', platform: 'win32', date: new Date('2026-10-24T10:00:00Z'), firstRun: false });
assert.strictEqual(normal.length, 4, '普通启动 4 个计数');
assert(normal.every(u => u.startsWith('https://abacus.jasoncameron.dev/hit/echomind/')), '必须走计数服务');
assert(normal.some(u => u.endsWith('/launch')));
assert(normal.some(u => u.endsWith('/day-20261024')));
assert(normal.some(u => u.endsWith('/ver-0.3.0-beta.10')));
assert(normal.some(u => u.endsWith('/plat-win32')));
assert(!normal.some(u => u.includes('/installs')), '非首次启动不记安装');

const first = buildPings({ version: '0.3.0-beta.10', platform: 'win32', firstRun: true });
assert(first.some(u => u.endsWith('/installs')), '首次启动要记一次安装');

// 绝不携带路径/用户名/文件名
const all = [...normal, ...first].join(' ');
assert(!/[A-Z]:\\/i.test(all), 'URL 里不能出现磁盘路径');
assert(!all.includes('Users'), 'URL 里不能出现用户目录');
assert(!all.includes('\\'), 'URL 里不能出现反斜杠');

assert.strictEqual(normalizeState({}).enabled, true, '默认开启');
assert.strictEqual(normalizeState({ enabled: false }).enabled, false);
assert.strictEqual(normalizeState(null).firstRunDone, false);

// 接线
const mainJs = read('main.js');
const preload = read('preload.js');
const indexHtml = read('index.html');
assert(mainJs.includes("require('./lib/telemetry')"), '主进程没用 telemetry 模块');
assert(mainJs.includes('ipcMain.handle(\'telemetry-get\''), '主进程缺 telemetry-get');
assert(mainJs.includes('ipcMain.handle(\'telemetry-set\''), '主进程缺 telemetry-set');
assert(preload.includes("invoke('telemetry-get')"), 'preload 没暴露 telemetry.get');
assert(preload.includes("invoke('telemetry-set'"), 'preload 没暴露 telemetry.set');
assert(indexHtml.includes('id="aboutTelemetryToggle"'), '关于窗口里没有匿名统计开关');
assert(indexHtml.includes('id="aboutTelemetryStatus"'), '关于窗口里没有统计状态文案');
assert(indexHtml.includes("id=\"aboutAppBtn\""), '设置菜单里没有「关于回声」');
assert(!indexHtml.includes('id="telemetryToggle"'), '设置面板里不该再放大段统计说明');

console.log('匿名统计契约检查通过。');
