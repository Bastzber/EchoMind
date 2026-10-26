#!/usr/bin/env node
// 转码替换源文件契约：勾选项、参数透传、后端替换与库记录同步

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');

assert(html.includes('id="tcKeepSource"'), '缺「替换源文件」勾选项');
assert(html.includes('replace_source: replaceSource'), '没有把替换开关传给后端');
assert(html.includes('转码后替换源文件'), '勾选项文案缺失');
assert(html.includes('await loadFilesFromDatabase({ reset: true })'), '转码后没有刷新列表');

assert(mainPy.includes('replace_source: bool = False'), '后端请求体缺 replace_source');
assert(mainPy.includes('def _transcode_one(') && mainPy.includes('replace_source: bool = False,'), '单文件转码没有替换参数');
assert(mainPy.includes('payload["replaced"] = True'), '没有标记替换成功');
assert(mainPy.includes('UPDATE files SET path=?, canonical_path=?, filename=?'), '没有同步数据库路径');

console.log('转码替换源文件契约检查通过。');
