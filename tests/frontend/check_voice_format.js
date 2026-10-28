#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');
const tts = fs.readFileSync(path.join(root, 'backend', 'core', 'tts.py'), 'utf8');
assert(html.includes('voiceFormatSelect'), '缺输出格式选择');
assert(mainPy.includes('channels: int = 1'), 'voice/speak 不接受声道');
assert(tts.includes('AudioResampler'), 'TTS 层没做重采样');
console.log('语音输出格式契约检查通过。');
