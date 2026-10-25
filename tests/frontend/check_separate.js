#!/usr/bin/env node
// AI 分轨契约：常用条入口、后端接口、Demucs 实现。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');

assert(html.includes("id: 'separate'"), '常用条没有 AI 分轨');
assert(html.includes("'/api/v1/audio/separate'"), '没有调分轨接口');
assert(html.includes('_分轨'), '没有说明输出目录');
assert(html.includes('人声/鼓/贝斯/其他') || html.includes('人声、鼓、贝斯、其他'), '没有说明拆哪些轨');
assert(mainPy.includes('@app.post("/api/v1/audio/separate")'), '后端缺分轨接口');

const sep = fs.readFileSync(path.join(root, 'backend', 'core', 'separation.py'), 'utf8');
assert(sep.includes('def separate'), '缺 separate 实现');
assert(sep.includes('apply_model'), '没有跑 Demucs 推理');
assert(sep.includes('htdemucs'), '没有模型名');
assert(sep.includes('def _load_audio'), '缺解码实现');
assert(sep.includes('def _save_wav'), '缺写文件实现');
assert(!sep.includes('AudioFile'), '还在用依赖 ffmpeg 的 AudioFile');
assert(!sep.includes('save_audio'), '还在用依赖 ffmpeg 的 save_audio');

console.log('AI 分轨契约检查通过。');
