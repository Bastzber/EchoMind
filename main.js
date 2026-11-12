/**
 * SoundBot - AI 音效管理器 (PyInstaller 一体化版本)
 * Copyright (C) 2026 Nagisa_Huckrick (胡杨)
 *
 * 前后端一体化打包，无需单独安装 Python 环境
 */

const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, protocol, shell, safeStorage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const net = require('net');
const crypto = require('crypto');
const fsSync = fs;   // 增量更新里用到同步 API（existsSync/createReadStream）
const audioCapabilityManifest = require('./config/audio_capabilities.json');
const supportedAudioExtensions = new Set(Object.keys(audioCapabilityManifest.formats || {}));
const supportedAudioFilterExtensions = [...supportedAudioExtensions].map((value) => value.slice(1));

const globalSearch = require('./lib/global-search');
// 单实例锁：重复双击快捷方式时聚焦已有窗口，避免出现多个实例、
// 每个实例又各自拉起一个后端去写同一个数据库。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    try { showMainWindow(); } catch (error) { console.warn('[App] 聚焦已有窗口失败:', error.message); }
  });
}

// 自定义协议：用于在渲染进程中安全加载本地音频
const AUDIO_PROTOCOL = 'soundmind-audio';

// 必须在 app.ready 之前调用
protocol.registerSchemesAsPrivileged([
  {
    scheme: AUDIO_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      // stream: true 必须开。
      // 少了它，<audio> 走这个协议加载会直接判「不支持的源」(MEDIA_ERR_SRC_NOT_SUPPORTED, err=4)，
      // 在 Electron 45 上更进一步：整个主进程 CHECK 挂掉，退出码 0x80000003，界面直接消失。
      // 11-04 实测：迷你程序里加与不加这个开关，一个小 WAV 一个是 rs=4 正常播放、一个是 rs=0 err=4。
      stream: true
    }
  }
]);

let mainWindow;
let backendProcess = null;
// 后端接口令牌：每次启动重新生成，只存在内存里，不落盘。
let backendApiToken = '';
let backendStartupPromise = null;
let ipcHandlersInitialized = false;
let floatWindows = {}; // id → 独立浮动面板窗口
let backendPort = Number(process.env.SOUNDBOT_PORT || 8000);
let backendOrigin = `http://127.0.0.1:${backendPort}`;
let backendWsOrigin = `ws://127.0.0.1:${backendPort}`;
let apiBaseUrl = `${backendOrigin}/api/v1`;
let secureSecretsCache = null;

// ==================== 窗口行为（关闭按钮 / 托盘） ====================
// closeBehavior: 'tray' 最小化到托盘 | 'minimize' 最小化到任务栏 | 'quit' 直接退出
let appTray = null;
let isQuitting = false;

function windowPrefsPath() {
  return path.join(app.getPath('userData'), 'window-prefs.json');
}

function readWindowPrefs() {
  const fallback = { closeBehavior: 'tray' };
  try {
    const file = windowPrefsPath();
    if (!fs.existsSync(file)) return fallback;
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const value = String(data?.closeBehavior || '');
    if (value === 'tray' || value === 'minimize' || value === 'quit') {
      return { closeBehavior: value };
    }
  } catch (error) {
    console.warn('[Window] 读取窗口偏好失败:', error.message);
  }
  return fallback;
}

function writeWindowPrefs(prefs) {
  try {
    const file = windowPrefsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(prefs, null, 2), 'utf-8');
  } catch (error) {
    console.warn('[Window] 保存窗口偏好失败:', error.message);
  }
}

function resolveTrayImage() {
  const candidates = [
    path.join(__dirname, 'assets', 'audio-icon.png'),
    path.join(process.resourcesPath || '', 'app.asar', 'assets', 'audio-icon.png'),
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        const image = nativeImage.createFromPath(candidate);
        if (!image.isEmpty()) return image;
      }
    } catch (error) {
      // 忽略，继续尝试下一个
    }
  }
  return nativeImage.createEmpty();
}

function ensureTray() {
  if (appTray) return appTray;
  appTray = new Tray(resolveTrayImage());
  appTray.setToolTip('回声 EchoMind');
  appTray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主界面', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '退出回声', click: () => { isQuitting = true; app.quit(); } }
  ]));
  appTray.on('click', () => showMainWindow());
  return appTray;
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}
let backendSecretsHydrated = false;
let audioProtocolRegistered = false;
let rendererBridgeReady = false;
let rendererPreloadFailure = null;
const activeBackendRequests = new Map();
let quitInProgress = false;
let pendingSplashState = {
  status: '正在启动服务…',
  progress: '初始化中',
  isError: false
};
let nativeOpenDialogActive = false;
const BACKEND_ERROR_SENTINEL = '__soundbotBackendError';
// sfx 也走同一套加密存储：音效生成的 key 同样能计费，不该明文落盘。
const SECRET_KEY_PATTERN = /^(llm|embedding|sfx)\.[a-z0-9_-]+\.api_key$/;
// ---------- 文件操作边界 ----------
// 渲染层是可以被注入的（XSS / 恶意预制件），而主进程在沙箱外有完整文件权限。
// 凡是「渲染层给路径、主进程落盘」的入口，一律先过这里，只放行素材库根目录以内。
// 边界来自后端索引状态（真实库根），不信任渲染层传进来的任何根。
let cachedLibraryRoots = { roots: [], at: 0 };
const LIBRARY_ROOTS_TTL = 60 * 1000;

async function getLibraryRoots() {
  const now = Date.now();
  if (cachedLibraryRoots.roots.length && (now - cachedLibraryRoots.at) < LIBRARY_ROOTS_TTL) {
    return cachedLibraryRoots.roots;
  }
  try {
    const data = await requestBackendJson(`${apiBaseUrl}/api/v1/library/roots`);
    const roots = Array.isArray(data?.roots) ? data.roots.map(String).filter(Boolean) : [];
    cachedLibraryRoots = { roots, at: now };
    return roots;
  } catch (_error) {
    return cachedLibraryRoots.roots;
  }
}

function assertInsideRoots(targetPath, roots) {
  const raw = String(targetPath || '');
  if (!raw) throw Object.assign(new Error('缺少路径'), { code: 'PATH_REQUIRED' });
  if (!path.isAbsolute(raw)) throw Object.assign(new Error('只接受绝对路径'), { code: 'PATH_NOT_ABSOLUTE' });
  if (!roots.length) {
    // 库还没索引完（首次启动）：退化为「用户数据目录 + 安装目录」两条安全边界
    roots = [getUserDataDir(), app.getPath('userData'), app.getPath('temp')].filter(Boolean);
  }
  const abs = path.resolve(raw);
  for (const root of roots) {
    const rootAbs = path.resolve(String(root));
    const rel = path.relative(rootAbs, abs);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return abs;
  }
  throw Object.assign(new Error('路径不在素材库范围内: ' + abs), { code: 'PATH_OUTSIDE_LIBRARY' });
}

const MAIN_LOG_MAX_BYTES = 5 * 1024 * 1024;
let mainLogPath = null;

function redactDiagnosticText(value) {
  return String(value)
    .replace(
      /((?:["']?api[_-]?key["']?|["']?access[_-]?token["']?|["']?secret["']?)\s*[=:]\s*["']?)[^"',;\s}&\]]+/gi,
      '$1[REDACTED]'
    )
    .replace(
      /(["']?authorization["']?\s*[=:]\s*["']?bearer\s+)[^"',;\s}&\]]+/gi,
      '$1[REDACTED]'
    )
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]');
}

function formatDiagnosticValue(value) {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function initializeMainLogging() {
  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };
  try {
    app.setAppLogsPath();
    const logDir = app.getPath('logs');
    fs.mkdirSync(logDir, { recursive: true });
    mainLogPath = path.join(logDir, 'soundbot-main.log');
    if (fs.existsSync(mainLogPath) && fs.statSync(mainLogPath).size > MAIN_LOG_MAX_BYTES) {
      const previous = `${mainLogPath}.1`;
      if (fs.existsSync(previous)) fs.unlinkSync(previous);
      fs.renameSync(mainLogPath, previous);
    }
    const stream = fs.createWriteStream(mainLogPath, { flags: 'a', encoding: 'utf8' });
    // 日志攒着写。
    // 老写法是一条日志一次 stream.write，索引/检索跑起来一秒几十上百条，
    // 全是同步小写入，白磨硬盘还占着事件循环。现在先进内存队列，
    // 攒够 64 KB 或者过 400 毫秒再一次性落盘；退出前强制冲一次。
    const LOG_FLUSH_MS = 400;
    const LOG_FLUSH_BYTES = 64 * 1024;
    let pendingLines = [];
    let pendingBytes = 0;
    let flushTimer = null;
    // 攒批效果的计数器：每分钟汇报一次「多少行 / 写了几次 / 多少字节」，
    // 用来对照老写法（每行一次 write）到底省了多少次系统调用。
    const logStats = { lines: 0, flushes: 0, bytes: 0, reportedAt: Date.now() };
    const flushLogs = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!pendingLines.length) return;
      const chunk = pendingLines.join('');
      const flushedBytes = pendingBytes;
      pendingLines = [];
      pendingBytes = 0;
      try {
        stream.write(chunk);
        logStats.flushes += 1;
        logStats.bytes += flushedBytes;
      } catch (_error) {
        // 写不进就算了，日志不能反过来拖垮程序
      }
    };
    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(flushLogs, LOG_FLUSH_MS);
      if (typeof flushTimer.unref === 'function') flushTimer.unref();
    };
    for (const level of ['log', 'warn', 'error']) {
      console[level] = (...args) => {
        original[level](...args);
        const message = args.map(formatDiagnosticValue).join(' ');
        const line = `${new Date().toISOString()} | ${level.toUpperCase()} | ${redactDiagnosticText(message)}\n`;
        pendingLines.push(line);
        pendingBytes += line.length;
        logStats.lines += 1;
        if (pendingBytes >= LOG_FLUSH_BYTES) flushLogs();
        else scheduleFlush();
      };
    }
    // 每分钟报一次攒批成绩（没有新日志就不报）
    const statsTimer = setInterval(() => {
      if (!logStats.lines) return;
      const windowSeconds = Math.max(1, Math.round((Date.now() - logStats.reportedAt) / 1000));
      logStats.reportedAt = Date.now();
      console.log(
        `[Main] 日志攒批：${logStats.lines} 行 / 写盘 ${logStats.flushes} 次 / ${(logStats.bytes / 1024).toFixed(0)} KB（近 ${windowSeconds}s，老写法要写 ${logStats.lines} 次）`
      );
      logStats.lines = 0;
      logStats.flushes = 0;
      logStats.bytes = 0;
    }, 60000);
    if (typeof statsTimer.unref === 'function') statsTimer.unref();

    app.on('before-quit', flushLogs);
    process.on('exit', flushLogs);
    process.on('uncaughtExceptionMonitor', error => {
      console.error('[Main] Uncaught exception:', error);
    });
    console.log(`[Main] Persistent diagnostics enabled: ${mainLogPath}`);
  } catch (error) {
    original.error('[Main] Failed to initialize persistent diagnostics:', error);
  }
}

// ==================== 路径辅助函数 ====================

/**
 * 获取应用根目录
 */
function getAppRootDir() {
  if (app.isPackaged) {
    return path.dirname(process.execPath);
  }
  return __dirname;
}

/**
 * 获取用户数据目录
 */
function getUserDataDir() {
  return app.getPath('userData');
}

// 固定用户数据目录为 AppData\EchoMind：产品已更名为"回声 EchoMind"，
// 显式固定数据目录，确保索引/配置存储位置稳定、名称与产品一致。
if (app && typeof app.setPath === 'function') {
  try {
    app.setPath('userData', path.join(app.getPath('appData'), 'EchoMind'));
  } catch (error) {
    console.error('[Main] Failed to pin userData dir:', error);
  }
}

function getSecureSecretsPath() {
  return path.join(getUserDataDir(), 'secure_secrets.json');
}

function validateSecretKey(key) {
  if (typeof key !== 'string' || !SECRET_KEY_PATTERN.test(key)) {
    throw new Error('无效的密钥标识');
  }
}

function readSecureSecrets() {
  if (secureSecretsCache) return secureSecretsCache;

  try {
    const secretsPath = getSecureSecretsPath();
    if (fs.existsSync(secretsPath)) {
      const parsed = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'));
      secureSecretsCache = parsed && typeof parsed === 'object' ? parsed : {};
      return secureSecretsCache;
    }
  } catch (error) {
    console.warn('[Secrets] Failed to read encrypted secret store:', error);
  }

  secureSecretsCache = {};
  return secureSecretsCache;
}

