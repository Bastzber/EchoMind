/* global-shortcut-settings.js —— 设置面板里的「快捷键」页
 *
 * 只做三件事：显示当前键、录制新键、保存后立即生效。
 * 录制时不吞掉系统键（Alt+F4 之类），只把组合转成 Electron accelerator。
 */
(function () {
  'use strict';

  const MODIFIERS = new Set(['Control', 'Alt', 'Shift', 'Meta']);

  const KEY_MAP = {
    ' ': 'Space',
    'ArrowUp': 'Up',
    'ArrowDown': 'Down',
    'ArrowLeft': 'Left',
    'ArrowRight': 'Right',
    'Escape': 'Esc',
    'Enter': 'Enter',
    'Tab': 'Tab',
    'Backspace': 'Backspace',
    'Delete': 'Delete',
    'Home': 'Home',
    'End': 'End',
    'PageUp': 'PageUp',
    'PageDown': 'PageDown',
    'Insert': 'Insert'
  };

  let recording = false;
  let pendingKeys = [];   // 录制中的修饰键
  let bound = false;

  function $(id) { return document.getElementById(id); }

  function displayEl() { return $('globalShortcutDisplay'); }
  function hintEl() { return $('globalShortcutHint'); }
  function recordBtn() { return $('globalShortcutRecord'); }

  function setHint(text, color) {
    const el = hintEl();
    if (!el) return;
    el.textContent = text;
    el.style.color = color || 'var(--text-secondary)';
  }

  function toAccelerator(event) {
    const parts = [];
    if (event.ctrlKey) parts.push('CommandOrControl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Super');

    let key = event.key;
    if (!key || MODIFIERS.has(key)) return null;
    if (KEY_MAP[key]) key = KEY_MAP[key];
    else if (key.length === 1) key = key.toUpperCase();

    // 功能键直接用
    if (/^F\d{1,2}$/.test(key)) {
      parts.push(key);
    } else if (/^[A-Z0-9]$/.test(key)) {
      parts.push(key);
    } else if (['Space', 'Enter', 'Tab', 'Backspace', 'Delete', 'Home', 'End',
                'PageUp', 'PageDown', 'Insert', 'Up', 'Down', 'Left', 'Right',
                'Esc', 'PrintScreen'].includes(key)) {
      parts.push(key);
    } else {
      // 其他字符键（符号键）Electron 也能接，但容易和输入法冲突，这里放过
      if (key.length === 1) parts.push(key);
      else return null;
    }

    // 只有修饰键没有主键 = 还没按完
    if (parts.length === 0) return null;
    // 纯字母数字不带走修饰键的话，会把正常打字也吃掉
    const hasModifier = event.ctrlKey || event.altKey || event.shiftKey || event.metaKey;
    if (!hasModifier) return null;

    return parts.join('+');
  }

  function humanize(accel) {
    return String(accel || '')
      .replace(/CommandOrControl/gi, 'Ctrl')
      .replace(/Command/gi, 'Cmd')
      .replace(/\s*\+\s*/g, '+');
  }

  async function refresh() {
    const api = window.electronAPI?.globalSearch;
    if (!api?.getState) {
      setHint('这台机器的桌面桥接没装好，快捷键不可用', '#ef4444');
      return;
    }
    try {
      const state = await api.getState();
      const el = displayEl();
      if (el) el.textContent = humanize(state.accelerator);
      if (state.registered) {
        setHint('已生效。在任何软件里按下这组键都能呼出搜索框。', '#22c55e');
      } else {
        setHint('这组键没能注册成功，可能被其他软件占用，换一组试试。', '#f59e0b');
      }
    } catch (error) {
      setHint('读取设置失败：' + (error.message || error), '#ef4444');
    }
  }

  function stopRecording() {
    recording = false;
    pendingKeys = [];
    const btn = recordBtn();
    if (btn) {
      btn.textContent = '录制';
      btn.style.color = '';
      btn.style.borderColor = 'var(--border-color)';
    }
  }

  async function saveAccelerator(accelerator) {
    const api = window.electronAPI?.globalSearch;
    if (!api?.setAccelerator) return;
    const result = await api.setAccelerator(accelerator);
    const el = displayEl();
    if (el) el.textContent = humanize(result.accelerator);
    if (result.ok) {
      setHint('已保存，立即生效。', '#22c55e');
    } else {
      setHint(result.message || '保存失败', '#f59e0b');
    }
  }

  function startRecording() {
    recording = true;
    pendingKeys = [];
    const btn = recordBtn();
    if (btn) {
      btn.textContent = '按下组合键…';
      btn.style.color = '#f59e0b';
      btn.style.borderColor = '#f59e0b';
    }
    setHint('现在按下你想要的组合键（Esc 取消）', '#f59e0b');
  }

  function handleKeyDown(event) {
    if (!recording) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      stopRecording();
      setHint('已取消录制', 'var(--text-secondary)');
      return;
    }

    // 只按了修饰键，先等着
    if (MODIFIERS.has(event.key)) {
      event.preventDefault();
      setHint('已按下 ' + event.key + '，再按一个主键', '#f59e0b');
      return;
    }

    const accelerator = toAccelerator(event);
    if (!accelerator) {
      setHint('这个键不能单独用，需要配合 Ctrl / Alt / Shift', '#f59e0b');
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    stopRecording();
    saveAccelerator(accelerator);
  }

  function bindOnce() {
    if (bound) return;

    document.addEventListener('keydown', handleKeyDown, true);

    recordBtn()?.addEventListener('click', () => {
      if (recording) stopRecording();
      else startRecording();
    });

    $('globalShortcutReset')?.addEventListener('click', async () => {
      const api = window.electronAPI?.globalSearch;
      if (!api?.resetAccelerator) return;
      const result = await api.resetAccelerator();
      const el = displayEl();
      if (el) el.textContent = humanize(result.accelerator);
      setHint(result.ok ? '已恢复默认快捷键' : (result.message || '恢复失败'),
        result.ok ? '#22c55e' : '#f59e0b');
    });

    $('globalShortcutTest')?.addEventListener('click', async () => {
      const api = window.electronAPI?.globalSearch;
      if (!api?.show) return;
      try {
        await api.show();
      } catch (error) {
        setHint('呼出失败：' + (error.message || error), '#ef4444');
      }
    });

    // 每次打开设置面板都刷新一次状态（可能被别的软件抢了）
    document.querySelectorAll('.settings-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.id === 'shortcutTabBtn') {
          stopRecording();
          refresh();
        } else if (recording) {
          stopRecording();
        }
      });
    });

    bound = true;
  }

  window.__initGlobalShortcutSettings = function () {
    bindOnce();
    refresh();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { bindOnce(); });
  } else {
    bindOnce();
  }
})();
