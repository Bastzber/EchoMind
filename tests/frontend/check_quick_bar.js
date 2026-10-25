#!/usr/bin/env node
// 常用工具条契约：常驻、可自定义、索引状态中文且在顶栏两行。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert(html.includes('id="quickBar"'), '缺常驻常用条');
assert(!html.includes('quickBarCollapsed'), '常用条不应可折叠');
assert(html.includes('id="quickActions"'), '缺动态同用容器');
assert(html.includes('id="quickAddBtn"') && html.includes('id="quickDelBtn"'), '缺 ＋/－ 按钮');
assert(html.includes('initQuickActions'), '缺自定义逻辑');

// 注册表里要有核心功能
for (const key of ['重复检测', '标签管理', '批量重命名', '转码', '修复路径', '修复索引', '重建索引']) {
  assert(html.includes("label: '" + key + "'"), '注册表缺功能: ' + key);
}

// 索引状态用中文
assert(!html.includes('>R0 P0 F0<'), '索引状态还在用字母占位');
assert(html.includes('已索引 ${summary.ready} · 待处理 ${summary.pending}'), '格式化函数不是中文');

// 索引状态在顶栏（两行）
const headerEnd = html.indexOf('</header>');
const statusPos = html.indexOf('id="indexStatusDisplay"');
assert(statusPos > 0 && statusPos < headerEnd, '索引状态应在顶栏里');
assert(html.includes('id="indexStatusDisplay" class="flex flex-col'), '索引状态不是两行');

// 顶栏保留创造/配方/描述包
for (const id of ['sfxMenuBtn', 'recipeMenuBtn', 'descPackMenuBtn']) {
  assert(html.indexOf('id="' + id + '"') < headerEnd, id + ' 应该留在顶栏');
}

console.log('常用工具条契约检查通过。');
