#!/usr/bin/env node
// 侧边栏标签交互契约：右键改名/删除、拖拽合并，都要调后端接口。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert(html.includes('function attachTagSidebarInteractions'), '缺侧边栏标签交互函数');
assert(html.includes('function showTagSidebarMenu'), '缺标签右键菜单');
assert(html.includes('function renameSidebarTag'), '缺标签改名');
assert(html.includes('function deleteSidebarTag'), '缺标签删除');
assert(html.includes('function mergeSidebarTag'), '缺标签合并');
assert(html.includes("'/api/v1/tags/rename'"), '改名没调后端');
assert(html.includes("'/api/v1/tags/delete'"), '删除没调后端');
assert(html.includes("'/api/v1/tags/merge'"), '合并没调后端');
assert(html.includes("row.setAttribute('draggable', 'true')"), '标签不可拖拽');
assert(html.includes("row.addEventListener('drop'"), '缺拖放处理');
assert(html.includes('.tag-drop-hover'), '缺拖放高亮样式');
assert((html.match(/attachTagSidebarInteractions\(/g) || []).length >= 4, '交互没有挂到两类标签行上');

console.log('侧边栏标签交互契约检查通过。');
