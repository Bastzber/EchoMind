#!/usr/bin/env node
// 转码/去人声/分轨契约：列表对象用 filePath，不能只读 path

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert(html.includes('item.filePath || item.path || item.file_path'), '转码没有兼容 filePath');
assert(!/const paths = list\.map\(item => item\.path \|\| item\.file_path\)/.test(html), '转码仍只读 path');
const musicFilters = html.match(/\(item\.filePath \|\| item\.path \|\| ''\)/g) || [];
assert(musicFilters.length >= 2, '去人声/分轨没有兼容 filePath（当前 ' + musicFilters.length + ' 处）');
const musicPaths = html.match(/paths: music\.map\(\(item\) => item\.filePath \|\| item\.path\)/g) || [];
assert(musicPaths.length >= 2, '去人声/分轨提交路径没有兼容 filePath');

console.log('音频功能路径契约检查通过。');