function writeSecureSecrets(secrets) {
  const secretsPath = getSecureSecretsPath();
  const temporaryPath = `${secretsPath}.tmp-${process.pid}`;
  fs.mkdirSync(getUserDataDir(), { recursive: true });
  fs.writeFileSync(temporaryPath, JSON.stringify(secrets, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(temporaryPath, secretsPath);
  secureSecretsCache = secrets;
}

let safeStorageStatusCache = null;

function computeSafeStorageStatusSync() {
  // 老版本 Electron 只有同步接口，保留这条兜底路径。
  let encryptionAvailable = false;
  try {
    if (typeof safeStorage.isEncryptionAvailable === 'function') {
      encryptionAvailable = safeStorage.isEncryptionAvailable();
    }
  } catch (_error) {
    encryptionAvailable = false;
  }
  let backend = null;
  if (encryptionAvailable && typeof safeStorage.getSelectedStorageBackend === 'function') {
    try {
      backend = safeStorage.getSelectedStorageBackend();
    } catch (error) {
      console.warn('[Secrets] Failed to inspect safeStorage backend:', error);
    }
  }
  // Linux's basic_text backend is obfuscation, not OS-backed encryption.  It
  // is outside the supported release targets and must not be advertised as a
  // secure credential store.
  const available = encryptionAvailable && backend !== 'basic_text';
  return { available, backend };
}

function getSafeStorageStatus() {
  if (!safeStorageStatusCache) {
    safeStorageStatusCache = computeSafeStorageStatusSync();
  }
  return safeStorageStatusCache;
}

// Electron 45 把 isEncryptionAvailable 标成 deprecated，每次调用都往 stderr 打警告；
// 新接口是异步的 isAsyncEncryptionAvailable。整条调用链都改 async 动静太大，
// 所以这里在 app ready 时用异步版探一次，结果缓存给同步调用点用。
async function primeSafeStorageStatus() {
  try {
    if (typeof safeStorage.isAsyncEncryptionAvailable === 'function') {
      const encryptionAvailable = await safeStorage.isAsyncEncryptionAvailable();
      let backend = null;
      if (encryptionAvailable && typeof safeStorage.getSelectedStorageBackend === 'function') {
        try {
          backend = safeStorage.getSelectedStorageBackend();
        } catch (_error) {
          backend = null;
        }
      }
      safeStorageStatusCache = {
        available: Boolean(encryptionAvailable) && backend !== 'basic_text',
        backend
      };
      return safeStorageStatusCache;
    }
  } catch (error) {
    console.warn('[Secrets] isAsyncEncryptionAvailable failed:', error?.message || error);
  }
  return getSafeStorageStatus();
}

function isSecureStorageAvailable() {
  return getSafeStorageStatus().available;
}

function secretKeyFor(scope, provider) {
  const key = `${scope}.${String(provider || '').toLowerCase()}.api_key`;
  validateSecretKey(key);
  return key;
}

function hasEncryptedSecret(key) {
  validateSecretKey(key);
  const secrets = readSecureSecrets();
  return typeof secrets[key] === 'string' && secrets[key].length > 0;
}

function decryptStoredSecret(key) {
  validateSecretKey(key);
  const encoded = readSecureSecrets()[key];
  if (!encoded) return null;
  // Fallback entries are written when the OS keyring is unavailable (see
  // setStoredSecret). They are local-only obfuscation, not OS encryption.
  if (encoded.startsWith('plain:')) {
    return Buffer.from(encoded.slice(6), 'base64').toString('utf8');
  }
  if (!isSecureStorageAvailable()) return null;
  return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
}

function setStoredSecret(key, value) {
  validateSecretKey(key);
  if (typeof value !== 'string' || value.length === 0) {
    const error = new Error('密钥值不能为空');
    error.code = 'INVALID_SECRET';
    throw error;
  }
  const secrets = { ...readSecureSecrets() };
  if (!isSecureStorageAvailable()) {
    // 系统钥匙串不可用时，至少把密钥持久化到用户数据目录，避免每次重启
    // 都要重填 API Key。这里是本地混淆而非系统加密，会记录告警。
    secrets[key] = 'plain:' + Buffer.from(value, 'utf8').toString('base64');
    writeSecureSecrets(secrets);
    console.warn('[Secrets] safeStorage unavailable; stored credential with local fallback');
    return;
  }
  secrets[key] = safeStorage.encryptString(value).toString('base64');
  writeSecureSecrets(secrets);
}

function deleteStoredSecret(key) {
  validateSecretKey(key);
  const secrets = { ...readSecureSecrets() };
  const existed = Object.prototype.hasOwnProperty.call(secrets, key);
  if (existed) {
    delete secrets[key];
    writeSecureSecrets(secrets);
  }
  return existed;
}

function redactLegacyConfigSecrets(configData) {
  const migrated = [];
  const sanitized = JSON.parse(JSON.stringify(configData || {}));
  const llm = sanitized.llm && typeof sanitized.llm === 'object' ? sanitized.llm : {};
  for (const [provider, providerConfig] of Object.entries(llm)) {
    if (!providerConfig || typeof providerConfig !== 'object' || Array.isArray(providerConfig)) continue;
    const value = typeof providerConfig.api_key === 'string' ? providerConfig.api_key : '';
    if (value && value !== '***') {
      migrated.push({ key: secretKeyFor('llm', provider), value });
    }
    delete providerConfig.api_key;
    if (providerConfig.headers && typeof providerConfig.headers === 'object') {
      for (const header of Object.keys(providerConfig.headers)) {
        if (/(authorization|api[-_]?key|access[-_]?token|secret)/i.test(header)) {
          delete providerConfig.headers[header];
        }
      }
    }
  }

  const embedding = sanitized.embedding && typeof sanitized.embedding === 'object'
    ? sanitized.embedding
    : {};
  for (const [provider, providerConfig] of Object.entries(embedding)) {
    if (!providerConfig || typeof providerConfig !== 'object' || Array.isArray(providerConfig)) continue;
    const value = typeof providerConfig.api_key === 'string' ? providerConfig.api_key : '';
    if (value && value !== '***') {
      migrated.push({ key: secretKeyFor('embedding', provider), value });
    }
    delete providerConfig.api_key;
  }
  return { sanitized, migrated };
}

// 旧版把音效 key 明文写在 %APPDATA%\soundbot\.sfx_config.json 里。
// 启动时搬进 DPAPI 存储，搬完把明文那一行删掉（文件留着，save_dir 还在用）。
function migrateLegacySfxSecret() {
  const file = path.join(app.getPath('appData'), 'soundbot', '.sfx_config.json');
  if (!fs.existsSync(file)) return { migrated: false };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (_error) {
    return { migrated: false };
  }
  const plain = String((parsed && parsed.api_key) || '').trim();
  if (!plain) return { migrated: false };
  try {
    const key = secretKeyFor('sfx', 'default');
    if (!hasEncryptedSecret(key)) setStoredSecret(key, plain);
    const next = { ...parsed };
    delete next.api_key;
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf-8');
    console.log('[Secrets] Migrated legacy sfx api_key into OS secure storage');
    return { migrated: true };
  } catch (error) {
    // 搬失败就原样留着，至少别把用户的 key 弄丢
    console.warn('[Secrets] sfx api_key migration deferred:', error && error.message);
    return { migrated: false, error: String(error && error.message) };
  }
}

function migrateLegacyPlaintextSecrets() {
  const configPath = path.join(getUserDataDir(), 'ai_config.json');
  if (!fs.existsSync(configPath)) return { success: true, migrated: 0 };
  if (!isSecureStorageAvailable()) {
    console.warn('[Secrets] Legacy plaintext migration pending: OS secure storage is unavailable');
    return { success: false, pending: true, migrated: 0 };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (error) {
    console.warn('[Secrets] Legacy plaintext migration skipped: config is unreadable');
    return { success: false, pending: true, migrated: 0 };
  }

  const { sanitized, migrated } = redactLegacyConfigSecrets(parsed);
  const hasApiKeyFields = JSON.stringify(parsed) !== JSON.stringify(sanitized);
  if (!hasApiKeyFields) return { success: true, migrated: 0 };

  const originalSecrets = { ...readSecureSecrets() };
  try {
    for (const { key, value } of migrated) {
      if (!hasEncryptedSecret(key)) {
        setStoredSecret(key, value);
      }
    }
    const temporaryPath = `${configPath}.tmp-${process.pid}`;
    fs.writeFileSync(temporaryPath, JSON.stringify(sanitized, null, 2), {
      encoding: 'utf-8',
      mode: 0o600
    });
    fs.renameSync(temporaryPath, configPath);
    console.log(`[Secrets] Migrated ${migrated.length} legacy credential(s) into OS secure storage`);
    return { success: true, migrated: migrated.length };
  } catch (error) {
    // Keep the legacy file untouched and restore the previous secure store so
    // a partial migration never loses or changes the user's credential.
    try {
      writeSecureSecrets(originalSecrets);
    } catch (_) {
    }
    console.warn('[Secrets] Legacy plaintext migration failed; original config was preserved');
    return { success: false, pending: true, migrated: 0 };
  }
}

function toBackendError(error, context = {}) {
  const rawDetails = error && Object.prototype.hasOwnProperty.call(error, 'details')
    ? error.details
    : (error && Object.prototype.hasOwnProperty.call(error, 'detail') ? error.detail : {});
  const details = rawDetails && typeof rawDetails === 'object'
    ? rawDetails
    : (rawDetails == null ? {} : { detail: rawDetails });
  return {
    [BACKEND_ERROR_SENTINEL]: true,
    error: {
      code: error?.code || context.code || 'BACKEND_REQUEST_FAILED',
      message: error?.message || context.message || '后端请求失败',
      retryable: Boolean(error?.retryable ?? context.retryable ?? false),
      details,
      // v0.1 renderer compatibility; new code should use `details`.
      detail: details,
      status: Number.isInteger(error?.status) ? error.status : null,
      action: context.action || null,
      url: context.url || null
    }
  };
}

// 自定义协议要自己给 Content-Type，否则 <audio> 拿不到正确的解码提示，
// 部分格式（flac/m4a）会直接报「不支持」。
// 按扩展名猜 Content-Type 会出事：库里就有 .mp3 后缀、内容其实是 24 位 WAV 的文件
// （节奏循环.mp3，5.4 MB，44.1k / 2ch / 24bit）。声明成 audio/mpeg 之后，
// 解码器按 MP3 去读 WAV 的字节 —— 出来的就是一片雪花噪声。
// 全库扫过一遍：扩展名和真实容器对不上的有 1,040 个（mp3 实为 wav 400、aac 实为 mp3 350 等）。
// 所以先看文件头，认得出就按真实容器给类型，认不出才退回扩展名。
const AUDIO_MAGIC = [
  { ext: '.wav', ok: (h) => h.slice(0, 4) === 'RIFF' && h.slice(8, 12) === 'WAVE' },
  { ext: '.aiff', ok: (h) => h.slice(0, 4) === 'FORM' && (h.slice(8, 12) === 'AIFF' || h.slice(8, 12) === 'AIFC') },
  { ext: '.flac', ok: (h) => h.slice(0, 4) === 'fLaC' },
  { ext: '.ogg', ok: (h) => h.slice(0, 4) === 'OggS' },
  { ext: '.mp3', ok: (h) => h.slice(0, 3) === 'ID3' },
  { ext: '.m4a', ok: (h) => h.slice(4, 8) === 'ftyp' },
  { ext: '.caf', ok: (h) => h.slice(0, 4) === 'caff' },
  { ext: '.ape', ok: (h) => h.slice(0, 3) === 'MAC' },
  // ASF 容器头，WMA 就是它：30 26 B2 75
  { ext: '.wma', ok: (h) => h.charCodeAt(0) === 0x30 && h.charCodeAt(1) === 0x26 && h.charCodeAt(2) === 0xb2 && h.charCodeAt(3) === 0x75 },
  // MP3 帧同步字
  { ext: '.mp3', ok: (h) => h.charCodeAt(0) === 0xff && (h.charCodeAt(1) & 0xe0) === 0xe0 },
];

function sniffAudioContainer(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(16);
    const read = fs.readSync(fd, buffer, 0, 16, 0);
    if (read < 12) return null;
    const head = buffer.slice(0, read).toString('latin1');
    for (const item of AUDIO_MAGIC) {
      if (item.ok(head)) return item.ext;
    }
    return null;
  } catch (_error) {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_error) { /* 关不掉就算了 */ }
    }
  }
}

function guessAudioContentType(filePath) {
  const typeByExt = {
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.aiff': 'audio/aiff',
    '.aif': 'audio/aiff',
    '.wma': 'audio/x-ms-wma',
    '.ape': 'audio/x-ape',
    '.caf': 'audio/x-caf',
  };
  const declared = path.extname(String(filePath || '')).toLowerCase();
  const sniffed = sniffAudioContainer(filePath);
  const real = sniffed || declared;
  if (sniffed && sniffed !== declared) {
    console.warn('[AudioProtocol] 扩展名与真实格式不一致，按真实格式处理: ' + path.basename(filePath) + ' (' + declared + ' -> ' + sniffed + ')');
  }
  return typeByExt[real] || 'application/octet-stream';
}

function registerAudioProtocol() {
  if (audioProtocolRegistered) return;

  // 解析 URL 到磁盘路径（新旧两套 API 共用这段逻辑）
  const resolveAudioPath = (requestUrl) => {
    const parsed = new URL(requestUrl);
    const encodedPath = parsed.pathname.startsWith('/')
      ? parsed.pathname.slice(1)
      : parsed.pathname;
    const filePath = decodeURIComponent(encodedPath);
    if (!filePath || !path.isAbsolute(filePath)) return null;
    if (!fs.existsSync(filePath)) return null;
    try {
      if (!fs.statSync(filePath).isFile()) return null;
    } catch (_error) {
      return null;
    }
    return filePath;
  };

  // Electron 25 起 protocol.handle 是推荐写法，registerFileProtocol 已废弃；
  // 34 之后旧 API 被移除，所以升级到新版本前先把这里换掉。
  // 保留旧分支是为了让旧版本还能跑（万一要回退）。
  if (typeof protocol.handle === 'function') {
    protocol.handle(AUDIO_PROTOCOL, async (request) => {
      const filePath = resolveAudioPath(request.url);
      if (!filePath) {
        return new Response('not found', { status: 404 });
      }
      // 这里必须自己读成 Buffer 并显式给 Content-Length。
      // 换成 net.fetch(file://) 或者不带长度的流，Chromium 拿不到总字节数，
      // 音频元素算出的 duration 就是 Infinity —— 播放条显示 Infinity:NaN:NaN，
      // 点波形跳转时 currentTime 被设成 NaN，直接抛
      // "Failed to set the 'currentTime' ... non-finite" 红条。
      // 11-04 实测（同一个 mp3，三种写法）：
      //   net.fetch            → duration = Infinity
      //   读 Buffer + 带长度    → duration = 190.0112  ✅
      //   registerFileProtocol → duration = 190.0112  ✅（Electron 45 已移除，不用）
      try {
        const data = await fs.promises.readFile(filePath);
        return new Response(data, {
          status: 200,
          headers: {
            'Content-Type': guessAudioContentType(filePath),
            'Content-Length': String(data.byteLength),
          },
        });
      } catch (error) {
        console.error('[AudioProtocol] read failed:', error);
        return new Response('read error', { status: 500 });
      }
    });
  } else {
    protocol.registerFileProtocol(AUDIO_PROTOCOL, (request, callback) => {
      try {
        const filePath = resolveAudioPath(request.url);
        if (!filePath) { callback({ error: -6 }); return; }
        callback({ path: filePath });
      } catch (error) {
        console.error('[AudioProtocol] Failed to resolve audio URL:', error);
        callback({ error: -2 });
      }
    });
  }

  audioProtocolRegistered = true;
}

/**
 * 获取后端可执行文件路径
 * onedir 模式：resources/backend/soundbot-backend/soundbot-backend
 */
