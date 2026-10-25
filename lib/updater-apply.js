'use strict';

/**
 * 增量更新的落地实现（纯 Node，不依赖 Electron）：
 * 读 zip 里的 manifest → 和本地文件比对 → 备份 → 替换 → 校验 → 清理旧文件。
 * 失败会把已替换的文件从备份还原。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yauzl = require('yauzl');
const { parseManifest, planUpdate } = require('./updater');

/**
 * Electron 会把 *.asar 当档案拦截：直接读写 app.asar 会报 "Invalid package"。
 * 更新时必须把它当普通文件，所以临时关掉 asar 支持。
 */
function withoutAsar(fn) {
  const previous = process.noAsar;
  process.noAsar = true;
  try {
    return fn();
  } finally {
    process.noAsar = previous;
  }
}

async function withoutAsarAsync(fn) {
  const previous = process.noAsar;
  process.noAsar = true;
  try {
    return await fn();
  } finally {
    process.noAsar = previous;
  }
}

function sha256File(filePath) {
  return withoutAsar(() => new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  }));
}

function readManifest(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zipfile) => {
      if (error) return reject(error);
      let found = false;
      zipfile.on('entry', (entry) => {
        if (found) { zipfile.readEntry(); return; }
        if (entry.fileName !== 'manifest.json') { zipfile.readEntry(); return; }
        found = true;
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            zipfile.close();
            try {
              resolve(parseManifest(Buffer.concat(chunks).toString('utf8')));
            } catch (parseError) {
              reject(parseError);
            }
          });
          stream.on('error', reject);
        });
      });
      zipfile.on('end', () => { if (!found) reject(new Error('更新包里没有 manifest.json')); });
      zipfile.on('error', reject);
      zipfile.readEntry();
    });
  });
}

async function collectHashes(installRoot, relativePaths) {
  const result = {};
  for (const relative of relativePaths) {
    const target = path.join(installRoot, relative);
    try {
      const stat = await fs.promises.stat(target);
      if (!stat.isFile()) continue;
      result[relative.toLowerCase()] = await sha256File(target);
    } catch (_) {
      // 不存在 → 需要替换
    }
  }
  return result;
}

async function inspect(zipPath, installRoot) {
  return withoutAsarAsync(async () => {
  const manifest = await readManifest(zipPath);
  // 删除清单里的文件也要纳入本地哈希表，否则永远判不出"需要删除"
  const paths = manifest.files.map((item) => item.path).concat(manifest.remove || []);
  const local = await collectHashes(installRoot, paths);
  const plan = planUpdate(manifest, local);
  return { manifest, plan, installRoot };
  });
}

async function apply(zipPath, installRoot, backupRoot) {
  return withoutAsarAsync(async () => {
  const { manifest, plan } = await inspect(zipPath, installRoot);
  if (plan.upToDate) return { ok: true, upToDate: true, replaced: 0, removed: 0 };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(backupRoot, stamp);
  await fs.promises.mkdir(backupDir, { recursive: true });

  const wanted = new Map(plan.replace.map((item) => [item.path, item]));
  const replaced = [];

  await new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zipfile) => {
      if (error) return reject(error);
      zipfile.on('error', reject);
      zipfile.on('end', resolve);
      zipfile.on('entry', (entry) => {
        const wantedItem = wanted.get(entry.fileName);
        if (!wantedItem) { zipfile.readEntry(); return; }
        const target = path.join(installRoot, entry.fileName);
        const backupTarget = path.join(backupDir, entry.fileName);
        zipfile.openReadStream(entry, async (streamError, stream) => {
          if (streamError) return reject(streamError);
          try {
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            if (fs.existsSync(target)) {
              await fs.promises.mkdir(path.dirname(backupTarget), { recursive: true });
              await fs.promises.copyFile(target, backupTarget);
            }
            const temp = target + '.updating';
            await new Promise((done, fail) => {
              const out = fs.createWriteStream(temp);
              stream.pipe(out);
              out.on('finish', done);
              out.on('error', fail);
              stream.on('error', fail);
            });
            const digest = await sha256File(temp);
            if (digest !== wantedItem.sha256) {
              await fs.promises.unlink(temp).catch(() => {});
              throw new Error('文件校验失败: ' + entry.fileName);
            }
            await fs.promises.rename(temp, target);
            replaced.push(entry.fileName);
            zipfile.readEntry();
          } catch (writeError) {
            reject(writeError);
          }
        });
      });
      zipfile.readEntry();
    });
  });

  const removed = [];
  for (const relative of plan.remove) {
    const target = path.join(installRoot, relative);
    try {
      const backupTarget = path.join(backupDir, relative);
      await fs.promises.mkdir(path.dirname(backupTarget), { recursive: true });
      await fs.promises.copyFile(target, backupTarget);
      await fs.promises.unlink(target);
      removed.push(relative);
    } catch (_) { }
  }

  await fs.promises.writeFile(
    path.join(backupDir, 'update-state.json'),
    JSON.stringify({
      version: manifest.version,
      from: manifest.baseVersion,
      replaced,
      removed,
      appliedAt: new Date().toISOString()
    }, null, 2),
    'utf8'
  );

  return { ok: true, replaced: replaced.length, removed: removed.length, backupDir };
  });
}

async function rollback(backupDir, installRoot) {
  const walk = async (dir, prefix) => {
    for (const name of await fs.promises.readdir(dir)) {
      const full = path.join(dir, name);
      const rel = prefix ? prefix + '/' + name : name;
      const stat = await fs.promises.stat(full);
      if (stat.isDirectory()) { await walk(full, rel); continue; }
      if (name === 'update-state.json') continue;
      const target = path.join(installRoot, rel);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.copyFile(full, target);
    }
  };
  await walk(backupDir, '');
}

module.exports = { inspect, apply, rollback, readManifest, sha256File, collectHashes };
