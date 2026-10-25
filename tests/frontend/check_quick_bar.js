#!/usr/bin/env node
// 常用工具条契约：常驻可见、按钮齐全、索引状态用中文、状态区在常用条里。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert(html.includes('id="quickBar"'), '缺常驻常用条');
assert(!html.includes('quickBarCollapsed'), '常用条不应该是可折叠的');
for (const id of ['quickDupBtn', 'quickTagsBtn', 'quickRenameBtn', 'quickTranscodeBtn', 'quickRepairBtn']) {
  assert(html.includes('id="' + id + '"'), '缺常用按钮 ' + id);
}
assert(html.includes('function initQuickBar'), '常用条没有绑定逻辑');

// 索引状态用中文，不再出现 R/P/F 占位
assert(!html.includes('>R0 P0 F0<'), '索引状态还在用字母占位');
assert(html.includes('已索引 0 · 待处理 0'), '索引状态占位不是中文');
assert(html.includes('已索引 ${summary.ready} · 待处理 ${summary.pending}'), '格式化函数不是中文');

// 索引状态从顶栏移到常用条（在 quickBar 之后、header 之后）
const headerEnd = html.indexOf('</header>');
const quickPos = html.indexOf('id="quickBar"');
const statusPos = html.indexOf('id="indexStatusDisplay"');
assert(quickPos > headerEnd, '常用条应在顶栏之后');
assert(statusPos > quickPos, '索引状态应在常用条里');

// 创造音效 / 拟音工坊 / 导入描述包 仍在顶栏
for (const id of ['sfxMenuBtn', 'recipeMenuBtn', 'descPackMenuBtn']) {
  assert(html.indexOf('id="' + id + '"') < headerEnd, id + ' 应该留在顶栏');
}

console.log('常用工具条契约检查通过。');
