#!/usr/bin/env node
// 批量选择与批量删除契约

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainJs = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');

assert(html.includes('lastCheckedIndex'), '缺 Shift 选择锚点');
assert(html.includes('e.shiftKey && lastCheckedIndex >= 0'), '没有 Shift 范围选择');
assert(html.includes('function refreshSelectionUI'), '缺选中刷新');
assert(html.includes('data-sound-id=') || html.includes('data-sound-id="'), 'checkbox 缺 id 标识');

assert(html.includes('仅从软件中移除（保留文件）'), '缺仅移除记录选项');
assert(html.includes('删除源文件并从库移除（回收站）'), '缺删除源文件选项');
assert(html.includes('async function batchDeleteSounds'), '缺批量删除实现');

assert(mainJs.includes("case 'trash-files'"), 'main.js 缺回收站 IPC');
assert(mainJs.includes('shell.trashItem'), '没有送回收站');
assert(preload.includes('trashFiles'), 'preload 缺 trashFiles');
assert(mainPy.includes('@app.post("/api/v1/db/files/delete")'), '后端缺批量删除接口');

console.log('批量选择与删除契约检查通过。');
