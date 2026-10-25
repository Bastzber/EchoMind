#!/usr/bin/env node
'use strict';
const assert = require('assert');
const updater = require('../../lib/updater');

const manifest = {
  version: '1.2.0',
  baseVersion: '1.1.0',
  files: [
    { path: 'resources/app.asar', sha256: 'aaa', size: 10 },
    { path: 'EchoMind.exe', sha256: 'bbb', size: 20 },
    { path: 'docs/a.txt', sha256: 'ccc', size: 5 }
  ],
  remove: ['old/legacy.dat']
};

const parsed = updater.parseManifest(manifest);
assert.strictEqual(parsed.files.length, 3);
assert.strictEqual(parsed.totalBytes, 35);

const plan = updater.planUpdate(parsed, {
  'resources/app.asar': 'aaa',
  'echomind.exe': 'old',
  'docs/a.txt': 'ccc',
  'old/legacy.dat': 'xyz'
});
assert.deepStrictEqual(plan.skip, ['resources/app.asar', 'docs/a.txt'], '相同文件应跳过');
assert.deepStrictEqual(plan.replace.map((f) => f.path), ['EchoMind.exe'], '只有变化的文件需要替换');
assert.deepStrictEqual(plan.remove, ['old/legacy.dat'], '清单里的旧文件应删除');
assert.strictEqual(plan.replaceBytes, 20);
assert.strictEqual(plan.upToDate, false);

const same = updater.planUpdate(parsed, {
  'resources/app.asar': 'aaa', 'echomind.exe': 'bbb', 'docs/a.txt': 'ccc'
});
assert.strictEqual(same.upToDate, true, '全部一致时应判定为已是最新');

assert.throws(() => updater.parseManifest({ files: [{ path: 'x' }] }), /缺少字段/);
assert.throws(() => updater.parseManifest({ files: [] }), /没有文件/);
assert.strictEqual(updater.normalizePath('\\resources\\app.asar'), 'resources/app.asar');
assert.strictEqual(updater.formatBytes(1536), '1.5 KB');

console.log('增量更新逻辑契约检查通过。');
