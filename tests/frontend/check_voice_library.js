#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');
const vc = fs.readFileSync(path.join(root, 'backend', 'core', 'voice_clone.py'), 'utf8');

assert(html.includes('function showVoiceLibraryModal'), '缺音色库面板');
assert(html.includes("id: 'voiceLib'"), '常用条缺音色库入口');
assert(html.includes('voiceLibOpenBtn'), '声音克隆里缺“管理音色库”入口');
assert(html.includes('/api/v1/voice/profiles/'), '没调用档案接口');
assert(mainPy.includes('@app.patch("/api/v1/voice/profiles/{profile_id}")'), '后端缺改名接口');
assert(vc.includes('def update_profile'), '缺 update_profile');
console.log('音色库管理契约检查通过。');
