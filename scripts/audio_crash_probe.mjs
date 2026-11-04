#!/usr/bin/env node
/**
 * 音频崩溃复现器（Electron 45 排查用）
 *
 * 作用：启动打包好的程序 -> 用 CDP 让它加载一段音频 -> 报告进程是活着还是死了、退出码多少。
 * 不碰用户数据：用的是脚本自己现造的 0.2 秒正弦 WAV（blob），不读库里的文件。
 *
 * 用法：node scripts/audio_crash_probe.mjs [--exe <路径>] [--port 9222] [--mode blob|protocol]
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const EXE = path.resolve(argOf('exe', 'dist-v11-build/win-unpacked/EchoMind.exe'));
const PORT = Number(argOf('port', 9222));
const MODE = argOf('mode', 'blob');
const BASE = 'http://127.0.0.1:' + PORT;

const tasklistCount = (image) => {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq ' + image + '" /NH', { encoding: 'utf8' });
    return out.split('\n').filter((l) => l.includes(image)).length;
  } catch (_error) { return 0; }
};
const killAll = () => {
  for (const image of ['soundbot-backend.exe', 'EchoMind.exe']) {
    try { execSync('taskkill /F /IM ' + image + ' /T', { stdio: 'ignore' }); } catch (_error) { /* 没在跑就算了 */ }
  }
};
const findPage = async () => {
  try {
    const list = await (await fetch(BASE + '/json/list')).json();
    return list.find((t) => t.type === 'page' && !t.url.includes('splash')) || null;
  } catch (_error) { return null; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BLOB_EXPR = [
  '(async function(){',
  ' var sr=8000,n=1600,buf=new ArrayBuffer(44+n*2),v=new DataView(buf);',
  ' function w(o,s){for(var i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));}',
  ' w(0,"RIFF"); v.setUint32(4,36+n*2,true); w(8,"WAVE"); w(12,"fmt "); v.setUint32(16,16,true);',
  ' v.setUint16(20,1,true); v.setUint16(22,1,true); v.setUint32(24,sr,true); v.setUint32(28,sr*2,true);',
  ' v.setUint16(32,2,true); v.setUint16(34,16,true); w(36,"data"); v.setUint32(40,n*2,true);',
  ' for(var i=0;i<n;i++) v.setInt16(44+i*2, Math.round(9000*Math.sin(2*Math.PI*440*i/sr)), true);',
  ' var url=URL.createObjectURL(new Blob([buf],{type:"audio/wav"}));',
  ' var a=document.createElement("audio"); a.src=url; a.preload="auto"; a.load();',
  ' await new Promise(function(k){setTimeout(k,1500);});',
  ' return JSON.stringify({readyState:a.readyState,duration:a.duration,err:a.error?a.error.code:null});',
  '})()'
].join('\n');

const main = async () => {
  if (!fs.existsSync(EXE)) throw new Error('找不到程序: ' + EXE);
  killAll();
  await sleep(2500);
  const env = { ...process.env };
  // 本机装了 DSH，环境里带着 ELECTRON_RUN_AS_NODE=1，不清掉程序会当成 node 跑，直接报 bad option
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, ['--remote-debugging-port=' + PORT], { stdio: 'ignore', env, detached: true });
  child.unref();
  let exitCode = null;
  child.on('exit', (code) => { exitCode = code; });

  let page = null;
  for (let i = 0; i < 60 && !page; i++) { page = await findPage(); if (!page) await sleep(1500); }
  if (!page) throw new Error('主窗口没起来');
  console.log('主窗口已就绪，进程数 =', tasklistCount('EchoMind.exe'));

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const slot = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) slot.rej(new Error(msg.error.message));
      else slot.res(msg.result);
    }
  };
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? 'ERR ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) : r.result.value;
  };

  for (let i = 0; i < 30; i++) {
    if (await evaluate('typeof audioPlayer === "object" ? "ok" : "wait"') === 'ok') break;
    await sleep(1000);
  }
  console.log('加载音频（模式 ' + MODE + '）…');
  const expr = MODE === 'protocol'
    ? '(function(){ audioPlayer.src="soundmind-audio://local/' + '%E8%AF%B7%E5%A1%AB%E8%B7%AF%E5%BE%84' + '"; audioPlayer.load(); return "set"; })()'
    : BLOB_EXPR;
  const result = await Promise.race([
    evaluate(expr).catch((e) => 'ERR ' + e.message),
    sleep(12000).then(() => 'TIMEOUT（12 秒没返回，通常意味着进程已经没了）')
  ]);
  console.log('返回值 =', typeof result === 'string' ? result : JSON.stringify(result));
  await sleep(2000);
  const alive = tasklistCount('EchoMind.exe');
  console.log('进程数 =', alive, alive > 0 ? '→ 活着 ✅' : '→ 崩了 ❌');
  if (exitCode !== null) console.log('退出码 =', exitCode, '0x' + (exitCode >>> 0).toString(16));
  killAll();
  process.exit(alive > 0 ? 0 : 1);
};

main().catch((error) => { console.error('探针出错:', error.message); killAll(); process.exit(2); });
