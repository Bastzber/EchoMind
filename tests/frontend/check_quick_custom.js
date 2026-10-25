#!/usr/bin/env node
// 常用条可自定义 + 索引状态两行 + 顶栏按钮同高。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// 1) 索引状态是上下两行结构
assert(html.includes('id="indexStatusDisplay" class="grid grid-cols-[auto_auto_auto_auto]'), '索引状态不是两行四列网格');
assert((html.match(/id="audioIndexStatus"/g) || []).length === 1, '音频状态应只有一个');
assert((html.match(/id="textIndexStatus"/g) || []).length === 1, '文本状态应只有一个');

// 2) 索引状态在顶栏内
const headerEnd = html.indexOf('</header>');
const statusPos = html.indexOf('id="indexStatusDisplay"');
assert(statusPos > 0 && statusPos < headerEnd, '索引状态应在顶栏里');

// 3) 常用条用动态容器 + ＋/－
assert(html.includes('id="quickActions"'), '缺动态常用容器');
assert(html.includes('id="quickAddBtn"'), '缺 ＋ 按钮');
assert(html.includes('id="quickDelBtn"'), '缺 － 按钮');
assert(html.includes('initQuickActions'), '缺自定义逻辑');
assert(html.includes("localStorage.setItem(STORAGE_KEY"), '常用项没有持久化');
assert(html.includes('REGISTRY'), '缺功能注册表');

// 4) 顶栏按钮统一高度
for (const id of ['fileMenuBtn', 'importBtn', 'descPackMenuBtn', 'sfxMenuBtn', 'recipeMenuBtn', 'settingsBtn']) {
  const idx = html.indexOf('id="' + id + '"');
  assert(idx > 0, '缺按钮 ' + id);
  const seg = html.slice(idx, idx + 120);
  assert(seg.includes('h-10'), id + ' 高度没统一');
}

console.log('常用条自定义契约检查通过。');
