#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert(html.includes('String(profile.id) === String(voiceState.profileId)'), '选中判断没有用 profile.id');
assert(!html.includes("profile.speaker_id === voiceState.speakerId ? '使用中'"), '仍在用 speaker_id 判断选中');
console.log('音色选中契约检查通过。');
