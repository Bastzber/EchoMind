#!/usr/bin/env node
// 「检查更新」的纯逻辑：版本比较 + update.json 解析。
// 单独成文件，跟 check_batch_rename.js 一样可以脱离 Electron 跑。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const { compareVersions, isNewer, normalizeFeed } = require(path.join(root, 'lib', 'update-feed.js'));

// ---- 版本比较 ----
assert.strictEqual(compareVersions('0.3.0-beta.9', '0.3.0-beta.10'), -1, 'beta.9 应该比 beta.10 旧');
assert.strictEqual(compareVersions('0.3.0-beta.10', '0.3.0-beta.9'), 1, '方向反了');
assert.strictEqual(compareVersions('0.3.0-beta.9', '0.3.0-beta.9'), 0, '同版本应该相等');
assert.strictEqual(compareVersions('0.3.0', '0.3.0-beta.9'), 1, '正式版应该比 beta 新');
assert.strictEqual(compareVersions('0.3.1', '0.3.0'), 1);
assert.strictEqual(compareVersions('1.0.0', '0.9.9'), 1);
assert.strictEqual(compareVersions('v0.3.0-beta.9', '0.3.0-beta.9'), 0, '带 v 前缀也要能比');

assert.strictEqual(isNewer('0.3.0-beta.10', '0.3.0-beta.9'), true);
assert.strictEqual(isNewer('0.3.0-beta.9', '0.3.0-beta.9'), false);
assert.strictEqual(isNewer('0.3.0-beta.9', '0.3.0-beta.10'), false);

// ---- feed 解析 ----
const fromString = normalizeFeed({
  version: '0.3.0-beta.10',
  released_at: '2026-10-25',
  notes: '批量重命名支持规则\n详情面板可直接改名',
  url: 'https://pan.baidu.com/s/1Tp9P_0Pc2m-dR-lX9fOcyg?pwd=73ca',
  code: '73ca',
});
assert.strictEqual(fromString.version, '0.3.0-beta.10');
assert.deepStrictEqual(fromString.notes, ['批量重命名支持规则', '详情面板可直接改名'], 'notes 应该按行拆开');
assert.strictEqual(fromString.code, '73ca');
assert.strictEqual(fromString.releasedAt, '2026-10-25');

const fromArray = normalizeFeed({
  version: '0.3.0-beta.10',
  notes: ['第一行', '  ', '第二行'],
  url: 'https://example.com/a.zip',
});
assert.deepStrictEqual(fromArray.notes, ['第一行', '第二行'], '空行要被丢掉');
assert.strictEqual(fromArray.code, '', '没有提取码时应该是空串');

// 兼容「artifacts 数组」的写法（以后接自动更新用得上）
const withArtifacts = normalizeFeed({
  version: '0.3.0-beta.10',
  notes: '说明',
  artifacts: [
    { platform: 'darwin', arch: 'arm64', url: 'https://example.com/mac.zip' },
    { platform: 'win32', arch: 'x64', url: 'https://example.com/win.zip' }
  ]
});
assert.strictEqual(withArtifacts.url, 'https://example.com/win.zip', '应该挑 win32-x64 的资产');

assert.throws(() => normalizeFeed({ notes: '没有版本号' }), /version/i, '缺少 version 应该报错');
assert.throws(() => normalizeFeed({ version: 'abc' }), /version/i, '非法版本号应该报错');
assert.throws(() => normalizeFeed(null), /版本信息格式/i, 'null 应该报错');
assert.throws(
  () => normalizeFeed({ version: '0.3.0', url: 'javascript:alert(1)' }),
  /url/i,
  '非 http(s) 的下载地址应该被拒绝'
);

// ---- 页面接线 ----
const indexHtml = read('index.html');
const preloadJs = read('preload.js');
assert(preloadJs.includes("ipcRenderer.invoke('check-update'"), 'preload 没有暴露 check-update');
assert(indexHtml.includes('id="updateTabBtn"'), '设置里没有「关于与更新」标签');
assert(indexHtml.includes('id="updateCheckBtn"'), '设置面板里没有检查更新按钮');
assert(indexHtml.includes('id="checkUpdateMenuBtn"'), '⚙ 设置下拉菜单里没有「检查更新」');
assert(indexHtml.includes('function showUpdateDialog('), '没有更新提示对话框');
assert(indexHtml.includes("checkUpdateMenuBtn')?.addEventListener"), '下拉菜单的检查更新没有接线');
assert(read('main.js').includes("ipcMain.handle('check-update'"), '主进程没有 check-update 处理器');
assert(read('main.js').includes("ipcMain.handle('open-external'"), '主进程没有 open-external 处理器');
assert(read('package.json').includes('"lib/**/*"'), 'package.json 没把 lib/ 打进包');

// 设置里的标签映射要包含新标签
assert(indexHtml.includes("updateTabBtn: 'updateConfigContent'"), '新标签没有接进标签切换映射');

console.log('检查更新的契约检查通过。');
