/**
 * lib/global-search.js —— 全局搜索（跨软件呼出）
 *
 * 职责：
 *   1. 注册系统级热键（globalShortcut），在别的剪辑软件里也能唤起
 *   2. 开一个无边框置顶的小窗，输入即搜，回车播放/定位
 *   3. 快捷键改完立即生效，配置落盘到 %APPDATA%/EchoMind/global-search.json
 *
 * 设计取舍：
 *   - 搜索窗常驻不销毁，只是 show/hide。每次重建会让呼出慢 200~400ms，
 *     而「按快捷键 → 马上能打字」是这个功能的全部价值。
 *   - 失焦自动隐藏（像 Spotlight）。但点结果时必须先确认动作完成再隐藏，
 *     否则「打开所在文件夹」会因为窗口消失而中断。
 *   - 热键注册失败不能崩，要能告诉用户「这个键被别的软件占了」。
 */

const { BrowserWindow, globalShortcut, screen, app, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const CONFIG_NAME = 'global-search.json';
const DEFAULT_ACCELERATOR = 'CommandOrControl+Shift+Space';

// 一个能用的键位集合。用户自己录制的键会原样存，这里只是兜底校验。
const MODIFIER_KEYS = new Set([
  'Control', 'Ctrl', 'Alt', 'Shift', 'Meta', 'Super', 'Command', 'Cmd'
]);

let searchWindow = null;
let currentAccelerator = DEFAULT_ACCELERATOR;
let registered = false;
let mainWindowRef = null;

function configPath() {
  return path.join(app.getPath('appData'), 'EchoMind', CONFIG_NAME);
}

function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    const accel = typeof parsed.accelerator === 'string' ? parsed.accelerator.trim() : '';
    return { accelerator: accel || DEFAULT_ACCELERATOR };
  } catch (_error) {
    return { accelerator: DEFAULT_ACCELERATOR };
  }
}

function writeConfig(accelerator) {
  try {
    const dir = path.dirname(configPath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ accelerator }, null, 2),
      'utf8'
    );
    return true;
  } catch (error) {
    console.error('[GlobalSearch] 写配置失败:', error.message);
    return false;
  }
}

/** 把 Electron 的 accelerator 转成人看的文字（Ctrl+Shift+Space） */
function humanizeAccelerator(accel) {
  return String(accel || '')
    .replace(/CommandOrControl/gi, 'Ctrl')
    .replace(/Command/gi, 'Cmd')
    .replace(/\s*\+\s*/g, '+');
}

function ensureWindow() {
  if (searchWindow && !searchWindow.isDestroyed()) return searchWindow;

  searchWindow = new BrowserWindow({
    width: 680,
    height: 460,
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#0b0b0c',
    transparent: false,
    hasShadow: true,
    // 别在任务栏留痕迹，也别抢主窗口的焦点环
    focusable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, '..', 'preload.js'),
      webSecurity: true
    }
  });

  searchWindow.setMenuBarVisibility(false);
  searchWindow.loadFile(path.join(__dirname, '..', 'search-popup.html'));

  // 失焦就藏起来，跟系统搜索一个手感。
  // 但用户点了「打开所在文件夹」这类动作时，主进程会把 suppressBlurHide 打开，
  // 避免动作做到一半窗口没了。
  searchWindow.on('blur', () => {
    if (suppressBlurHide) return;
    hideSearchWindow();
  });

  searchWindow.on('closed', () => {
    searchWindow = null;
  });

  return searchWindow;
}

let suppressBlurHide = false;

/** 调这个包一层，窗口不会在你操作资源管理器的时候自己消失 */
function withBlurSuppressed(fn) {
  suppressBlurHide = true;
  const timer = setTimeout(() => { suppressBlurHide = false; }, 3000);
  try {
    return fn();
  } finally {
    setTimeout(() => {
      suppressBlurHide = false;
      clearTimeout(timer);
    }, 600);
  }
}

function centerOnActiveDisplay() {
  if (!searchWindow || searchWindow.isDestroyed()) return;
  try {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const area = display.workArea;
    const [width, height] = searchWindow.getSize();
    const x = Math.round(area.x + (area.width - width) / 2);
    // 稍微偏上一点，像系统搜索那样，不压住正在看的画面
    const y = Math.round(area.y + Math.max(60, (area.height - height) * 0.28));
    searchWindow.setPosition(x, y, false);
  } catch (error) {
    console.warn('[GlobalSearch] 定位失败:', error.message);
  }
}

