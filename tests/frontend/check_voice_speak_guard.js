#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert(html.includes('!voiceState.profileId && !voiceState.speakerId'), '生成语音仍只看 speakerId');
assert(!/if \(!voiceState\.speakerId\)/.test(html), '仍有只看 speakerId 的判断');
console.log('生成语音前置校验契约检查通过。');