function getBackendExecutable() {
  // 开发模式：强制走 .venv 的 python 跑源码，避免用到旧的打包后端
  if (process.env.SOUNDBOT_BACKEND_DEV === '1') {
    console.log('[Backend] DEV mode: skipping packaged backend, using source python');
    return null;
  }
  const exeName = process.platform === 'win32'
    ? 'soundbot-backend.exe'
    : 'soundbot-backend';

  // 可能的路径（按优先级）
  const possiblePaths = [
    // 1. 生产环境 - extraResources 路径
    path.join(process.resourcesPath, 'backend', 'soundbot-backend', exeName),

    // 2. 开发环境
    path.join(__dirname, 'dist', 'backend', 'soundbot-backend', exeName),
    path.join(__dirname, 'backend', 'dist', 'backend', 'soundbot-backend', exeName),

    // 3. 应用目录（便携模式）
    path.join(getAppRootDir(), 'backend', 'soundbot-backend', exeName),
    path.join(getAppRootDir(), 'resources', 'backend', 'soundbot-backend', exeName),
  ];

  console.log('[Backend] Searching for backend executable...');
  for (const p of possiblePaths) {
    console.log(`[Backend] Checking: ${p}`);
    if (fs.existsSync(p)) {
      console.log(`[Backend] ✓ Found backend executable: ${p}`);
      return p;
    }
  }

  console.error('[Backend] ✗ Backend executable not found. Tried paths:');
  possiblePaths.forEach(p => console.error(`  - ${p}`));
  return null;
}

/**
 * 获取后端启动命令：优先已打包的 PyInstaller 后端；
 * 源码开发模式下回退到 .venv 中的 python 直接运行 backend/main.py。
 * 返回 { exe, args, backendDir, isSourceMode } 或 null。
 */
function getBackendSpawnInfo() {
  const exe = getBackendExecutable();
  if (exe) {
    return { exe, args: [], backendDir: path.dirname(exe), isSourceMode: false };
  }

  // 源码开发模式：查找 venv 中的 python
  const backendDir = path.join(__dirname, 'backend');
  const pythonCandidates = [
    path.join(backendDir, '.venv', 'Scripts', 'python.exe'),
    path.join(__dirname, '.venv', 'Scripts', 'python.exe'),
  ];
  for (const py of pythonCandidates) {
    if (fs.existsSync(py)) {
      console.log(`[Backend] Source mode: using python ${py}`);
      return {
        exe: py,
        args: [path.join(backendDir, 'main.py')],
        backendDir,
        isSourceMode: true,
      };
    }
  }
  return null;
}

/**
 * 验证后端目录完整性
 */
function verifyBackendIntegrity(backendDir) {
  console.log(`[Backend] Verifying backend integrity: ${backendDir}`);

  const exeName = process.platform === 'win32'
    ? 'soundbot-backend.exe'
    : 'soundbot-backend';

  const requiredItems = [
    'soundbot-backend',
    'soundbot-backend.exe',
    '_internal',  // PyInstaller 新版本使用 _internal
    'lib',        // 旧版本使用 lib
    'base_library.zip'
  ];

  const foundItems = [];
  for (const item of requiredItems) {
    const itemPath = path.join(backendDir, item);
    if (fs.existsSync(itemPath)) {
      foundItems.push(item);
      const stats = fs.statSync(itemPath);
      console.log(`[Backend] ✓ ${item} (${stats.isDirectory() ? 'dir' : 'file'})`);
    }
  }

  const executablePath = path.join(backendDir, exeName);
  const executableFound = fs.existsSync(executablePath) && fs.statSync(executablePath).isFile();
  const runtimeFound = foundItems.some((item) => ['_internal', 'lib', 'base_library.zip'].includes(item));

  if (!executableFound || !runtimeFound) {
    console.error('[Backend] ✗ Backend executable or runtime files are missing');
    return false;
  }

  const executableSize = fs.statSync(executablePath).size;
  if (executableSize < 100 * 1024) {
    console.error('[Backend] ✗ Backend executable is unexpectedly small');
    return false;
  }

  return true;
}

/**
 * 自动检索模型目录
 * 优先级：环境变量 > 应用目录 > 用户数据目录 > 开发目录
 */
function findModelsDir() {
  // An explicit override is authoritative, including when it intentionally
  // points at a missing directory for diagnostics. Falling through to the
  // bundled model would make configuration mistakes and missing-model tests
  // look healthy.
  const envPath = process.env.SOUNDBOT_MODELS_PATH;
  if (envPath) {
    const explicitPath = path.resolve(envPath);
    console.log(`[Models] Using explicit model directory: ${explicitPath}`);
    return explicitPath;
  }

  const possiblePaths = [];

  // 2. 应用资源目录
  possiblePaths.push(path.join(process.resourcesPath, 'models'));
  possiblePaths.push(path.join(getAppRootDir(), 'models'));

  // 3. 用户数据目录
  possiblePaths.push(path.join(getUserDataDir(), 'models'));

  // 4. 开发环境
  possiblePaths.push(path.join(__dirname, 'models'));
  possiblePaths.push(path.join(__dirname, '..', 'models'));

  console.log('[Models] Searching for models directory...');

  // 查找第一个包含 clap 子目录的路径
  for (const modelsPath of possiblePaths) {
    const clapDir = path.join(modelsPath, 'clap');
    console.log(`[Models] Checking: ${modelsPath}`);
    if (fs.existsSync(clapDir) && fs.statSync(clapDir).isDirectory()) {
      console.log(`[Models] ✓ Found models directory: ${modelsPath}`);
      return modelsPath;
    }
  }

  // 没找到，返回第一个路径（用于错误提示）
  const defaultPath = possiblePaths[0] || path.join(getUserDataDir(), 'models');
  console.log(`[Models] ✗ Models not found, using default: ${defaultPath}`);
  return defaultPath;
}

/**
 * 检查模型是否存在
 */
function checkModels() {
  const modelsDir = findModelsDir();
  const clapDir = path.join(modelsDir, 'clap');

  return {
    exists: fs.existsSync(clapDir) && fs.statSync(clapDir).isDirectory(),
    path: modelsDir
  };
}

// ==================== 后端管理 ====================

/**
 * 查找可用端口（从 startPort 开始递增）
 */
function findFreePort(startPort) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(findFreePort(startPort + 1)));
    server.once('listening', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.listen(startPort, '127.0.0.1');
  });
}

function updateBackendEndpoint(port) {
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid backend port: ${port}`);
  }
  backendPort = parsed;
  backendOrigin = `http://127.0.0.1:${backendPort}`;
  backendWsOrigin = `ws://127.0.0.1:${backendPort}`;
  apiBaseUrl = `${backendOrigin}/api/v1`;
}

/**
 * 启动后端服务
 */
async function startBackend() {
  migrateLegacyPlaintextSecrets();
  migrateLegacySfxSecret();
  if (backendProcess) {
    console.log('[Backend] Backend service already running');
    return { success: true };
  }

  // 找可用端口，避免 "Address already in use" 错误
  const freePort = await findFreePort(backendPort);
  if (freePort !== backendPort) {
    console.log(`[Backend] Port ${backendPort} busy, switching to ${freePort}`);
    updateBackendEndpoint(freePort);
  }

  // 检查模型
  const modelStatus = checkModels();
  if (!modelStatus.exists) {
    console.warn('[Backend] Model files not found:', modelStatus.path);
    console.warn('[Backend] Starting without CLAP; management and keyword search remain available.');
  }

  // 获取后端启动命令（打包 exe 或源码模式 python）
  const spawnInfo = getBackendSpawnInfo();
  if (!spawnInfo) {
    return { success: false, error: '未找到后端可执行文件' };
  }
  const backendExe = spawnInfo.exe;
  const backendArgs = spawnInfo.args || [];
  const backendDir = spawnInfo.backendDir;

  // 打包模式才校验 PyInstaller 目录完整性；源码模式跳过
  if (!spawnInfo.isSourceMode && !verifyBackendIntegrity(backendDir)) {
    return { success: false, error: '后端文件不完整' };
  }

  // 一次性接口令牌：主进程生成，只经环境变量交给后端，渲染层从 preload 取。
  // 后端对着 /api/v1/* 校验，没有令牌一律 401 —— 本机任意进程或网页都拿不到数据。
  if (!backendApiToken) {
    backendApiToken = crypto.randomBytes(24).toString('hex');
  }

  // 设置环境变量
  const env = {
    ...process.env,
    SOUNDBOT_PORT: String(backendPort),
    ECHOMIND_API_TOKEN: backendApiToken,
    SOUNDBOT_MODELS_PATH: modelStatus.path,
    SOUNDBOT_USER_DATA_DIR: getUserDataDir(),
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    // 限制 BLAS/OpenMP 线程数：20 核机器上 torch 默认会起满线程，
    // 与 Python 检索线程抢 CPU（实测单进程内并发检索被拖慢上百倍）。
    OMP_NUM_THREADS: '4',
    MKL_NUM_THREADS: '4',
    OPENBLAS_NUM_THREADS: '4',
    NUMEXPR_NUM_THREADS: '4'
  };

  console.log(`[Backend] Starting backend: ${backendExe}`);
  console.log(`[Backend] Working directory: ${backendDir}`);
  console.log(`[Backend] Model path: ${env.SOUNDBOT_MODELS_PATH}`);

  try {
    // 启动后端进程
    backendProcess = spawn(backendExe, backendArgs, {
      env,
      cwd: backendDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
      // Keep the console-mode PyInstaller executable (stdout carries the
      // authoritative BOUND_PORT handshake) without flashing a separate
      // console window in the installed Windows application.
      windowsHide: true
    });

    // The Python process performs a final bind check and announces the actual
    // port before starting Uvicorn. Treat that handshake as authoritative so
    // a process racing for the Electron-probed port cannot split the app.
    let resolvePortHandshake;
    let portHandshakeSettled = false;
    let stdoutHandshakeBuffer = '';
    const portHandshake = new Promise((resolve) => {
      resolvePortHandshake = (value) => {
        if (portHandshakeSettled) return;
        portHandshakeSettled = true;
        resolve(value);
      };
    });

    // 日志处理
    backendProcess.stdout.on('data', (data) => {
      const rawText = data.toString();
      const text = rawText.trim();
      if (text) console.log(`[Backend] ${text}`);
      stdoutHandshakeBuffer = `${stdoutHandshakeBuffer}${rawText}`;
      const match = stdoutHandshakeBuffer.match(/BOUND_PORT=(\d{1,5})/);
      if (match) {
        try {
          updateBackendEndpoint(Number(match[1]));
          console.log(`[Backend] Confirmed bound port ${backendPort}`);
          resolvePortHandshake(backendPort);
        } catch (error) {
          console.error('[Backend] Invalid port handshake:', error);
          resolvePortHandshake(null);
        }
      }
      stdoutHandshakeBuffer = stdoutHandshakeBuffer.slice(-4096);
    });

    backendProcess.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (!text) return;
      // Python 的进度条、jieba 加载提示都走 stderr；一律记成 ERROR 会让
      // soundbot-main.log 全是假错误。只有真像异常的才升到 ERROR。
      if (/(Traceback|\bERROR\b|Exception|Error:|CRITICAL)/.test(text)) {
        console.error(`[Backend] ${text}`);
      } else {
        console.log(`[Backend:stderr] ${text}`);
      }
    });

    backendProcess.on('error', (error) => {
      console.error('[Backend] Process error:', error);
      backendProcess = null;
      backendStartupPromise = null;
      backendSecretsHydrated = false;
      resolvePortHandshake(null);
    });

    backendProcess.on('exit', (code, signal) => {
      console.log(`[Backend] Process exited, code: ${code}, signal: ${signal}`);
      backendProcess = null;
      backendStartupPromise = null;
      backendSecretsHydrated = false;
      resolvePortHandshake(null);
    });

    let handshakeTimer;
    const announcedPort = await Promise.race([
      portHandshake,
      new Promise((resolve) => {
        // 冷启动（关掉所有进程后再开）实测会超过 10 秒：数据库 5 万行 + FTS + 标签表初始化
    // 都要时间，10 秒会把正常启动误判成失败。给到 45 秒，只是兜底上限。
    handshakeTimer = setTimeout(() => resolve(null), 240000);
      })
    ]);
    clearTimeout(handshakeTimer);
    if (!announcedPort) {
      console.error('[Backend] ✗ Port handshake timeout');
      if (backendProcess && backendProcess.exitCode === null) backendProcess.kill();
      return { success: false, error: '后端端口握手失败' };
    }

    const health = await waitForBackendHealth(300000, (elapsed) => {
      updateSplashStatus('正在启动后端服务...', `数据库加载中 ${elapsed}s`);
    });
    if (health.success) {
      console.log('[Backend] ✓ Backend service started successfully');
    } else {
      console.error(`[Backend] ✗ ${health.error}`);
    }
    return health;

  } catch (error) {
    console.error('[Backend] Startup failed:', error);
    return { success: false, error: error.message };
  }
}

