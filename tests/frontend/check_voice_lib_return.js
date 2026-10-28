#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert(html.includes('fromVoiceClone: true'), '打开音色库时没标记来源');
assert(html.includes('voice-profiles-changed'), '关闭后没通知克隆面板刷新');
assert(!/voiceLibOpenBtn'\)\?\.addEventListener\('click', \(\) => \{\s*overlay\.remove\(\);/.test(html), '仍在打开音色库时关闭克隆面板');
console.log('音色库返回路径契约检查通过。');
