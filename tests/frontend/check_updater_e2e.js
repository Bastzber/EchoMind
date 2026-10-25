#!/usr/bin/env node
'use strict';
// 端到端：旧目录 + 更新包 → 应用后与新目录一致；未变化文件保留；可回滚
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createZip } = require('./zip-helper');
const { inspect, apply, rollback } = require('../../lib/updater-apply');
process.noAsar = true;   // Electron 默认拦截 *.asar

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'em-update-'));
  const oldDir = path.join(base, 'old');
  const backupRoot = path.join(base, 'backup');
  const write = (root, rel, content) => {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Electron 会把 *.asar 当档案拦截，直接写会报 Invalid package；
    // 先写临时名再改名（真实更新器也是这么做的）
    if (target.endsWith('.asar')) {
      const temp = target + '.tmp';
      fs.writeFileSync(temp, content);
      fs.renameSync(temp, target);
      return;
    }
    fs.writeFileSync(target, content);
  };

  write(oldDir, 'resources/app.asar', 'OLD-ASAR');
  write(oldDir, 'EchoMind.exe', 'OLD-EXE');
  write(oldDir, 'locales/zh.pak', 'LOCALES');
  write(oldDir, 'obsolete.txt', 'REMOVE-ME');

  const manifest = {
    version: '1.2.0',
    baseVersion: '1.1.0',
    files: [
      { path: 'resources/app.asar', sha256: sha('NEW-ASAR'), size: 8 },
      { path: 'EchoMind.exe', sha256: sha('NEW-EXE'), size: 7 },
      { path: 'locales/zh.pak', sha256: sha('LOCALES'), size: 7 },
      { path: 'resources/backend/extra.dll', sha256: sha('NEW-DLL'), size: 7 }
    ],
    remove: ['obsolete.txt']
  };
  const zipPath = path.join(base, 'update.zip');
  fs.writeFileSync(zipPath, createZip({
    'manifest.json': JSON.stringify(manifest),
    'resources/app.asar': 'NEW-ASAR',
    'EchoMind.exe': 'NEW-EXE',
    'resources/backend/extra.dll': 'NEW-DLL'
  }));

  const before = await inspect(zipPath, oldDir);
  assert.strictEqual(before.plan.replace.length, 3, '应替换 3 个文件（zh.pak 相同应跳过）');
  assert.deepStrictEqual(before.plan.remove, ['obsolete.txt']);

  const result = await apply(zipPath, oldDir, backupRoot);
  assert.strictEqual(result.ok, true, '应用失败: ' + result.error);
  assert.strictEqual(result.replaced, 3);
  assert.strictEqual(result.removed, 1);
  assert.strictEqual(fs.readFileSync(path.join(oldDir, 'resources/app.asar'), 'utf8'), 'NEW-ASAR');
  assert.strictEqual(fs.existsSync(path.join(oldDir, 'obsolete.txt')), false, '旧文件应删除');
  assert.strictEqual(fs.readFileSync(path.join(oldDir, 'locales/zh.pak'), 'utf8'), 'LOCALES', '相同文件应保留');

  const after = await inspect(zipPath, oldDir);
  assert.strictEqual(after.plan.upToDate, true, '应用后应为最新');

  await rollback(result.backupDir, oldDir);
  assert.strictEqual(fs.readFileSync(path.join(oldDir, 'resources/app.asar'), 'utf8'), 'OLD-ASAR', '回滚应还原');
  assert.strictEqual(fs.existsSync(path.join(oldDir, 'obsolete.txt')), true, '回滚应恢复被删文件');

  fs.rmSync(base, { recursive: true, force: true });
  console.log('增量更新端到端测试通过。');
})().catch((error) => { console.error(error); process.exit(1); });