function showSearchWindow() {
  const win = ensureWindow();
  centerOnActiveDisplay();
  win.show();
  win.focus();
  // 每次呼出都清空上一次的内容，从干净状态开始
  try {
    win.webContents.send('global-search:opened');
  } catch (_error) { /* 页面还没加载完，忽略 */ }
}

function hideSearchWindow() {
  if (searchWindow && !searchWindow.isDestroyed() && searchWindow.isVisible()) {
    searchWindow.hide();
  }
}

function toggleSearchWindow() {
  if (searchWindow && !searchWindow.isDestroyed() && searchWindow.isVisible()) {
    hideSearchWindow();
  } else {
    showSearchWindow();
  }
}

/**
 * 注册热键。返回 { ok, accelerator, message }。
 * 失败不抛异常 —— 被别的软件占用是常见情况，得让界面能提示用户换一个。
 */
function registerShortcut(accelerator) {
  const accel = String(accelerator || '').trim() || DEFAULT_ACCELERATOR;

  // 先把自己上次注册的撤掉，否则同一组合会报「已被占用」
  try {
    if (registered) globalShortcut.unregister(currentAccelerator);
  } catch (_error) { /* 没注册过就算了 */ }
  registered = false;

  let ok = false;
  try {
    ok = globalShortcut.register(accel, () => toggleSearchWindow());
  } catch (error) {
    console.error('[GlobalSearch] 注册异常:', error.message);
    ok = false;
  }

  if (ok) {
    currentAccelerator = accel;
    registered = true;
    console.log('[GlobalSearch] 已注册热键:', accel);
    return { ok: true, accelerator: accel, message: '' };
  }

  // 注册不上就退回默认键，别让整个功能失效
  console.warn('[GlobalSearch] 热键注册失败，尝试回默认:', accel);
  try {
    ok = globalShortcut.register(DEFAULT_ACCELERATOR, () => toggleSearchWindow());
    if (ok) {
      currentAccelerator = DEFAULT_ACCELERATOR;
      registered = true;
      return {
        ok: false,
        accelerator: DEFAULT_ACCELERATOR,
        message: '这个组合被别的软件占用了，已回退到默认快捷键'
      };
    }
  } catch (_error) { /* 兜底也失败 */ }

  return {
    ok: false,
    accelerator: accel,
    message: '快捷键注册失败，可能被其他软件占用，换一组试试'
  };
}

function init(mainWindow) {
  mainWindowRef = mainWindow;
  const config = readConfig();
  const result = registerShortcut(config.accelerator);
  if (result.ok) {
    currentAccelerator = config.accelerator;
  } else {
    currentAccelerator = result.accelerator;
  }
  return {
    ...result,
    acceleratorLabel: humanizeAccelerator(currentAccelerator)
  };
}

function applyAccelerator(accelerator) {
  const result = registerShortcut(accelerator);
  if (result.ok) writeConfig(result.accelerator);
  return {
    ...result,
    acceleratorLabel: humanizeAccelerator(result.accelerator)
  };
}

function getState() {
  return {
    accelerator: currentAccelerator,
    acceleratorLabel: humanizeAccelerator(currentAccelerator),
    registered
  };
}

function resetAccelerator() {
  return applyAccelerator(DEFAULT_ACCELERATOR);
}

function dispose() {
  try {
    if (registered) globalShortcut.unregister(currentAccelerator);
  } catch (_error) { /* 退出时忽略 */ }
  registered = false;
  if (searchWindow && !searchWindow.isDestroyed()) {
    searchWindow.destroy();
    searchWindow = null;
  }
}

module.exports = {
  DEFAULT_ACCELERATOR,
  MODIFIER_KEYS,
  init,
  dispose,
  getState,
  applyAccelerator,
  resetAccelerator,
  showSearchWindow,
  hideSearchWindow,
  toggleSearchWindow,
  withBlurSuppressed,
  humanizeAccelerator,
  getMainWindow: () => mainWindowRef
};
