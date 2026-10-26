#!/usr/bin/env node
// 历史记录契约：搜索历史下拉、播放/使用历史板块、记录钩子

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert(html.includes('id="searchHistoryMenu"'), '缺搜索历史下拉');
assert(html.includes('function rememberSearch('), '缺搜索历史写入');
assert(html.includes('function renderSearchHistoryMenu('), '缺搜索历史渲染');

assert(html.includes('id="historyPanels"'), '缺历史板块容器');
assert(html.includes("data-kind=\"play\""), '缺播放历史板块');
assert(html.includes("data-kind=\"usage\""), '缺使用历史板块');
assert(html.includes('function renderHistoryPanels('), '缺历史渲染');
assert(html.includes('function bindHistoryPanels('), '缺历史绑定');
assert(html.includes('bindHistoryPanels();'), '历史板块未绑定');

assert(html.includes("rememberEvent('play', sound)"), '播放没有记录历史');
assert(html.includes("rememberEvent('usage', sound, '改标签')"), '改标签没有记录');
assert(html.includes("rememberEvent('usage', sound, '改描述')"), '改描述没有记录');
assert(html.includes('rememberSearch(query)'), '搜索没有记录历史');

console.log('历史记录契约检查通过。');
