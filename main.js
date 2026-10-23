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
const audioCapabilityManifest = require('./config/audio_capabilities.json');
const supportedAudioExtensions = new Set(Object.keys(audioCapabilityManifest.formats || {}));
const supportedAudioFilterExtensions = [...supportedAudioExtensions].map((value) => value.slice(1));

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
  { scheme: AUDIO_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

let mainWindow;
let backendProcess = null;
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
const SECRET_KEY_PATTERN = /^(llm|embedding)\.[a-z0-9_-]+\.api_key$/;
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
    for (const level of ['log', 'warn', 'error']) {
      console[level] = (...args) => {
        original[level](...args);
        const message = args.map(formatDiagnosticValue).join(' ');
        stream.write(
          `${new Date().toISOString()} | ${level.toUpperCase()} | ${redactDiagnosticText(message)}\n`
        );
      };
    }
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

function getSafeStorageStatus() {
  const encryptionAvailable = safeStorage.isEncryptionAvailable();
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

function registerAudioProtocol() {
  if (audioProtocolRegistered) return;

  protocol.registerFileProtocol(AUDIO_PROTOCOL, (request, callback) => {
    try {
      const parsed = new URL(request.url);
      const encodedPath = parsed.pathname.startsWith('/')
        ? parsed.pathname.slice(1)
        : parsed.pathname;
      const filePath = decodeURIComponent(encodedPath);

      if (!filePath || !path.isAbsolute(filePath) || !fs.existsSync(filePath)) {
        callback({ error: -6 });
        return;
      }

      const stats = fs.statSync(filePath);
      if (!stats.isFile()) {
        callback({ error: -6 });
        return;
      }

      callback({ path: filePath });
    } catch (error) {
      console.error('[AudioProtocol] Failed to resolve audio URL:', error);
      callback({ error: -2 });
    }
  });

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

  // 设置环境变量
  const env = {
    ...process.env,
    SOUNDBOT_PORT: String(backendPort),
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
        handshakeTimer = setTimeout(() => resolve(null), 10000);
      })
    ]);
    clearTimeout(handshakeTimer);
    if (!announcedPort) {
      console.error('[Backend] ✗ Port handshake timeout');
      if (backendProcess && backendProcess.exitCode === null) backendProcess.kill();
      return { success: false, error: '后端端口握手失败' };
    }

    const health = await waitForBackendHealth(120000);
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

async function waitForBackendHealth(timeoutMs = 120000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (!backendProcess || backendProcess.exitCode !== null) {
      const code = backendProcess ? backendProcess.exitCode : 'unknown';
      return { success: false, error: `后端进程意外退出 (code: ${code})` };
    }
    const controller = new AbortController();
    const requestTimer = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(`${apiBaseUrl}/health`, { signal: controller.signal });
      if (res.ok) {
        const payload = await res.json().catch(() => null);
        if (payload?.status === 'degraded' && payload?.audio_decoder_available === false) {
          return {
            success: false,
            error: '安装包内置音频解码器不可用',
            code: 'AUDIO_RUNTIME_UNAVAILABLE'
          };
        }
        if (
          payload?.status === 'healthy'
          && payload?.audio_decoder_available === true
          && payload?.version === app.getVersion()
        ) {
          return { success: true };
        }
      }
    } catch (error) {
    } finally {
      clearTimeout(requestTimer);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return { success: false, error: '启动超时' };
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

function getRuntimeConfig() {
  return {
    port: backendPort,
    apiBase: backendOrigin,
    apiV1Base: apiBaseUrl,
    wsBase: backendWsOrigin
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
  let response;
  try {
    response = await fetch(url, { ...options, signal: options.signal || controller.signal });
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
            client_id: data.clientId || 'default'
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
          body: JSON.stringify({ tags: data.tags || [] })
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

function applyCSP(win) {
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self' 'unsafe-inline'; " +
          "style-src 'self' 'unsafe-inline'; " +
          "font-src 'self'; " +
          "img-src 'self' data: blob:; " +
          `media-src 'self' blob: soundmind-audio: ${backendOrigin}; ` +
          `connect-src 'self' ${backendOrigin} ${backendWsOrigin} ` +
          "https://api.openai.com https://api.moonshot.cn https://api.anthropic.com " +
          "https://api.deepseek.com https://api.siliconflow.cn " +
          "https://generativelanguage.googleapis.com;"
        ]
      }
    });
  });
}

function createWindow() {
  rendererBridgeReady = false;
  rendererPreloadFailure = null;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    title: '回声 - AI 音效管理器',
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

async function showOwnedOpenDialog(event, options = {}) {
  if (nativeOpenDialogActive) {
    const error = new Error('已有文件选择窗口正在打开');
    error.code = 'DIALOG_BUSY';
    throw error;
  }

  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!owner || owner.isDestroyed()) {
    const error = new Error('主窗口当前不可用');
    error.code = 'WINDOW_UNAVAILABLE';
    throw error;
  }

  nativeOpenDialogActive = true;
  try {
    if (owner.isMinimized()) owner.restore();
    if (!owner.isVisible()) owner.show();
    owner.focus();
    return await dialog.showOpenDialog(owner, options);
  } finally {
    nativeOpenDialogActive = false;
    if (!owner.isDestroyed()) owner.focus();
  }
}

// ==================== IPC 处理 ====================

function setupIpcHandlers() {
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
  ipcMain.handle('sfx-config-get', () => {
    try {
      const file = path.join(app.getPath('appData'), 'soundbot', '.sfx_config.json');
      if (!fs.existsSync(file)) return { success: true, apiKey: '', saveDir: '' };
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return { success: true, apiKey: String(data.api_key || ''), saveDir: String(data.save_dir || '') };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('sfx-config-save', async (event, payload = {}) => {
    const apiKey = String(payload.apiKey || '').trim();
    const saveDir = String(payload.saveDir || '').trim();
    try {
      const dir = path.join(app.getPath('appData'), 'soundbot');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, '.sfx_config.json');
      const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
      const next = { ...current };
      if (apiKey) next.api_key = apiKey;
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

  ipcMain.handle('wait-backend-ready', async (event, timeoutMs = 60000) => {
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
            // Windows 原生 CF_HDROP：System.Windows.Forms.SetFileDropList，
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
          const dir = path.dirname(oldPath);
          const newPath = path.join(dir, newName);
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

  // 创建启动窗口
  createSplashWindow();
  
  // 先启动后端
  updateSplashStatus('正在启动后端服务...', '检查模型文件');
  const result = await ensureBackendStarted();
  
  if (!result.success) {
    console.error('[App] Backend startup failed:', result.error);
    updateSplashStatus(
      '启动失败',
      `${result.error || '未知错误'} · 请重新安装或查看应用日志`,
      true
    );
    return;
  }
  
  updateSplashStatus('服务已就绪', '正在加载界面...');
  
  // 后端启动成功后再创建主窗口
  createWindow();
  
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
