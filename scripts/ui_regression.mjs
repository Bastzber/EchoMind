#!/usr/bin/env node
/**
 * EchoMind 界面回归脚本（Electron 45 专项）
 *
 * 用法：
 *   1. 先带调试端口启动程序：
 *      dist-v11-build\win-unpacked\EchoMind.exe --remote-debugging-port=9222
 *   2. node scripts/ui_regression.mjs [--port 9222] [--out docs/ui-regression]
 *
 * 只读验证：不导入、不改库、不删文件。点一次播放是唯一会写库的动作（记一条播放历史）。
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(argOf('port', 9222));
const OUT_DIR = path.resolve(argOf('out', 'docs/ui-regression'));
const BASE = 'http://127.0.0.1:' + PORT;

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + '  ' + detail);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsClient(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const slot = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) slot.rej(new Error(msg.error.message || JSON.stringify(msg.error)));
      else slot.res(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  };
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  return { ws, send, events };
}

async function connectPage() {
  const list = await (await fetch(BASE + '/json/list')).json();
  const page = list.find((t) => t.type === 'page' && !t.url.includes('splash'));
  if (!page) throw new Error('主窗口还没出来（仍停在启动窗）');
  const client = await wsClient(page.webSocketDebuggerUrl);
  client.page = page;
  client.evaluate = async (expression) => {
    const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const detail = r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text;
      throw new Error(String(detail || r.exceptionDetails.text));
    }
    return r.result.value;
  };
  return client;
}
async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const shotDir = path.join(OUT_DIR, stamp);
  fs.mkdirSync(shotDir, { recursive: true });
  const page = await connectPage();
  const shot = async (name) => {
    const r = await page.send('Page.captureScreenshot', { format: 'png' });
    const out = path.join(shotDir, name + '.png');
    fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
    return out;
  };
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Page.enable');

  // R0 启动：主窗口 + 桌面桥接
  const boot = await page.evaluate('(function(){ var api = window.electronAPI || {}; return { title: document.title, ready: document.readyState, apiCount: Object.keys(api).length, hasBackendApi: typeof api.backendAPI === "object", page: location.pathname.split("/").pop() }; })()');
  record('启动 · 主窗口与桌面桥接', boot.apiCount > 20 && boot.hasBackendApi, 'api=' + boot.apiCount + ' page=' + boot.page);

  // R1 后端连通（走渲染层令牌通道，不是裸 8000 端口）
  let health = null;
  try {
    health = await page.evaluate('window.electronAPI.backendAPI.healthCheck()');
  } catch (error) {
    health = { error: error.message };
  }
  record('后端 · 令牌通道健康检查', Boolean(health && health.status === 'healthy'),
    health && health.status ? 'status=' + health.status + ' version=' + health.version : JSON.stringify(health));

  // R2 主列表渲染
  const listInfo = await page.evaluate('(function(){ var box = document.getElementById("soundList"); return { rows: box ? box.children.length : 0, firstId: box && box.firstElementChild ? box.firstElementChild.dataset.id : null }; })()');
  record('主列表 · 渲染行数', listInfo.rows > 0, 'rows=' + listInfo.rows);

  // R3 音频播放（自定义协议 + HTML5 Audio）
  const play = await page.evaluate('(async function(){ var row = document.getElementById("soundList").firstElementChild; if (!row) return { error: "没有可播的行" }; row.dispatchEvent(new MouseEvent("click", { bubbles: true })); await new Promise(function(r){ setTimeout(r, 2500); }); var p = (typeof audioPlayer !== "undefined" ? audioPlayer : null); return { src: p && p.src ? String(p.src).slice(0, 90) : "", paused: p ? p.paused : null, t: p ? p.currentTime : 0, dur: p ? p.duration : 0, err: p && p.error ? p.error.code : null, readyState: p ? p.readyState : null }; })()');
  record('音频 · 点行播放', !play.error && play.paused === false && play.t > 0.1,
    't=' + Number(play.t || 0).toFixed(2) + 's dur=' + Number(play.dur || 0).toFixed(1) + 's src=' + String(play.src || '').replace(/\?.*$/, '').slice(0, 60) + ' err=' + play.err);
  await shot('01-playing');

  // R4 再点一次停住
  // 行上的播放按钮才是「暂停/继续」那个开关；单击整行是「从头放」（原设计如此）
  const paused = await page.evaluate('(async function(){ var row = document.getElementById("soundList").firstElementChild; var btn = row.querySelector(".play-sound-btn"); var p = (typeof audioPlayer !== "undefined" ? audioPlayer : null); var before = p ? p.paused : null; (btn || row).dispatchEvent(new MouseEvent("click", { bubbles: true })); await new Promise(function(r){ setTimeout(r, 800); }); return { before: before, paused: p ? p.paused : null, t: p ? p.currentTime : 0, hadButton: !!btn }; })()');
  record('音频 · 再点一次停住', paused.paused === true, 'paused=' + paused.paused);

  // R5 主波形是否真的画出来
  const wave = await page.evaluate('(function(){ var c = document.getElementById("mainWaveform"); if (!c) return { error: "没有主波形画布" }; var ctx = c.getContext("2d"); var data = ctx.getImageData(0, 0, c.width, c.height).data; var painted = 0; for (var i = 3; i < data.length; i += 4) { if (data[i] > 0) painted++; } return { w: c.width, h: c.height, painted: painted, hidden: c.classList.contains("hidden") }; })()');
  record('波形 · 主画布已绘制', !wave.error && wave.painted > 100,
    wave.error || ('painted=' + wave.painted + '/' + (wave.w * wave.h) + ' hidden=' + wave.hidden));

  // R6 3D 形象（自定义元素 mesh-avatar + WebGL）
  const avatar = await page.evaluate('(function(){ var el = document.getElementById("navAvatar"); if (!el) return { error: "没有 navAvatar" }; var root = el.shadowRoot; var canvas = root ? root.querySelector("canvas") : null; var gl = canvas ? (canvas.getContext("webgl2") || canvas.getContext("webgl")) : null; var box = el.getBoundingClientRect(); return { tag: el.tagName.toLowerCase(), w: Math.round(box.width), h: Math.round(box.height), canvas: canvas ? canvas.width + "x" + canvas.height : null, gl: gl ? (gl.isContextLost ? !gl.isContextLost() : true) : null, shadow: !!root }; })()');
  record('3D 形象 · mesh-avatar 渲染', !avatar.error && avatar.w > 20 && avatar.h > 20,
    avatar.error || ('size=' + avatar.w + 'x' + avatar.h + ' canvas=' + avatar.canvas + ' gl=' + avatar.gl + ' shadow=' + avatar.shadow));

  // R7 拖放高亮（只验证接线，不真的导入）
  const drop = await page.evaluate('(async function(){ var zone = document.getElementById("folderPanelSection"); if (!zone) return { error: "没有左侧面板" }; var dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(8)], "probe.wav", { type: "audio/wav" })); document.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: dt })); await new Promise(function(r){ setTimeout(r, 250); }); var highlighted = zone.style.outline || ""; document.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt })); await new Promise(function(r){ setTimeout(r, 300); }); return { highlighted: highlighted, after: zone.style.outline || "" }; })()');
  record('拖放 · 高亮接线', !drop.error && String(drop.highlighted).includes('solid') && drop.after === '',
    drop.error || ('dragover=' + drop.highlighted + ' drop=' + (drop.after || '已清除')));

  // R8 窗口缩放（真的改窗口，不是改视口）
  const before = await page.evaluate('({ w: innerWidth, h: innerHeight })');
  let resizeMode = 'window';
  let browser = null;
  try {
    browser = await wsClient((await (await fetch(BASE + '/json/version')).json()).webSocketDebuggerUrl);
    const win = await browser.send('Browser.getWindowForTarget', { targetId: page.page.id });
    await browser.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { width: 1300, height: 800, windowState: 'normal' } });
  } catch (_error) {
    // Electron 没实现 Browser.getWindowForTarget，退回视口模拟，也能验证自适应布局
    resizeMode = 'viewport';
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 800, deviceScaleFactor: 1, mobile: false });
  }
  await sleep(900);
  const small = await page.evaluate('(function(){ var aside = document.getElementById("leftAside"); var box = document.getElementById("soundList"); return { w: innerWidth, h: innerHeight, asideW: aside ? Math.round(aside.getBoundingClientRect().width) : 0, listW: box ? Math.round(box.getBoundingClientRect().width) : 0, rows: box ? box.children.length : 0 }; })()');
  await shot('02-small-window');
  if (resizeMode === 'window') {
    await browser.send('Browser.setWindowBounds', { windowId: (await browser.send('Browser.getWindowForTarget', { targetId: page.page.id })).windowId, bounds: { width: before.w + 9, height: before.h + 39, windowState: 'normal' } });
  } else {
    await page.send('Emulation.clearDeviceMetricsOverride');
  }
  await sleep(900);
  const restored = await page.evaluate('({ w: innerWidth, h: innerHeight })');
  record('窗口 · 缩小/还原', small.w < before.w && small.asideW > 100 && small.listW > 200 && small.rows > 0 && restored.w > small.w,
    '(' + resizeMode + ') ' + before.w + 'x' + before.h + ' -> ' + small.w + 'x' + small.h + ' -> ' + restored.w + 'x' + restored.h + ' asideW=' + small.asideW);
  if (browser) browser.ws.close();

  // R9 控制台异常扫描
  const problems = page.events.filter((e) => {
    if (e.method === 'Runtime.exceptionThrown') return true;
    if (e.method === 'Log.entryAdded') {
      const entry = e.params && e.params.entry ? e.params.entry : {};
      if (!['error', 'warning'].includes(entry.level)) return false;
      // Canvas2D 那条是回归脚本自己 getImageData 造成的噪声，不算应用问题
      return !/DevTools|Autofill|deprecated|willReadFrequently/i.test(String(entry.text || ''));
    }
    return false;
  }).map((e) => {
    if (e.method === 'Runtime.exceptionThrown') {
      const d = e.params.exceptionDetails || {};
      const text = d.exception && d.exception.description ? d.exception.description : d.text;
      return 'exception: ' + String(text || '').split('\n')[0].slice(0, 160);
    }
    return e.params.entry.level + ': ' + String(e.params.entry.text).slice(0, 160);
  });
  record('控制台 · 无异常/警告', problems.length === 0, problems.length ? problems.slice(0, 4).join(' | ') : '干净');
  await shot('03-final');
  page.ws.close();

  const failed = results.filter((r) => !r.ok);
  const report = {
    ranAt: new Date().toISOString(),
    page: page.page.title,
    passed: results.length - failed.length,
    total: results.length,
    results: results,
    screenshots: shotDir
  };
  fs.writeFileSync(path.join(shotDir, 'report.json'), JSON.stringify(report, null, 2), 'utf-8');
  console.log('');
  console.log((results.length - failed.length) + '/' + results.length + ' 通过 · 截图目录 ' + shotDir);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('回归脚本自身出错:', error.message);
  process.exit(2);
});