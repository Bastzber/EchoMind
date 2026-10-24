#!/usr/bin/env node
// 转码契约：右键菜单入口、弹窗、调后端接口、支持救损坏文件。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');

assert(html.includes('转码为 WAV / MP3'), '右键菜单没有转码入口');
assert(html.includes('function showTranscodeModal'), '没有转码弹窗');
assert(html.includes("'/api/v1/transcode'"), '没有调用转码接口');
assert(html.includes('tcOutDir'), '没有输出目录选项');
assert(html.includes('救回'), '没有提示损坏文件可救回');

assert(mainPy.includes('@app.post("/api/v1/transcode")'), '后端缺转码接口');
assert(mainPy.includes('scan-broken'), '后端缺损坏文件扫描');
assert(mainPy.includes('tolerate_errors=True'), '没有容错解码');

const transcodeModule = fs.readFileSync(path.join(root, 'backend', 'core', 'transcode.py'), 'utf8');
assert(transcodeModule.includes('def transcode_file'), '缺 transcode_file');
assert(transcodeModule.includes('salvaged'), '没有救回标记');

console.log('转码契约检查通过。');
