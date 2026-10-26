#!/usr/bin/env node
// 详情面板双标签契约：系统标签与用户标签分开，各写各的接口。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');
const dbPy = fs.readFileSync(path.join(root, 'backend', 'core', 'database.py'), 'utf8');

assert(html.includes("detailSectionTitle('系统标签')"), '缺系统标签栏');
assert(html.includes("detailSectionTitle('用户标签')"), '缺用户标签栏');
assert(html.includes("'/api/v1/files/' + encodeURIComponent(fileUuid) + '/user-tags'"), '缺用户标签读取');
assert(html.includes("'/api/v1/files/' + encodeURIComponent(fileUuid) + '/tags'"), '缺用户标签保存');
assert(html.includes('setSoundTags(sound, nextTags'), '系统标签仍走 files.tags 保存');

assert(mainPy.includes('@app.get("/api/v1/files/{file_uuid}/user-tags")'), '后端缺用户标签读取');
assert(mainPy.includes('background_tasks.add_task(_deferred_reconcile, project_id, ["text_vector"], "user_tags")'),
  '改用户标签后应重建文本索引');

// FTS 要收录用户标签，否则搜不到
assert(dbPy.includes('_user_tag_text'), 'FTS 未合并用户标签');
assert(dbPy.includes('user_tags_by_file'), '全量灌 FTS 时未合并用户标签');

console.log('详情面板双标签契约检查通过。');