// 健康探测同时也是「冷启动进度条」。
// 2026-11-04 实测：库里有 195,174 行文件、6.2 GB 的 SQLite + 3.2 GB 向量库，
// 全部读进内存要 2 分半，而这里的预算只有 120 秒 —— 结果后端一切正常，
// 主进程却已经判了「启动超时」，界面死在启动窗上，提示「请重新安装」。
// 现在：预算放到 5 分钟，同时在启动窗上滚已等秒数，超时文案也不再吓人。
let backendVersionMismatch = null;
async function waitForBackendHealth(timeoutMs = 300000, onProgress = null) {
  const startedAt = Date.now();
  const appVersion = app.getVersion();
  let lastNotifiedSecond = 0;

  while (Date.now() - startedAt < timeoutMs) {
    if (!backendProcess || backendProcess.exitCode !== null) {
      const code = backendProcess ? backendProcess.exitCode : 'unknown';
      return { success: false, error: `后端进程意外退出 (code: ${code})` };
    }
    const controller = new AbortController();
    const requestTimer = setTimeout(() => controller.abort(), 2000);
    try {
      // /api/v1/health 也在令牌闸门后面（H1 把 /api/v1/* 全收了）。
      // 不带这个头，新后端一律 401，健康检查永远不通过 —— 老的后端 exe 没有这道闸门，
      // 所以「重打后端」之后才会暴露：这正是 11-04 这台机器上打不开的原因之一。
      const res = await fetch(`${apiBaseUrl}/health`, {
        signal: controller.signal,
        headers: backendApiToken ? { 'X-EchoMind-Token': backendApiToken } : {}
      });
      if (res.ok) {
        const payload = await res.json().catch(() => null);
        if (payload?.status === 'degraded' && payload?.audio_decoder_available === false) {
          return {
            success: false,
            error: '安装包内置音频解码器不可用',
            code: 'AUDIO_RUNTIME_UNAVAILABLE'
          };
        }
        if (payload?.status === 'healthy' && payload?.audio_decoder_available === true) {
          // 原来这里要求后端版本必须严格等于应用版本，否则一直轮询到超时。
          // 后果是「后端 exe 没跟着重新打包」等于整台机器打不开（11-04 就撞上了：
          // 应用升到 beta.20，后端 exe 还是 beta.19）。版本对不上只是打包没同步，
          // 功能本身是好的，降级成告警，别再拿它当启动失败的理由。
          const backendVersion = String(payload?.version || '');
          if (backendVersion && backendVersion !== appVersion) {
            // 只报一次：这个函数会被状态查询反复调用，每次都打会把日志刷满
            if (!backendVersionMismatch) {
              console.warn(`[Backend] ⚠ 后端版本 ${backendVersion} 与应用版本 ${appVersion} 不一致，继续启动`);
              updateSplashStatus('服务已就绪', `后端 ${backendVersion} · 应用 ${appVersion}`);
            }
            backendVersionMismatch = { backend: backendVersion, app: appVersion };
          }
          return { success: true, versionMismatch: backendVersionMismatch };
        }
      }
    } catch (error) {
    } finally {
      clearTimeout(requestTimer);
    }

    // 每 5 秒往启动窗报一次已经等了多久，用户能看出程序在动，不是死了
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    if (typeof onProgress === 'function' && elapsed - lastNotifiedSecond >= 5) {
      lastNotifiedSecond = elapsed;
      try { onProgress(elapsed); } catch (_error) { /* 进度只是提示，别影响探测 */ }
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return {
    success: false,
    error: `启动超时（已等 ${Math.round((Date.now() - startedAt) / 1000)} 秒）`
  };
}

async function ensureBackendStarted() {
  if (backendProcess) {
    const result = await waitForBackendHealth();
    if (result.success) await hydrateBackendAISecrets();
    return result;
  }

  if (backendStartupPromise) {
    return await backendStartupPromise;
  }

  backendStartupPromise = startBackend()
    .then(async (result) => {
      if (result.success) await hydrateBackendAISecrets();
      return result;
    })
    .finally(() => {
      if (!backendProcess) {
        backendStartupPromise = null;
      }
    });

  return await backendStartupPromise;
}

function getBuildStamp() {
  // package.json 的 version 一直停在 beta.19（按你的要求没动版本号），
  // 所以界面上看不出装的是哪一次打包。buildStamp 每次打包时改，
  // 用来分辨「到底装没装上新包」。
  try {
    return String(require('./package.json').build?.buildStamp || '');
  } catch (_error) {
    return '';
  }
}

function getRuntimeConfig() {
  return {
    port: backendPort,
    buildStamp: getBuildStamp(),
    apiBase: backendOrigin,
    apiV1Base: apiBaseUrl,
    wsBase: backendWsOrigin,
    // 渲染层用它给每个 /api/v1/* 请求加 X-EchoMind-Token 头。
    // 走 preload 的 contextBridge，页面脚本能拿到，外部 iframe 拿不到。
    apiToken: backendApiToken
  };
}

async function parseBackendError(response) {
  const contentType = response.headers.get('content-type') || '';

  try {
    if (contentType.includes('application/json')) {
      const data = await response.json();
      const detailError = data?.detail && typeof data.detail === 'object' ? data.detail : null;
      const structuredError = data?.error && typeof data.error === 'object'
        ? data.error
        : (detailError || data);
      const message = typeof data.detail === 'string'
        ? data.detail
        : (typeof data.error === 'string'
          ? data.error
          : (structuredError?.message || `HTTP ${response.status}`));
      return {
        code: structuredError?.code || data.code || `HTTP_${response.status}`,
        message,
        retryable: Boolean(
          structuredError?.retryable
          ?? [408, 425, 429, 502, 503, 504].includes(response.status)
        ),
        details: structuredError?.details && typeof structuredError.details === 'object'
          ? structuredError.details
          : {},
        status: response.status
      };
    }

    const text = await response.text();
    return {
      code: `HTTP_${response.status}`,
      message: text || `HTTP ${response.status}`,
      retryable: [408, 425, 429, 502, 503, 504].includes(response.status),
      details: text ? { response: text } : {},
      status: response.status
    };
  } catch (error) {
    return {
      code: `HTTP_${response.status}`,
      message: `HTTP ${response.status}`,
      retryable: [408, 425, 429, 502, 503, 504].includes(response.status),
      details: {},
      status: response.status
    };
  }
}

async function throwBackendResponseError(response) {
  const parsed = await parseBackendError(response);
  const error = new Error(parsed.message);
  error.code = parsed.code;
  error.retryable = parsed.retryable;
  error.details = parsed.details;
  error.detail = parsed.details;
  error.status = parsed.status;
  throw error;
}

async function requestBackendJson(url, options = {}) {
  // 后端在跑全量索引时可能长时间不响应；没有超时会让界面永远停在"保存中…"
  const timeoutMs = Number(options.timeoutMs || 60000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // 走 IPC 代理的每一个后端请求都得带令牌。
  // 老的后端 exe 没有这道闸门，所以一直没人发现这里漏了；换成 beta.20 之后
  // 界面上一片 401（列表、波形、标签全拿不到），才暴露出来。
  const authHeaders = backendApiToken ? { 'X-EchoMind-Token': backendApiToken } : {};
  const mergedHeaders = { ...authHeaders, ...(options.headers || {}) };
  let response;
  try {
    response = await fetch(url, { ...options, headers: mergedHeaders, signal: options.signal || controller.signal });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const timeoutError = new Error('后端无响应（可能正在索引），请稍后重试');
      timeoutError.code = 'BACKEND_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    await throwBackendResponseError(response);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return await response.json();
  }

  return { success: true, data: await response.text() };
}

function cloneConfig(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function stripRendererSecretFields(providerConfig) {
  const sanitized = cloneConfig(providerConfig);
  delete sanitized.api_key;
  delete sanitized.has_api_key;
  delete sanitized.secret_action;
  return sanitized;
}

function normalizeSecretUpdate(value) {
  const action = value?.action || 'keep';
  if (!['keep', 'set', 'clear'].includes(action)) {
    const error = new Error('无效的密钥更新操作');
    error.code = 'INVALID_SECRET_ACTION';
    throw error;
  }
  if (action === 'set') {
    if (typeof value?.value !== 'string' || value.value.trim().length === 0) {
      const error = new Error('新密钥不能为空');
      error.code = 'INVALID_SECRET';
      throw error;
    }
    return { action, value: value.value.trim() };
  }
  return { action, value: null };
}

function resolveSecretForRequest(scope, provider, update) {
  const key = secretKeyFor(scope, provider);
  const normalized = normalizeSecretUpdate(update);
  if (normalized.action === 'set') {
    return { key, ...normalized, resolved: normalized.value };
  }
  if (normalized.action === 'clear') {
    return { key, ...normalized, resolved: '' };
  }
  // 若存储里有密钥但当前解不开（例如钥匙串短暂不可用），decryptStoredSecret
  // 会返回 null；这里不再直接抛错，否则一次保存失败会连带把后续设置卡死。
  // keep 意图：仅当本地安全存储确有密钥时才回填；否则省略 api_key 字段，
  // 让后端保留其内存配置（例如 .env.ark 注入的密钥），避免空串误清密钥。
  const stored = decryptStoredSecret(key);
  return { key, ...normalized, resolved: stored || undefined };
}

function prepareAIConfigRequest(payload = {}) {
  const llmProvider = String(payload.llm_provider || '');
  const embeddingProvider = String(payload.embedding_provider || '');
  // Deriving the key also validates provider identifiers before any store or
  // backend operation occurs.
  const llmSecret = resolveSecretForRequest('llm', llmProvider, payload.llm_secret);
  const embeddingSecret = resolveSecretForRequest(
    'embedding', embeddingProvider, payload.embedding_secret
  );
  const llmConfig = stripRendererSecretFields(payload.llm_config);
  const embeddingConfig = stripRendererSecretFields(payload.embedding_config);
  llmConfig.api_key = llmSecret.resolved;
  embeddingConfig.api_key = embeddingSecret.resolved;
  return {
    body: {
      llm_provider: llmProvider,
      llm_config: llmConfig,
      embedding_provider: embeddingProvider,
      embedding_config: embeddingConfig
    },
    updates: [llmSecret, embeddingSecret]
  };
}

function overlaySecureSecretStatus(responseData) {
  const result = cloneConfig(responseData);
  const groups = [
    ['llm', result?.llm?.config],
    ['embedding', result?.embedding?.config]
  ];
  for (const [scope, configs] of groups) {
    if (!configs || typeof configs !== 'object') continue;
    for (const [provider, providerConfig] of Object.entries(configs)) {
      if (!providerConfig || typeof providerConfig !== 'object' || Array.isArray(providerConfig)) continue;
      delete providerConfig.api_key;
      try {
        providerConfig.has_api_key = hasEncryptedSecret(secretKeyFor(scope, provider));
      } catch (_) {
        providerConfig.has_api_key = false;
      }
    }
  }
  result.secure_storage = getSafeStorageStatus();
  return result;
}

function snapshotSecretStore() {
  return { ...readSecureSecrets() };
}

function restoreSecretStore(snapshot) {
  writeSecureSecrets({ ...(snapshot || {}) });
}

function applyPersistentSecretUpdates(updates) {
  for (const update of updates) {
    if (update.action === 'set') {
      setStoredSecret(update.key, update.value);
    } else if (update.action === 'clear') {
      deleteStoredSecret(update.key);
    }
  }
}

async function hydrateBackendAISecrets() {
  if (backendSecretsHydrated) return;
  // 安全存储不可用时，只要本地还有密钥（plain: 回退格式）就继续回填，
  // 否则用户每次重启都要重新填一次 API Key。
  if (!isSecureStorageAvailable() && Object.keys(readSecureSecrets()).length === 0) {
    console.warn('[Secrets] Backend credential hydration skipped: no stored credentials');
    return;
  }
  try {
    const current = await requestBackendJson(`${apiBaseUrl}/ai/config`);
    const llmProvider = current?.llm?.provider;
    const embeddingProvider = current?.embedding?.provider;
    if (!llmProvider || !embeddingProvider) return;
    const prepared = prepareAIConfigRequest({
      llm_provider: llmProvider,
      llm_config: current?.llm?.config?.[llmProvider] || {},
      llm_secret: { action: 'keep' },
      embedding_provider: embeddingProvider,
      embedding_config: current?.embedding?.config?.[embeddingProvider] || {},
      embedding_secret: { action: 'keep' }
    });
    await requestBackendJson(`${apiBaseUrl}/ai/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prepared.body)
    });
    backendSecretsHydrated = true;
    console.log('[Secrets] Backend runtime credentials hydrated');
  } catch (error) {
    console.warn('[Secrets] Backend credential hydration failed:', error?.code || error?.message);
  }
}

function requireProjectId(value) {
  const projectId = typeof value === 'string' ? value.trim() : '';
  if (!projectId) {
    const error = new Error('projectId is required');
    error.code = 'PROJECT_ID_REQUIRED';
    throw error;
  }
  return projectId;
}

function createBackendRequest(action, data = {}) {
  const filePath = typeof data === 'string' ? data : (data.filePath || data.path || '');
  const encodedPath = encodeURIComponent(filePath);

  switch (action) {
    case 'health':
      return { url: `${apiBaseUrl}/health` };
    case 'scan-only':
      return {
        url: `${apiBaseUrl}/scan-only`,
        options: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            folder_path: data.folderPath,
            recursive: data.recursive ?? true
          })
        }
      };
    case 'import-async':
      return {
        url: `${apiBaseUrl}/projects/${encodeURIComponent(requireProjectId(data.projectId))}/imports`,
        options: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            folder_path: data.folderPath,
            recursive: data.recursive ?? true,
            client_id: data.clientId || 'default',
            skip_existing: Boolean(data.skipExisting)
          })
        }
      };
    case 'import-files':
      return {
        url: `${apiBaseUrl}/projects/${encodeURIComponent(requireProjectId(data.projectId))}/imports`,
        options: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file_paths: Array.isArray(data.filePaths) ? data.filePaths : [],
            client_id: data.clientId || 'default'
          })
        }
      };
    case 'search':
      return {
        url: `${apiBaseUrl}/search`,
        options: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: data.query,
            top_k: data.topK,
            threshold: data.threshold,
            page: data.page || 1,
            page_size: data.page_size || 50,
            project_id: requireProjectId(data.projectId)
          })
        }
      };
    case 'index-status':
      return { url: `${apiBaseUrl}/index/status` };
    case 'indexed-files':
      return { url: `${apiBaseUrl}/files` };
    case 'db-files':
      return { url: `${apiBaseUrl}/db/files` };
    case 'db-file':
      return { url: `${apiBaseUrl}/db/file/${encodedPath}` };
    case 'db-file-tags':
      return {
        url: `${apiBaseUrl}/db/file/${encodeURIComponent(data.path)}/tags`,
        options: {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tags: data.tags || [],
            // 自定义标签（左侧「我的标签」那套）：后端按路径反查 uuid 写 tags/file_tags
            custom: Array.isArray(data.custom) ? data.custom : [],
            // scene（场景，互斥）/ attr（属性，可多选）。默认 attr。
            custom_layer: data.customLayer === 'scene' ? 'scene' : 'attr'
          })
        }
      };
    case 'db-tags':
      return { url: `${apiBaseUrl}/db/tags` };
    case 'db-tags-batch':
      return {
        url: `${apiBaseUrl}/db/tags/batch`,
        options: {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: data.paths || [], tags: data.tags || [] })
        }
      };
    case 'db-tag-rename':
      return {
        url: `${apiBaseUrl}/db/tags`,
        options: {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ old: data.old, new: data.new })
        }
      };
    case 'db-tag-delete':
      return {
        url: `${apiBaseUrl}/db/tags/${encodeURIComponent(data)}`,
        options: { method: 'DELETE' }
      };
    case 'db-file-reanalyze':
      return {
        url: `${apiBaseUrl}/db/file/${encodedPath}/reanalyze`,
        options: { method: 'POST' }
      };
    case 'db-file-delete':
      return {
        url: `${apiBaseUrl}/db/file/${encodedPath}`,
        options: { method: 'DELETE' }
      };
    case 'db-stats':
      return { url: `${apiBaseUrl}/db/stats` };
    case 'audio-url':
      return { localOnly: true, result: { success: true, url: `${apiBaseUrl}/audio/${encodedPath}` } };
    case 'waveform':
      return { url: `${backendOrigin}/api/waveform?path=${encodedPath}` };
    case 'waveform-by-id':
      return {
        url: `${apiBaseUrl}/files/${encodeURIComponent(data.fileId)}/waveform?project_id=${encodeURIComponent(data.projectId || 'default')}`
      };
    case 'waveforms-batch':
      return {
        url: `${apiBaseUrl}/waveforms/batch`,
        options: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file_ids: Array.isArray(data.fileIds) ? data.fileIds : [],
            project_id: data.projectId || 'default'
          })
        }
      };
    case 'export-clip':
      return {
        url: `${backendOrigin}/api/export/clip`,
        options: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: data.filePath,
            start: data.start,
            end: data.end,
            temp_file: data.tempFile
          })
        }
      };
    case 'audio-fade':
      return {
        url: `${backendOrigin}/api/audio/fade`,
        options: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: data.filePath,
            fade_in: data.fadeIn,
            fade_out: data.fadeOut
          })
        }
      };
    case 'get-temp-dir':
      return { url: `${apiBaseUrl}/config/temp-dir` };
    case 'set-temp-dir':
      return {
        url: `${apiBaseUrl}/config/temp-dir`,
        options: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ temp_dir: data.tempDir })
        }
      };
    case 'disk-space':
      return { url: `${apiBaseUrl}/disk-space` };
    case 'clear-temp-clips':
      return {
        url: `${apiBaseUrl}/temp-clips/clear`,
        options: { method: 'POST' }
      };
    default:
      return null;
  }
}

/**
 * 停止后端服务
 */
async function stopBackend() {
  for (const controller of activeBackendRequests.values()) controller.abort();
  activeBackendRequests.clear();
  if (!backendProcess) {
    return { success: true };
  }

  console.log('[Backend] Stopping backend service');

  return new Promise((resolve) => {
    // 发送 SIGTERM
    if (process.platform === 'win32') {
      backendProcess.kill();
    } else {
      backendProcess.kill('SIGTERM');
    }

    // 等待进程退出
    const timeout = setTimeout(() => {
      console.warn('[Backend] Force killing backend process');
      backendProcess.kill('SIGKILL');
      backendProcess = null;
      resolve({ success: true });
    }, 5000);

    backendProcess.on('exit', () => {
      clearTimeout(timeout);
      backendProcess = null;
      resolve({ success: true });
    });
  });
}

// ==================== 窗口管理 ====================

// 后端接口令牌：除了渲染层自己在请求头里带一份，这里再兜一层。
// 页面里有些请求根本不经过 api.js —— 启动阶段那几个预热请求、
// 以及 <audio>/<img> 这类由浏览器直接发的资源请求，都没法自己加头；
// 换成带令牌闸门的 beta.20 后端之后，它们就是一片 401（日志实测四条：
// broken-files / effect-presets / assistant-events / favorites）。
// 在主进程的会话层统一补头，只补 127.0.0.1 和 localhost 的 /api/ 请求，令牌不外泄。
let backendAuthHeaderInstalled = false;
function installBackendAuthHeader() {
  if (backendAuthHeaderInstalled) return;
  try {
    const { session } = require('electron');
    // 过滤交给回调里的正则判断：URL 匹配模式对端口不敏感，写 127.0.0.1 带不带端口都容易漏，
    // 用 <all_urls> 全量过一遍回调，只对回环地址的 /api/ 请求补头。
    const filter = { urls: ['<all_urls>'] };
    session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      const requestHeaders = { ...(details.requestHeaders || {}) };
      const isApi = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/api\//i.test(details.url || '');
      if (isApi && backendApiToken) {
        requestHeaders['X-EchoMind-Token'] = backendApiToken;
      }
      callback({ requestHeaders });
    });
    backendAuthHeaderInstalled = true;
  } catch (error) {
    console.warn('[Backend] 安装令牌注入头失败:', error?.message || error);
  }
}

function applyCSP(win) {
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          // script-src 去掉 unsafe-inline：index.html 里已经没有内联脚本了
          // （11-04 把 4301 行内联 JS 拆成 app-core/app-ui/app-data 三个文件），
          // 保留 unsafe-inline 等于把 XSS 的最后一道网也撤了。
          "script-src 'self'; " +
          // style-src 还得留 unsafe-inline：界面里有 250+ 个内联 style 属性
          // （动态主题色、面板宽度都靠它），改成 nonce 要动整站渲染，另开一次做。
          "style-src 'self' 'unsafe-inline'; " +
          "font-src 'self'; " +
          "img-src 'self' data: blob:; " +
          `media-src 'self' blob: soundmind-audio: ${backendOrigin}; ` +
          `connect-src 'self' blob: ${backendOrigin} ${backendWsOrigin} ` +
          "https://api.openai.com https://api.moonshot.cn https://api.anthropic.com " +
          "https://api.deepseek.com https://api.siliconflow.cn " +
          "https://generativelanguage.googleapis.com; " +
          // 下面三条是纵深：禁插件、禁 <base> 劫持、禁被 iframe 嵌套。
          "object-src 'none'; " +
          "base-uri 'none'; " +
          "frame-src 'none'; " +
          "frame-ancestors 'none'; " +
          "form-action 'self';"
        ]
      }
    });
  });
}

function readSavedWindowBounds() {
  try {
    const file = path.join(app.getPath('userData'), 'window-bounds.json');
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data.width !== 'number' || typeof data.height !== 'number') return null;
    return data;
  } catch (error) {
    console.warn('[Window] 读取窗口尺寸失败:', error?.message);
    return null;
  }
}

// 拖拽窗口时 resize/move 每秒能触发上百次，每次同步写盘会把主进程拖住。
// 改成 400ms 防抖：只在停下来之后落一次盘；窗口关闭时走 flush 立刻写。
let windowBoundsTimer = null;
let windowBoundsPending = null;

function writeWindowBoundsNow() {
  if (!windowBoundsPending) return;
  const bounds = windowBoundsPending;
  windowBoundsPending = null;
  try {
    const file = path.join(app.getPath('userData'), 'window-bounds.json');
    fs.writeFileSync(file, JSON.stringify(bounds), 'utf8');
  } catch (error) {
    console.warn('[Window] 保存窗口尺寸失败:', error?.message);
  }
}

function saveWindowBounds(win, { immediate = false } = {}) {
  try {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
    windowBoundsPending = win.getBounds();
    if (immediate) {
      if (windowBoundsTimer) { clearTimeout(windowBoundsTimer); windowBoundsTimer = null; }
      writeWindowBoundsNow();
      return;
    }
    if (windowBoundsTimer) clearTimeout(windowBoundsTimer);
    windowBoundsTimer = setTimeout(() => {
      windowBoundsTimer = null;
      writeWindowBoundsNow();
    }, 400);
  } catch (error) {
    console.warn('[Window] 保存窗口尺寸失败:', error?.message);
  }
}

function resolveWindowBounds() {
  const saved = readSavedWindowBounds();
  const { screen } = require('electron');
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  // 首次启动：占屏幕 92%，但不超过 1720 宽；导航栏能一行放下
  const preferredWidth = Math.min(1720, Math.round(workArea.width * 0.92));
  const preferredHeight = Math.min(1040, Math.round(workArea.height * 0.92));
  if (saved) {
    const width = Math.min(Math.max(saved.width, 1280), workArea.width);
    const height = Math.min(Math.max(saved.height, 760), workArea.height);
    const x = typeof saved.x === 'number' ? Math.min(Math.max(saved.x, 0), Math.max(0, workArea.width - width)) : undefined;
    const y = typeof saved.y === 'number' ? Math.min(Math.max(saved.y, 0), Math.max(0, workArea.height - height)) : undefined;
    return { width, height, x, y };
  }
  return { width: Math.max(1280, preferredWidth), height: Math.max(760, preferredHeight) };
}


// ---- 本地语音服务（Breeze TTS 2 / GGUF） ----
// 需要用户把 breeze-server.exe 与 GGUF 放到指定位置；找不到就静默跳过，
// EchoMind 的语音层会自动回退到豆包或提示未配置。
// 在目录里找一个文件：先试确切名字，再扫一层子目录，最后按扩展名兜底。
function _findInDir(base, names, depth = 2) {
  if (!base || !fs.existsSync(base)) return null;
  for (const name of names) {
    const direct = path.join(base, name);
    if (fs.existsSync(direct)) return direct;
  }
  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      const child = path.join(base, entry.name);
      if (entry.isDirectory() && depth > 0) {
        const found = _findInDir(child, names, depth - 1);
        if (found) return found;
      }
    }
  } catch (_) { /* 目录不可读就跳过 */ }
  return null;
}

function resolveBreezePaths() {
  // 打包版把 breeze-server 和 GGUF 一起放在 resources\breeze 下，
  // 这样装完就有声音，不用用户自己摆文件。其它路径保留给老用户。
  const os = require('os');
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'breeze') : null,
    path.join(app.getPath('exe'), '..', 'breeze'),
    path.join(getUserDataDir(), 'breeze'),
    'E:\\AI音效管理器\\breeze',
  ].filter(Boolean);

  const modelNames = ['breeze-tts-2-q8_0.gguf', 'breeze-tts-2.gguf'];
  for (const base of candidates) {
    const exe = _findInDir(base, ['breeze-server.exe'], 2);
    if (!exe) continue;
    const model =
      _findInDir(path.join(base, 'weights'), modelNames, 1) ||
      _findInDir(path.join(base, 'breeze-weights'), modelNames, 1) ||
      _findInDir(base, modelNames, 2) ||
      _findInDir(path.join(os.homedir(), 'breeze-weights'), modelNames, 1);
    if (!model) continue;
    return { exe, model, cwd: path.dirname(exe) };
  }
  return null;
}

async function ensureBreezeServer() {
  try {
    const probe = await fetch('http://127.0.0.1:8080/health').catch(() => null);
    if (probe && probe.ok) return;
    const paths = resolveBreezePaths();
    if (!paths) return;
    const { spawn } = require('child_process');
    const child = spawn(paths.exe, [paths.model, '--port', '8080', '--host', '127.0.0.1'], {
      cwd: paths.cwd, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    console.log('[TTS] 已拉起本地 Breeze 语音服务');
  } catch (error) {
    console.warn('[TTS] 启动本地语音服务失败:', error?.message || error);
  }
}
function createWindow() {
  rendererBridgeReady = false;
  rendererPreloadFailure = null;
  const initialBounds = resolveWindowBounds();
  mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: Math.min(1280, require('electron').screen.getPrimaryDisplay().workAreaSize.width),
    minHeight: 720,
    title: '回声 - AI 音效管理器',
    icon: path.join(__dirname, 'assets', 'audio-icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
      allowRunningInsecureContent: false
    },
    titleBarStyle: 'default',
    show: false,
    backgroundColor: '#0a0a0a'
  });

  // A preload failure removes every desktop API from the renderer while the
  // HTML can still look healthy. Capture it explicitly instead of allowing a
  // browser-only fallback to masquerade as a working installed application.
  mainWindow.on('resize', () => saveWindowBounds(mainWindow));
  mainWindow.on('move', () => saveWindowBounds(mainWindow));
  // 关闭时立刻落盘，别让防抖把最后一次尺寸丢掉
  mainWindow.on('close', () => saveWindowBounds(mainWindow, { immediate: true }));

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    rendererPreloadFailure = {
      preloadPath,
      message: error?.message || 'Unknown preload error'
    };
    console.error('[Renderer] Preload failed:', preloadPath, error);
  });
  mainWindow.webContents.on('ipc-message', (_event, channel, payload) => {
    if (channel === 'renderer-bridge-ready' && payload?.version === 1) {
      rendererBridgeReady = true;
    }
  });

  // 导航与开窗拦截：以前只有启动窗装了，主窗口和浮窗都没装。
  // 不装的后果是把一个网址拖进界面就可能把主窗口整个导航走，
  // 或者 target=_blank 开出一个没有 preload 的裸窗（那窗里 nodeIntegration 依然是关的，
  // 但它是个完全不受管的浏览器，等于给攻击者一块干净的画布）。
  // 规则：只允许留在本地 file:// 页面内，其它一律拦下；外链交给系统浏览器。
  const isLocalAppUrl = (targetUrl) => {
    const value = String(targetUrl || '');
    if (!value) return false;
    if (!value.startsWith('file://')) return false;
    try {
      const decoded = decodeURIComponent(value.replace(/^file:\/\//, ''));
      return path.resolve(decoded).startsWith(path.resolve(__dirname));
    } catch (_error) {
      return false;
    }
  };
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (isLocalAppUrl(targetUrl)) return;
    event.preventDefault();
    console.warn('[Window] 拦截导航: ' + String(targetUrl).slice(0, 120));
    try {
      if (/^https?:/i.test(targetUrl)) shell.openExternal(targetUrl);
    } catch (_error) { /* 打不开就算了，至少没导航走 */ }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      try { shell.openExternal(url); } catch (_error) { /* ignore */ }
    }
    return { action: 'deny' };
  });
  // 禁止 webview 与外部协议跳转
  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  // 设置 CSP
  applyCSP(mainWindow);

  // 加载页面
  const indexPath = path.join(__dirname, 'index.html');
  mainWindow.loadFile(indexPath);

  // 窗口关闭处理
  // 关闭按钮行为：托盘 / 任务栏 / 退出（可在设置里切换）
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    const { closeBehavior } = readWindowPrefs();
    if (closeBehavior === 'quit') return;
    event.preventDefault();
    if (closeBehavior === 'tray') {
      try {
        ensureTray();
        mainWindow.hide();
        return;
      } catch (error) {
        // 托盘创建失败（例如图标缺失）时退回最小化，避免窗口"消失且找不回"
        console.warn('[Window] 托盘不可用，改为最小化:', error.message);
      }
    }
    mainWindow.minimize();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  createMenu();
  if (!ipcHandlersInitialized) {
    setupIpcHandlers();
    ipcHandlersInitialized = true;
  }
}

function createMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '导入文件夹',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            mainWindow.webContents.send('menu-import-folder');
          }
        },
        { type: 'separator' },
        {
          label: '退出',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
          click: () => {
            app.quit();
          }
        }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具', accelerator: 'F12' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

let nativeOpenDialogStartedAt = 0;
const NATIVE_DIALOG_STALE_MS = 30000;

async function showOwnedOpenDialog(event, options = {}) {
  // 防重入的锁加了超时：对话框如果因为异常没返回，锁会永久卡住，
  // 之后所有「选文件夹」都被静默拒绝（11-05 实测：点按钮没任何反应）。
  // 超过 30 秒视为上一次已经死了，允许重新打开。
  if (nativeOpenDialogActive) {
    const stuckMs = Date.now() - nativeOpenDialogStartedAt;
    if (stuckMs < NATIVE_DIALOG_STALE_MS) {
      const error = new Error('已有文件选择窗口正在打开');
      error.code = 'DIALOG_BUSY';
      throw error;
    }
    console.warn('[Dialog] 上一次文件选择卡了 ' + Math.round(stuckMs / 1000) + ' 秒，强制重置');
    nativeOpenDialogActive = false;
  }

  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!owner || owner.isDestroyed()) {
    const error = new Error('主窗口当前不可用');
    error.code = 'WINDOW_UNAVAILABLE';
    throw error;
  }

  nativeOpenDialogActive = true;
  nativeOpenDialogStartedAt = Date.now();
  try {
    if (owner.isMinimized()) owner.restore();
    if (!owner.isVisible()) owner.show();
    owner.focus();
    // Electron 45 下 dialog 偶尔会卡在 owner 未就绪的状态，加个兜底：
    // 先试带 owner 的调用，抛错再退回不带 owner 的。
    try {
      return await dialog.showOpenDialog(owner, options);
    } catch (firstError) {
      console.warn('[Dialog] 带窗口调用失败，退回无窗口模式:', firstError && firstError.message);
      return await dialog.showOpenDialog(options);
    }
  } finally {
    nativeOpenDialogActive = false;
    nativeOpenDialogStartedAt = 0;
    if (!owner.isDestroyed()) owner.focus();
  }
}

// ==================== IPC 处理 ====================

function setupIpcHandlers() {
  // ---- 全局搜索 ----
  ipcMain.handle('global-search:get-state', () => globalSearch.getState());
  ipcMain.handle('global-search:set-accelerator', (event, accelerator) =>
    globalSearch.applyAccelerator(accelerator));
  ipcMain.handle('global-search:reset-accelerator', () => globalSearch.resetAccelerator());
  ipcMain.handle('global-search:show', () => { globalSearch.showSearchWindow(); return true; });
  ipcMain.handle('global-search:hide', () => { globalSearch.hideSearchWindow(); return true; });

  // 小窗里 Ctrl+Enter：把音效交给主窗口选中并显示
  ipcMain.handle('global-search:open-in-main', (event, payload) => {
    const filePath = String(payload?.filePath || '');
    const fileId = String(payload?.fileId || '');
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    globalSearch.withBlurSuppressed(() => {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('global-search:select-file', { filePath, fileId });
    });
    return { ok: true };
  });

  ipcMain.on('global-search:popup-ready', () => {
    // 小窗加载完成 —— 目前只用于确认通道通了，热键已经注册过了
  });

  // 独立浮动面板窗口（可拖到任意屏幕）
  ipcMain.handle('float-panel-open', (event, payload) => {
    const { id, title, rect } = payload || {};
    if (!id || floatWindows[id]) return false;
    const [wx, wy] = mainWindow ? mainWindow.getPosition() : [0, 0];
    const x = Math.max(0, Math.round(wx + (rect?.left || 40)));
    const y = Math.max(0, Math.round(wy + (rect?.top || 40)));
    const win = new BrowserWindow({
      width: 560,
      height: 440,
      x,
      y,
      minWidth: 280,
      minHeight: 180,
      frame: false,
      title: title || '回声',
      backgroundColor: '#0a0a0a',
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: path.join(__dirname, 'preload.js'),
        webSecurity: true,
        allowRunningInsecureContent: false
      }
    });
    applyCSP(win);
    win.loadFile(path.join(__dirname, 'index.html'), { query: { float: id } });
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => { delete floatWindows[id]; });
    floatWindows[id] = win;
    // 通知主窗口：浮窗已打开，请把当前选中的音效推给浮窗
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('float-request-current-sound', id);
    }
    return true;
  });

  // 主窗口广播当前音效 → 转发给所有独立浮窗
  ipcMain.handle('float-panel-broadcast-sound', (event, payload) => {
    for (const win of Object.values(floatWindows)) {
      if (!win.isDestroyed()) win.webContents.send('float-sound-changed', payload);
    }
    return true;
  });

  ipcMain.handle('float-panel-close', (event, id) => {
    const win = floatWindows[id];
    if (win) win.close();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('float-panel-docked', id);
    return true;
  });

  ipcMain.handle('float-panel-dock', (event, id) => {
    const win = floatWindows[id];
    if (win) win.close();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('float-panel-docked', id);
    return true;
  });

  ipcMain.handle('audio-capabilities', () => ({
    version: audioCapabilityManifest.version || 1,
    formats: audioCapabilityManifest.formats || {},
    extensions: [...supportedAudioExtensions]
  }));

  // 窗口控制
  ipcMain.handle('window-control', (event, action) => {
    if (!mainWindow) return;

    switch (action) {
      case 'minimize':
        mainWindow.minimize();
        break;
      case 'maximize':
        if (mainWindow.isMaximized()) {
          mainWindow.unmaximize();
        } else {
          mainWindow.maximize();
        }
        break;
      case 'close':
        mainWindow.close();
        break;
      case 'isMaximized':
        return mainWindow.isMaximized();
    }
  });

  // 文件对话框
  ipcMain.handle('dialog-open', async (event, options) => {
    return await showOwnedOpenDialog(event, options);
  });

  ipcMain.handle('file-write-text', async (event, payload = {}) => {
    try {
        const filePath = String(payload.filePath || '');
        if (!filePath) return { success: false, error: '缺少文件路径' };
        // 只允许写素材库以内：渲染层被注入时不能借这里写启动项或系统目录
        let safePath;
        try {
            safePath = assertInsideRoots(filePath, await getLibraryRoots());
        } catch (boundaryError) {
            console.warn('[fs-guard] file-write-text 拒绝: ' + boundaryError.message);
            return { success: false, error: boundaryError.message, code: boundaryError.code };
        }
        await fs.promises.writeFile(safePath, String(payload.content ?? ''), 'utf8');
        return { success: true, path: safePath };
    } catch (error) {
        return { success: false, error: error?.message || String(error) };
    }
});

ipcMain.handle('dialog-save', async (event, options) => {
    return await dialog.showSaveDialog(mainWindow, options);
  });

  ipcMain.handle('dialog-message', async (event, options) => {
    return await dialog.showMessageBox(mainWindow, options);
  });

  // 后端 API 代理
  ipcMain.handle('backend-api', async (event, action, data) => {
    let requestConfig = null;
    let requestKey = null;
    let requestController = null;
    try {
      if (action === 'start-server') {
        const result = await ensureBackendStarted();
        return result?.success === false
          ? toBackendError(new Error(result.error || '后端启动失败'), { action, code: 'BACKEND_START_FAILED' })
          : result;
      }

      if (action === 'stop-server') {
        return await stopBackend();
      }

      if (action === 'runtime-config') {
        return getRuntimeConfig();
      }

      const startupResult = await ensureBackendStarted();
      if (!startupResult.success) {
        return toBackendError(new Error(startupResult.error || '后端未就绪'), {
          action,
          code: 'BACKEND_NOT_READY'
        });
      }

      requestConfig = createBackendRequest(action, data);
      if (!requestConfig) {
        return toBackendError(new Error(`未知操作: ${action}`), {
          action,
          code: 'UNKNOWN_BACKEND_ACTION'
        });
      }

      if (requestConfig.localOnly) {
        return requestConfig.result;
      }

      const requestId = data && typeof data === 'object'
        ? String(data.requestId || '').trim()
        : '';
      if (requestId) {
        requestKey = `${event.sender.id}:${requestId}`;
        const previous = activeBackendRequests.get(requestKey);
        if (previous) previous.abort();
        requestController = new AbortController();
        activeBackendRequests.set(requestKey, requestController);
        requestConfig.options = {
          ...(requestConfig.options || {}),
          signal: requestController.signal
        };
      }

      return await requestBackendJson(requestConfig.url, requestConfig.options);
    } catch (error) {
      if (error?.name === 'AbortError') {
        const cancelledError = new Error('请求已取消');
        cancelledError.code = 'REQUEST_CANCELLED';
        cancelledError.retryable = true;
        cancelledError.details = { cancelled: true };
        return toBackendError(cancelledError, {
          action,
          url: requestConfig?.url || null
        });
      }
      console.error('[IPC] Backend API error:', error);
      return toBackendError(error, { action, url: requestConfig?.url || null });
    } finally {
      if (requestKey && activeBackendRequests.get(requestKey) === requestController) {
        activeBackendRequests.delete(requestKey);
      }
    }
  });

  ipcMain.handle('backend-api-cancel', (event, requestId) => {
    const normalized = String(requestId || '').trim();
    if (!normalized) return { success: false, cancelled: false };
    const requestKey = `${event.sender.id}:${normalized}`;
    const controller = activeBackendRequests.get(requestKey);
    if (!controller) return { success: true, cancelled: false };
    controller.abort();
    activeBackendRequests.delete(requestKey);
    return { success: true, cancelled: true };
  });

  // Credential-aware AI config proxy.  Plaintext keys never cross back from
  // the Electron main process into the renderer and are never persisted by
  // the Python backend.
  ipcMain.handle('ai-config', async (event, action, payload = {}) => {
    try {
      const startupResult = await ensureBackendStarted();
      if (!startupResult.success) {
        return {
          success: false,
          code: 'BACKEND_NOT_READY',
          error: startupResult.error || '后端未就绪'
        };
      }

      if (action === 'get') {
        const result = await requestBackendJson(`${apiBaseUrl}/ai/config`);
        return overlaySecureSecretStatus(result);
      }

      if (!['save', 'test'].includes(action)) {
        return { success: false, code: 'UNKNOWN_AI_CONFIG_ACTION', error: '未知 AI 配置操作' };
      }

      const prepared = prepareAIConfigRequest(payload);
      const snapshot = action === 'save' ? snapshotSecretStore() : null;
      try {
        if (action === 'save') {
          // Persist first, then roll back if the metadata/backend update fails.
          // This makes the secure store and runtime configuration one logical
          // transaction from the renderer's perspective.
          applyPersistentSecretUpdates(prepared.updates);
        }
        const result = await requestBackendJson(
          `${apiBaseUrl}/ai/config${action === 'test' ? '/test' : ''}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(prepared.body)
          }
        );
        if (action === 'save') backendSecretsHydrated = true;
        return result;
      } catch (error) {
        if (action === 'save') {
          try {
            restoreSecretStore(snapshot);
          } catch (_) {
          }
        }
        throw error;
      }
    } catch (error) {
      console.error('[AI Config] Secure proxy request failed:', error?.code || error?.message);
      return {
        success: false,
        code: error?.code || 'AI_CONFIG_FAILED',
        error: error?.message || 'AI 配置请求失败',
        status: Number.isInteger(error?.status) ? error.status : null
      };
    }
  });

  // 音频生成配置：直接写本地文件，不依赖（可能正忙的）后端。
  // 写完后在后台重试推送给后端，让运行中的进程立刻拿到 Key。
  // 音效 key 现在存在 secure_secrets 里（DPAPI），读取时只回掩码 + 是否存在，
  // 渲染层拿不到明文。旧版的 .sfx_config.json 明文文件会在启动时迁移并删除。
  ipcMain.handle('sfx-config-get', () => {
    try {
      const file = path.join(app.getPath('appData'), 'soundbot', '.sfx_config.json');
      const saveDir = fs.existsSync(file)
        ? String((JSON.parse(fs.readFileSync(file, 'utf-8')) || {}).save_dir || '')
        : '';
      let hasKey = false;
      let tail = '';
      try {
        const key = secretKeyFor('sfx', 'default');
        hasKey = hasEncryptedSecret(key);
        if (hasKey) {
          const plain = decryptStoredSecret(key) || '';
          tail = plain ? '••••' + plain.slice(-4) : '';
        }
      } catch (_e) { hasKey = false; }
      return { success: true, has_api_key: hasKey, apiKey: '', api_key_tail: tail, saveDir };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('sfx-config-save', async (event, payload = {}) => {
    const apiKey = String(payload.apiKey || '').trim();
    const saveDir = String(payload.saveDir || '').trim();
    // 密钥进 DPAPI，明文只留在内存里传给后端；磁盘上只存加密后的串。
    // save_dir 不是机密，继续放在原文件里，保持旧版本能读。
    if (apiKey) {
      try {
        setStoredSecret(secretKeyFor('sfx', 'default'), apiKey);
      } catch (error) {
        return { success: false, error: '保存密钥失败: ' + error.message };
      }
    }
    try {
      const dir = path.join(app.getPath('appData'), 'soundbot');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, '.sfx_config.json');
      const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
      const next = { ...current };
      delete next.api_key;      // 明文 key 不留在磁盘上
      if (saveDir) next.save_dir = saveDir;
      fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf-8');
    } catch (error) {
      return { success: false, error: '写入配置文件失败: ' + error.message };
    }
    // 后台推送，失败不影响保存结果（文件已落盘，重启后一定生效）
    (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await requestBackendJson(`${apiBaseUrl}/sfx/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: apiKey, save_dir: saveDir })
          });
          console.log('[SFX] 后端已接受配置推送');
          return;
        } catch (error) {
          console.warn('[SFX] 推送配置失败(第' + (attempt + 1) + '次):', error.message);
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    })();
    return { success: true, saved: true };
  });

  // 描述包导出/导入（换机器时把一句话描述带走）
  ipcMain.handle('descriptions-export', async (event, payload = {}) => {
    try {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '导出描述包',
        defaultPath: 'EchoMind-描述包.json',
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (result.canceled || !result.filePath) return { success: false, canceled: true };
      fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 1), 'utf-8');
      return { success: true, path: result.filePath, count: payload?.count ?? 0 };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('descriptions-import', async () => {
    try {
      // 安装包里预置了描述包，直接定位到 exe 同目录，省得用户翻文件夹
      const bundled = path.join(path.dirname(app.getPath('exe')), 'EchoMind-描述包.json');
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择描述包',
        defaultPath: fs.existsSync(bundled) ? bundled : undefined,
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (result.canceled || !result.filePaths?.length) return { success: false, canceled: true };
      const raw = fs.readFileSync(result.filePaths[0], 'utf-8');
      return { success: true, path: result.filePaths[0], data: JSON.parse(raw) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // 拖拽导入：判断拖入的是文件夹还是文件
  ipcMain.handle('classify-paths', (event, paths = []) => {
    const list = Array.isArray(paths) ? paths : [];
    return list.map((item) => {
      const target = String(item || '');
      try {
        const stat = fs.statSync(target);
        return { path: target, isDirectory: stat.isDirectory(), missing: false };
      } catch (error) {
        return { path: target, isDirectory: false, missing: true };
      }
    });
  });

  ipcMain.handle('window-prefs-get', () => ({ success: true, ...readWindowPrefs() }));

  ipcMain.handle('window-prefs-set', (event, prefs = {}) => {
    const current = readWindowPrefs();
    const value = String(prefs?.closeBehavior || '');
    const next = {
      closeBehavior: ['tray', 'minimize', 'quit'].includes(value) ? value : current.closeBehavior
    };
    writeWindowPrefs(next);
    return { success: true, ...next };
  });

  ipcMain.handle('secure-secret', async (event, action, payload = {}) => {
    try {
      if (action === 'status') {
        return { success: true, ...getSafeStorageStatus() };
      }

      validateSecretKey(payload.key);
      if (!isSecureStorageAvailable()) {
        return { success: false, code: 'ENCRYPTION_UNAVAILABLE', error: '系统安全存储当前不可用' };
      }

      if (action === 'set') {
        setStoredSecret(payload.key, payload.value);
        return { success: true };
      }

      if (action === 'get' || action === 'has') {
        // Deliberately expose existence only.  Renderer code must never be
        // able to retrieve an already stored plaintext credential.
        return { success: true, exists: hasEncryptedSecret(payload.key) };
      }

      if (action === 'delete') {
        const existed = deleteStoredSecret(payload.key);
        return { success: true, existed };
      }

      return { success: false, code: 'UNKNOWN_SECRET_ACTION', error: `未知密钥操作: ${action}` };
    } catch (error) {
      console.error('[Secrets] IPC error:', error);
      return { success: false, code: 'SECRET_STORE_ERROR', error: error.message };
    }
  });

  ipcMain.handle('wait-backend-ready', async (event, timeoutMs = 240000) => {
    const startupResult = await ensureBackendStarted();
    if (!startupResult.success) {
      return startupResult;
    }

    return await waitForBackendHealth(timeoutMs);
  });

  ipcMain.handle('get-runtime-config', () => getRuntimeConfig());
  ipcMain.handle('open-log-directory', async () => {
    const logDir = app.getPath('logs');
    const error = await shell.openPath(logDir);
    return { success: !error, error: error || null, path: logDir };
  });
  ipcMain.handle('get-app-path', () => getAppRootDir());

  // ===== 检查更新 =====
  // 更新信息放在 Gitee（国内直连，用户不需要 GitHub 也不需要代理）；
  // 下载仍然走百度网盘，这里只负责"告诉用户有没有新版"。
  // 主源是 Gitee（国内直连，0.3 秒级）；后两个是兜底：gh-proxy 是第三方转发，
  // 实测能用但慢（约 6 秒）；直连 GitHub raw 在国内基本不通，只留给海外用户。
  const UPDATE_FEED_URLS = [
    'https://gitee.com/bastzber/echomind-updates/raw/master/update.json',
    'https://gh-proxy.com/https://raw.githubusercontent.com/Bastzber/EchoMind/main/update.json',
    'https://raw.githubusercontent.com/Bastzber/EchoMind/main/update.json'
  ];

  async function fetchUpdateFeed() {
    for (const url of UPDATE_FEED_URLS) {
      if (!/^https?:\/\//i.test(url) || url.includes('<')) continue;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);
      try {
        // Gitee raw 带 max-age=60 的 CDN 缓存：加个时间戳，保证点一次就是最新的
        const target = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
        const response = await fetch(target, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) continue;
        return await response.json();
      } catch (_error) {
        // 换下一个源；全部失败就当"没有更新"，绝不打扰用户
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }


  // ===== 增量更新 =====
  // 安装目录只放程序；用户数据在 %APPDATA%\\EchoMind，更新绝不碰它。
  const UPDATER_BACKUP_ROOT = () => path.join(app.getPath('userData'), 'update-backup');
  const updaterApply = require(path.join(__dirname, 'lib', 'updater-apply.js'));

  ipcMain.handle('updater-pick', async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: '选择增量更新包',
      filters: [{ name: '更新包', extensions: ['zip'] }],
      properties: ['openFile']
    });
    if (picked.canceled || !picked.filePaths.length) return { canceled: true };
    return { canceled: false, zipPath: picked.filePaths[0] };
  });

  ipcMain.handle('updater-inspect', async (event, zipPath) => {
    try {
      if (!zipPath || !fsSync.existsSync(zipPath)) return { ok: false, error: '更新包不存在' };
      const installRoot = path.dirname(app.getPath('exe'));
      const { manifest, plan } = await updaterApply.inspect(zipPath, installRoot);
      // 增量包能不能装，看的是「包里的文件比本地新」，不是版本号相等。
      // 以前要求 baseVersion 严格等于当前版本，结果每台机器都得单独打包，
      // 用户手上拿着包也装不上（11-04 实测：beta.10 的包盖不到 beta.19）。
      // 现在改成：baseVersion 只要不高于当前版本就放行 —— 老包覆盖到新版本上
      // 最多是「该改的改了、没改的保持」，不会把新东西退回去（文件是同一份）。
      // 只有 baseVersion 比当前版本还新时才拦，那才是真的会退版本。
      const normalize = (value) => String(value || '').split('-r')[0].trim();
      const parseVersion = (value) => {
        const m = String(value || '').match(/(\d+)\.(\d+)\.(\d+)-beta\.(\d+)/);
        return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
      };
      const targetVersion = normalize(manifest.baseVersion);
      const currentVersion = app.getVersion();
      if (targetVersion) {
        const target = parseVersion(targetVersion);
        const current = parseVersion(currentVersion);
        if (target && current) {
          const newer = target[0] > current[0]
            || (target[0] === current[0] && target[1] > current[1])
            || (target[0] === current[0] && target[1] === current[1] && target[2] > current[2])
            || (target[0] === current[0] && target[1] === current[1] && target[2] === current[2]
                && target[3] > current[3]);
          if (newer) {
            return {
              ok: false,
              error: '这个更新包要求至少 ' + targetVersion + '，当前是 ' + currentVersion
                + '。包比你的版本新，装上会把旧文件盖回去，请用当前版本的包或完整安装包。',
              version: manifest.version,
              baseVersion: manifest.baseVersion,
              currentVersion,
            };
          }
        } else if (targetVersion !== currentVersion) {
          // 版本号格式认不出来时保守处理：只允许相等
          return {
            ok: false,
            error: '这个更新包对应 ' + targetVersion + '，当前是 ' + currentVersion + '。',
            version: manifest.version,
            baseVersion: manifest.baseVersion,
            currentVersion,
          };
        }
      }
      return {
        ok: true,
        installRoot,
        version: manifest.version,
        baseVersion: manifest.baseVersion,
        createdAt: manifest.createdAt,
        fileCount: manifest.files.length,
        replaceCount: plan.replace.length,
        replaceBytes: plan.replaceBytes,
        totalBytes: plan.totalBytes,
        removeCount: plan.remove.length,
        upToDate: plan.upToDate,
        files: plan.replace.slice(0, 40).map((item) => ({ path: item.path, size: item.size })),
        removeFiles: plan.remove.slice(0, 40)
      };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  });

  ensureBreezeServer();

  ipcMain.handle('updater-apply', async (event, zipPath) => {
    const installRoot = path.dirname(app.getPath('exe'));
    let backupRoot = UPDATER_BACKUP_ROOT();
    // 先干掉后端进程。soundbot-backend.exe 常驻，是最常见的占用源；
    // 不杀就会走「留 .updating 等下次启动」那条路，用户看到「更新成功」
    // 却还是旧版本（M14：公司电脑连装三次都没落地）。
    try {
      const { execSync } = require('child_process');
      execSync('taskkill /F /IM soundbot-backend.exe /T', { stdio: 'ignore', windowsHide: true });
      await new Promise((resolve) => setTimeout(resolve, 1200));
    } catch (_) { /* 本来就没在跑 */ }
    try {
      const result = await updaterApply.apply(zipPath, installRoot, backupRoot);
      if (result && result.needsRestart) {
        // app.asar / soundbot-backend.exe 正在被占用：留 .updating，等退出后换。
        // 关键：cmd 生成后必须真的执行 —— 11-01 那版只写了 .finish-update.cmd 从没启动过，
        // 结果公司电脑连装 r26/r27/r28 三次，backend 一直停在 r25，界面还报「更新成功」。
        updaterApply.schedulePendingSwap(installRoot, process.execPath);
        const pendingBat = path.join(installRoot, '.finish-update.cmd');
        if (fsSync.existsSync(pendingBat)) {
          try {
            spawn('cmd.exe', ['/c', pendingBat], {
              detached: true, stdio: 'ignore', windowsHide: true,
            }).unref();
            // cmd 里的 timeout 等本进程退出，这里主动退出让它接管替换与重启
            setTimeout(() => { try { app.exit(0); } catch (_) { } }, 1500);
          } catch (spawnError) {
            return { ...result, ok: false, error: '需要重启才能完成替换，但替换脚本启动失败: ' + (spawnError?.message || spawnError) };
          }
        } else {
          return {
            ...result, ok: false,
            error: '有 ' + result.pendingCount + ' 个文件被占用，替换脚本没有生成，请完全退出程序后重装更新包',
          };
        }
      }
      return result;
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('updater-restart', async () => {
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });

  ipcMain.handle('updater-download', async (event, url, options = {}) => {
    try {
      const target = path.join(app.getPath('temp'), 'echomind-update-' + Date.now() + '.zip');
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok || !response.body) {
        return { ok: false, error: '下载失败: HTTP ' + response.status };
      }
      const total = Number(response.headers.get('content-length') || 0);
      const fileStream = fsSync.createWriteStream(target);
      let received = 0;
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (!fileStream.write(Buffer.from(value))) {
          await new Promise((resolve) => fileStream.once('drain', resolve));
        }
        if (total) {
          event.sender.send('updater-progress', {
            received, total, percent: Math.round((received / total) * 100)
          });
        }
      }
      await new Promise((resolve) => fileStream.end(resolve));
      return { ok: true, zipPath: target, size: received };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('app-version', () => app.getVersion());

  ipcMain.handle('check-update', async () => {
    const current = app.getVersion();
    const result = { ok: false, current, hasUpdate: false, latest: null, error: '' };
    try {
      const raw = await fetchUpdateFeed();
      if (!raw) {
        result.error = '更新信息源不可用（可能没联网）';
        return result;
      }
      const { normalizeFeed, isNewer } = require('./lib/update-feed');
      const latest = normalizeFeed(raw);
      result.ok = true;
      result.latest = latest;
      result.hasUpdate = isNewer(latest.version, current);
      return result;
    } catch (error) {
      result.error = (error && error.message) || '检查更新失败';
      return result;
    }
  });

  // ===== 匿名使用统计 =====
  // 只上报「启动次数 / 当天启动 / 版本 / 平台 / 首次安装」这几个计数，
  // 不带安装 ID、路径、文件名等任何能定位个人的信息；设置里可以关。
  const telemetryFile = () => path.join(app.getPath('userData'), 'telemetry.json');

  function readTelemetryState() {
    try {
      return JSON.parse(fs.readFileSync(telemetryFile(), 'utf8'));
    } catch (_error) {
      return {};
    }
  }

  function writeTelemetryState(state) {
    try {
      fs.mkdirSync(path.dirname(telemetryFile()), { recursive: true });
      fs.writeFileSync(telemetryFile(), JSON.stringify(state, null, 2), 'utf8');
    } catch (_error) {
      // 写不进去就算了，统计不能影响使用
    }
  }

  let telemetrySent = false;

  async function telemetryTick() {
    if (telemetrySent) return;
    telemetrySent = true;
    try {
      const { buildPings, normalizeState } = require('./lib/telemetry');
      const state = normalizeState(readTelemetryState());
      if (!state.enabled) return;
      const firstRun = !state.firstRunDone;
      const urls = buildPings({ version: app.getVersion(), platform: process.platform, firstRun });
      for (const url of urls) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        try {
          await fetch(url, { signal: controller.signal });
        } catch (_error) {
          // 没网也不影响，接着打下一个
        } finally {
          clearTimeout(timer);
        }
      }
      writeTelemetryState({
        ...state,
        firstRunDone: true,
        createdAt: state.createdAt || new Date().toISOString()
      });
    } catch (_error) {
      // 统计永远不抛错
    }
  }

  app.whenReady().then(() => {
    setTimeout(telemetryTick, 8000);
  });

  ipcMain.handle('telemetry-get', () => {
    const { normalizeState } = require('./lib/telemetry');
    return { success: true, ...normalizeState(readTelemetryState()) };
  });

  ipcMain.handle('telemetry-set', (_event, enabled) => {
    const { normalizeState } = require('./lib/telemetry');
    const state = normalizeState(readTelemetryState());
    const next = { ...state, enabled: enabled !== false };
    writeTelemetryState(next);
    return { success: true, enabled: next.enabled };
  });

  ipcMain.handle('open-external', async (_event, url) => {
    try {
      const target = String(url || '');
      if (!/^https?:\/\//i.test(target)) {
        return { success: false, error: '只允许打开 http(s) 链接' };
      }
      await shell.openExternal(target);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error && error.message) || '打开失败' };
    }
  });
  ipcMain.handle('check-full-disk-access', async () => {
    if (process.platform !== 'darwin') {
      return true;
    }

    try {
      fs.readdirSync(app.getPath('documents'));
      return true;
    } catch (error) {
      return false;
    }
  });
  ipcMain.handle('open-privacy-settings', async () => {
    if (process.platform !== 'darwin') {
      return { success: false, error: '仅支持 macOS' };
    }

    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
    return { success: true };
  });

  function toImportFileInfo(filePath) {
    const stats = fs.statSync(filePath);
    const extension = path.extname(filePath).toLowerCase();

    return {
      path: filePath,
      name: path.basename(filePath),
      size: stats.size,
      type: extension,
      lastModified: stats.mtimeMs
    };
  }

  ipcMain.handle('file-import', async (event, action, payload) => {
    try {
      switch (action) {
        case 'select-audio': {
          const result = await showOwnedOpenDialog(event, {
            ...payload,
            properties: ['openFile', 'multiSelections'],
            filters: [
              { name: 'Audio Files', extensions: supportedAudioFilterExtensions }
            ]
          });

          if (result.canceled) {
            return { success: false, canceled: true, filePaths: [] };
          }

          const files = (result.filePaths || [])
            .filter((filePath) => supportedAudioExtensions.has(path.extname(filePath).toLowerCase()))
            .filter((filePath) => fs.existsSync(filePath))
            .map(toImportFileInfo);

          return {
            success: true,
            canceled: false,
            filePaths: result.filePaths || [],
            files
          };
        }
        case 'select-folder': {
          const result = await showOwnedOpenDialog(event, {
            ...payload,
            properties: ['openDirectory']
          });

          if (result.canceled) {
            return { success: false, canceled: true, filePaths: [] };
          }

          const folder = (result.filePaths || [])[0] || '';
          return {
            success: Boolean(folder),
            canceled: false,
            filePaths: result.filePaths || [],
            folder
          };
        }
        case 'handle-drop':
          return {
            success: true,
            files: (payload || [])
              .filter((filePath) => typeof filePath === 'string' && fs.existsSync(filePath))
              .map(toImportFileInfo)
          };
        case 'get-info': {
          if (!payload || !fs.existsSync(payload)) {
            return { success: false, error: '文件不存在' };
          }

          const stats = fs.statSync(payload);
          return {
            success: true,
            path: payload,
            name: path.basename(payload),
            size: stats.size,
            isDirectory: stats.isDirectory(),
            extension: path.extname(payload).toLowerCase()
          };
        }
        case 'validate-type': {
          const extension = path.extname(payload || '').toLowerCase();
          return {
            success: true,
            valid: supportedAudioExtensions.has(extension),
            extension
          };
        }
        case 'mascot-load': {
          try {
            const file = path.join(app.getPath('userData'), 'mascot.png');
            if (!fs.existsSync(file)) return { success: true, image: null };
            const buf = fs.readFileSync(file);
            if (buf.length > 4 * 1024 * 1024) return { success: false, error: '图片过大（>4MB）' };
            return { success: true, image: 'data:image/png;base64,' + buf.toString('base64') };
          } catch (error) {
            return { success: false, error: error?.message || String(error) };
          }
        }
        case 'mascot-pick': {
          try {
            const result = await dialog.showOpenDialog(mainWindow, {
              title: '选择吉祥物图片',
              filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
              properties: ['openFile'],
            });
            if (result.canceled || !result.filePaths?.length) return { success: false, canceled: true };
            const source = result.filePaths[0];
            const target = path.join(app.getPath('userData'), 'mascot.png');
            fs.copyFileSync(source, target);
            const buf = fs.readFileSync(target);
            const ext = path.extname(source).toLowerCase();
            const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : (ext === '.webp' ? 'image/webp' : 'image/png');
            return { success: true, image: 'data:' + mime + ';base64,' + buf.toString('base64') };
          } catch (error) {
            return { success: false, error: error?.message || String(error) };
          }
        }
        case 'trash-files': {
          const list = Array.isArray(payload?.paths) ? payload.paths : [];
          const ok = [], failed = [];
          for (const target of list) {
            try {
              if (!target || !fs.existsSync(target)) { failed.push({ path: target, error: '文件不存在' }); continue; }
              // 只许删素材库以内的文件：串到别处就是把用户其它资料送进回收站
              try {
                assertInsideRoots(target, await getLibraryRoots());
              } catch (boundaryError) {
                console.warn('[fs-guard] trash-files 拒绝: ' + boundaryError.message);
                failed.push({ path: target, error: boundaryError.message });
                continue;
              }
              await shell.trashItem(target);   // 送系统回收站，可还原
              ok.push(target);
            } catch (error) {
              failed.push({ path: target, error: error?.message || String(error) });
            }
          }
          return { success: failed.length === 0, ok, failed };
        }
        case 'reveal-in-explorer': {
          // 在系统资源管理器中定位文件
          const target = typeof payload === 'string' ? payload : (payload?.filePath || '');
          console.log('[FileOps] reveal-in-explorer target=', target, 'exists=', fs.existsSync(target));
          if (!target || !fs.existsSync(target)) {
            return { success: false, error: '文件不存在' };
          }
          try {
            shell.showItemInFolder(target);
            return { success: true };
          } catch (revealError) {
            // 降级：直接打开所在文件夹
            try {
              shell.openPath(path.dirname(target));
              return { success: true, fallback: true };
            } catch (openError) {
              return { success: false, error: `无法打开资源管理器: ${openError?.message || openError}` };
            }
          }
        }
        case 'copy-file-clipboard': {
          // 将文件复制到系统剪贴板（支持在资源管理器中直接粘贴）
          const target = typeof payload === 'string' ? payload : (payload?.filePath || '');
          console.log('[FileOps] copy-file-clipboard target=', target, 'exists=', fs.existsSync(target));
          if (!target || !fs.existsSync(target)) {
            return { success: false, error: '文件不存在' };
          }
          try {
            // 先试 Electron 原生 clipboard：进程内调用，几毫秒出结果。
            // 以前一律起 powershell.exe -STA，每次 200~500ms，连点几次就明显卡。
            try {
              const { clipboard } = require('electron');
              if (clipboard && typeof clipboard.writeBuffer === 'function') {
                // CF_HDROP（15）的缓冲区格式：DROPFILES 头 + UTF-16 路径 + 双 NUL
                const headerSize = 20;
                const fileList = Buffer.from(target + '\u0000\u0000', 'utf16le');
                const dropfiles = Buffer.alloc(headerSize + fileList.length);
                dropfiles.writeUInt32LE(headerSize, 0);   // pFiles 偏移
                dropfiles.writeUInt32LE(0, 4);            // pt.x
                dropfiles.writeUInt32LE(0, 8);            // pt.y
                dropfiles.writeUInt32LE(0, 12);           // fNC
                dropfiles.writeUInt32LE(1, 16);           // fWide = 1（UTF-16）
                fileList.copy(dropfiles, headerSize);
                clipboard.writeBuffer('CF_HDROP', dropfiles);
                if (clipboard.availableFormats().includes('FileNameW')) {
                  return { success: true, method: 'clipboard-native' };
                }
              }
            } catch (nativeClipboardError) {
              console.warn('[FileOps] 原生剪贴板失败，回退 powershell:', nativeClipboardError?.message);
            }
            // 兜底：Windows 原生 CF_HDROP via System.Windows.Forms.SetFileDropList，
            // 与资源管理器 100% 兼容（含中文路径）。
            // -STA 线程为剪贴板访问所必需；-EncodedCommand 避免中文编码问题。
            const escaped = target.replace(/'/g, "''");
            const psScript = [
              'Add-Type -AssemblyName System.Windows.Forms',
              "$c = New-Object System.Collections.Specialized.StringCollection",
              `$c.AddRange(@('${escaped}'))`,
              '[System.Windows.Forms.Clipboard]::SetFileDropList($c)',
              "Write-Output ('CF_HDROP=' + [System.Windows.Forms.Clipboard]::ContainsFileDropList())"
            ].join('; ');
            const psBase64 = Buffer.from(psScript, 'utf16le').toString('base64');
            let verify = '';
            await new Promise((resolve, reject) => {
              execFile('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', psBase64], { timeout: 15000 }, (err, stdout, stderr) => {
                if (stdout) verify = stdout.toString().trim();
                if (err) reject(new Error((stderr || err.message).toString().trim() || err.message));
                else resolve();
              });
            });
            console.log('[FileOps] SetFileDropList done, verify=', verify);
            return { success: true, method: 'cf_hdrop', verify };
          } catch (psError) {
            console.error('[FileOps] SetFileDropList failed:', psError.message || psError);
            // 降级：Electron clipboard 写入 + 文本路径
            try {
              clipboard.write([{ path: target }]);
              clipboard.write({ text: target });
              return { success: true, method: 'fallback' };
            } catch (clipError) {
              return { success: false, error: `无法写入剪贴板: ${clipError?.message || clipError}` };
            }
          }
        }
        case 'rename-on-disk': {
          // 磁盘重命名 + 后端同步数据库记录
          const oldPath = payload?.oldPath || '';
          const newName = payload?.newName || '';
          if (!oldPath || !newName || !fs.existsSync(oldPath)) {
            return { success: false, error: '源文件不存在' };
          }
          // newName 只当文件名用：拒绝 ../ 和路径分隔符，避免改名成「跳出当前目录」
          const baseName = path.basename(String(newName));
          if (!baseName || baseName === '.' || baseName === '..' || /[\\/]/.test(String(newName))) {
            return { success: false, error: '新文件名不合法' };
          }
          let safeOld;
          try {
            safeOld = assertInsideRoots(oldPath, await getLibraryRoots());
          } catch (boundaryError) {
            console.warn('[fs-guard] rename-on-disk 拒绝: ' + boundaryError.message);
            return { success: false, error: boundaryError.message, code: boundaryError.code };
          }
          const dir = path.dirname(safeOld);
          const newPath = path.join(dir, baseName);
          if (fs.existsSync(newPath)) {
            return { success: false, error: '目标文件名已存在' };
          }
          fs.renameSync(oldPath, newPath);
          try {
            const encodedOld = encodeURIComponent(oldPath);
            await requestBackendJson(`${apiBaseUrl}/api/v1/db/file/${encodedOld}/rename`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ new_name: newName })
            });
          } catch (backendError) {
            // 后端同步失败时回滚磁盘重命名
            try { fs.renameSync(newPath, oldPath); } catch (_) {}
            return { success: false, error: `数据库同步失败: ${backendError?.message || ''}` };
          }
          return { success: true, newPath };
        }
        default:
          return { success: false, error: `未知文件导入操作: ${action}` };
      }
    } catch (error) {
      const code = error?.code || 'FILE_IMPORT_FAILED';
      const message = error?.message || '文件导入操作失败';
      console.error('[FileImport] IPC action failed:', { action, code, message });
      return {
        success: false,
        error: message,
        code,
        retryable: code === 'DIALOG_BUSY',
        details: { action }
      };
    }
  });

  // 拖拽文件
  ipcMain.handle('start-drag', async (event, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        return { success: false, error: '文件不存在' };
      }

      const iconPath = path.join(__dirname, 'assets', 'audio-icon.png');
      const finalIconPath = fs.existsSync(iconPath) ? iconPath : undefined;

      mainWindow.webContents.startDrag({
        file: filePath,
        icon: finalIconPath
      });

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

}

// ==================== 应用生命周期 ====================

// 创建启动窗口（显示加载状态）
let splashWindow = null;

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 400,
    height: 240,
    frame: false,
    alwaysOnTop: true,
    transparent: false,
    resizable: false,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl.startsWith('soundbot-action://open-logs')) {
      event.preventDefault();
      shell.openPath(app.getPath('logs')).then((error) => {
        if (error) console.error('[Splash] Failed to open log directory:', error);
      });
    }
  });
  splashWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  splashWindow.webContents.once('did-finish-load', () => {
    applySplashState();
  });
  return splashWindow;
}

function applySplashState() {
  if (!splashWindow || splashWindow.isDestroyed() || splashWindow.webContents.isLoading()) return;
  const payload = JSON.stringify(pendingSplashState);
  splashWindow.webContents.executeJavaScript(
    `window.setSoundBotSplashStatus(${payload})`
  ).catch(() => {});
}

// 更新启动窗口状态
function updateSplashStatus(status, progress, isError = false) {
  pendingSplashState = {
    status: String(status || ''),
    progress: String(progress || ''),
    isError: Boolean(isError)
  };
  applySplashState();
}

// 关闭启动窗口
function closeSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
    splashWindow = null;
  }
}

app.whenReady().then(async () => {
  initializeMainLogging();
  registerAudioProtocol();
  installBackendAuthHeader();
  await primeSafeStorageStatus();

  // 创建启动窗口
  createSplashWindow();
  
  // 先启动后端
  updateSplashStatus('正在启动后端服务...', '检查模型文件');
  const result = await ensureBackendStarted();
  
  if (!result.success) {
    console.error('[App] Backend startup failed:', result.error);
    updateSplashStatus(
      '启动失败',
      `${result.error || '未知错误'} · 点「打开日志」看后端输出，重开程序可再试`,
      true
    );
    return;
  }
  
  updateSplashStatus('服务已就绪', '正在加载界面...');
  
  // 后端启动成功后再创建主窗口
  createWindow();

  // 全局搜索热键：在别的软件里也能呼出
  try {
    const shortcutState = globalSearch.init(mainWindow);
    if (!shortcutState.ok) {
      console.warn('[GlobalSearch] 热键未注册:', shortcutState.message);
    }
  } catch (error) {
    console.warn('[GlobalSearch] 初始化失败:', error.message);
  }
  
  // 等待主窗口准备好后关闭启动窗口
  mainWindow.once('ready-to-show', () => {
    if (rendererPreloadFailure || !rendererBridgeReady) {
      const reason = rendererPreloadFailure
        ? '桌面桥接组件加载失败'
        : '桌面桥接组件未完成初始化';
      console.error('[Renderer] Bridge startup assertion failed:', {
        rendererBridgeReady,
        rendererPreloadFailure
      });
      updateSplashStatus('界面加载失败', `${reason} · 请重新安装应用`, true);
      mainWindow.destroy();
      return;
    }
    closeSplashWindow();
    mainWindow.show();
    
    // 通知前端后端已就绪
    mainWindow.webContents.send('backend-ready', { success: true });
    
    if (process.argv.includes('--dev')) {
      mainWindow.webContents.openDevTools();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  try { globalSearch.dispose(); } catch (_e) { /* 退出时忽略 */ }
  // 退出时一定带走后端，否则下次启动会再起一个，多个后端抢同一个数据库
  if (backendProcess && backendProcess.exitCode === null) {
    try { backendProcess.kill(); } catch (error) { console.warn('[Backend] kill on quit failed:', error.message); }
    backendProcess = null;
  }
});

app.on('window-all-closed', () => {
  // 托盘常驻时不退出；其余行为沿用 Electron 默认
  if (readWindowPrefs().closeBehavior === 'tray' && !isQuitting) return;
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }

  if (!backendProcess) {
    ensureBackendStarted().catch((error) => {
      console.error('[App] Backend restart failed:', error);
    });
  }
});

app.on('before-quit', async (event) => {
  if (quitInProgress) {
    return;
  }
  event.preventDefault();
  quitInProgress = true;
  await stopBackend();
  app.exit(0);
});