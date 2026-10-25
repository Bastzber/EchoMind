#!/usr/bin/env node
// 目录同步契约：左侧有同步按钮、调用健康检查与修复接口、修复后重建树。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');

assert(html.includes("sourceSyncBtn.id = 'syncFoldersBtn'"), '左侧没有同步按钮');
assert(html.includes('async function syncLibraryFolders()'), '缺同步逻辑');
assert(html.includes("'/api/v1/db/library/folder-health'"), '没有调用目录健康检查');
assert(html.includes("'/api/v1/db/library/repair-paths'"), '没有调用路径修复');
assert(html.includes('loadFolderStats(true)'), '修复后没有重建目录树');
assert(html.includes("window.addEventListener('focus'"), '窗口获得焦点时没有静默检查');

assert(mainPy.includes('@app.get("/api/v1/db/library/folder-health")'), '后端缺目录健康检查接口');
const health = fs.readFileSync(path.join(root, 'backend', 'core', 'library_health.py'), 'utf8');
assert(health.includes('def folder_health'), '缺 folder_health 实现');
assert(health.includes('def detect_missing'), '缺缺失目录检测');

// P3：metadata/apply 之后要重建文本索引
assert(mainPy.includes('reason="metadata_apply"'), 'apply 后没有调度文本索引重建');

console.log('目录同步契约检查通过。');
