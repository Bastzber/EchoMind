#!/usr/bin/env node
// 保留优先（中文名）契约：默认选中中文名、全局动作按优先项选保留、可切换。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert(html.includes('duplicateKeepPreference'), '缺少保留优先变量');
assert(html.includes('nameCjkScore'), '缺少中文名打分');
assert(html.includes('preferredKeepIndex'), '缺少优先项计算');
assert(html.includes('splitGroupByPreference'), '缺少分组拆分');
assert(html.includes('radio.checked = i === preferredKeepIndex(group.files)'), '单选没有默认选中优先项');
assert(html.includes('const allPaths = groups.flatMap(group => splitGroupByPreference(group).dups)'), '全局副本没有按优先项计算');
assert(html.includes("'保留优先：'"), '缺少切换按钮文案');
assert(html.includes('中文名 ✓'), '切换按钮没有状态显示');

const dupBlock = html.slice(html.indexOf('async function showDuplicatesModal'), html.indexOf('// 用户文件夹里手动加入的单个音效'));
assert(!/keep\s*=\s*group\.files\[0\]/.test(dupBlock), '还有地方硬编码保留第一份');
assert(!dupBlock.includes('files.slice(1)'), '还有地方按第一份切副本');

console.log('保留优先契约检查通过。');
