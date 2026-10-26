#!/usr/bin/env node
// 标签分离契约：6 维标签与「我的标签」互不写入。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const dbPy = fs.readFileSync(path.join(root, 'backend', 'core', 'database.py'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// 删除/改名只动分层表，不再回写 files.tags
const deleteFn = dbPy.slice(dbPy.indexOf('def delete_tag_by_name'), dbPy.indexOf('def list_tag_usage'));
assert(!deleteFn.includes('sync_tags_from_layers'), '删除标签不应回写 files.tags');
assert(deleteFn.includes('DELETE FROM file_tags'), '应删除 file_tags 关联');

const renameFn = dbPy.slice(dbPy.indexOf('def rename_tag_by_name'), dbPy.indexOf('def delete_tag_by_name'));
assert(!renameFn.includes('sync_tags_from_layers'), '改名标签不应回写 files.tags');

// 写 files.tags 的入口不再同步到分层表
assert(!mainPy.includes('sync_layers_from_files_tags(current_project_id, path=file_path)'),
  '旧标签入口不应再同步到分层表');

// 侧栏标签筛选走后端（files.tags 里已不含用户标签）
assert(html.includes("tag: tagName"), '侧栏标签筛选应走后端 tag 参数');
assert(!html.includes("soundData.filter(s => (s.tags || []).includes(tagName))"), '还在本地按 files.tags 过滤用户标签');

console.log('标签分离契约检查通过。');
