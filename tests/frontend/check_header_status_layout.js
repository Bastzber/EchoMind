#!/usr/bin/env node
// 顶栏布局契约：不能裁剪下拉菜单；索引状态两行四列对齐。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// 1) header 不能有 overflow（会裁掉 dropdown）
const headerLine = html.split('\n').find((line) => line.includes('<header class='));
assert(headerLine, '找不到 header');
assert(!headerLine.includes('overflow-x-auto'), 'header 的 overflow-x-auto 会裁掉下拉菜单');
assert(headerLine.includes('flex-nowrap'), 'header 应保持单行');

// 2) 索引状态两行四列，失败列始终存在
for (const id of ['audioIndexStatus', 'audioPendingStatus', 'audioFailedStatus', 'textIndexStatus', 'textPendingStatus', 'textFailedStatus']) {
  assert(html.includes('id="' + id + '"'), '缺状态字段 ' + id);
}
assert(html.includes('grid-cols-[auto_auto_auto_auto]'), '状态块不是四列网格');
assert(html.includes('tabular-nums'), '数字没有等宽对齐');

// 3) 不再用 R/P/F 缩写
assert(!html.includes('>R0 P0 F0<'), '还有 R/P/F 占位');

console.log('顶栏与索引状态排版契约检查通过。');
