#!/usr/bin/env node
// 描述包入口契约：顶部按钮、导入菜单、设置页三处都要能触发导入/导出。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

for (const id of ['descPackMenuBtn', 'descPackDropdown', 'descPackImportBtn', 'descPackExportBtn', 'importDescPackBtn2']) {
  assert(html.includes('id="' + id + '"'), '缺少元素 ' + id);
}
assert(html.includes('wireDescPackShortcuts'), '缺少快捷入口绑定');
assert(html.includes("document.getElementById('importDescPackBtn')?.click()"), '快捷入口没有复用设置页的导入逻辑');
assert(html.includes('导入描述包（.json）'), '导入菜单没有描述包入口');
assert(html.indexOf('descPackMenuBtn') < html.indexOf('id="sfxMenuBtn"'), '描述包按钮应在创造音效之前');

console.log('描述包入口契约检查通过。');
