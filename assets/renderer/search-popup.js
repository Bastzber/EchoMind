/* search-popup.js —— 全局搜索小窗的逻辑
 *
 * 这个页面跑在独立的 BrowserWindow 里，和主窗口不共享 JS 环境，
 * 所以它自己拿 token、自己调后端，不能引用主窗口的任何函数。
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const queryEl = $('query');
  const listEl = $('list');
  const emptyEl = $('empty');
  const hintEl = $('hint');

  let results = [];
  let activeIndex = 0;
  let seq = 0;              // 每次输入 +1，丢弃慢回来的旧请求
  let debounceTimer = null;
  let audioEl = null;

  const api = window.electronAPI || {};
  const globalSearch = api.globalSearch || {};

  // ---------- 后端调用 ----------
  // 主进程注入了 token 头，这里只管发请求
  async function backendPost(path, body) {
    const res = await fetch('http://127.0.0.1:8000' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 120));
    }
    return res.json();
  }

  function buildPayload(query) {
    // project_id 是必填的，不传后端直接 422。
    // 全局搜索不区分工程，固定查 default（主工程）。
    return {
      query,
      project_id: 'default',
      top_k: 60,
      threshold: 0.25,
      page: 1,
      page_size: 40,
      fast: true
    };
  }

  // ---------- 渲染 ----------
  function formatDuration(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    if (s < 60) return s.toFixed(1) + ' 秒';
    const m = Math.floor(s / 60);
    const rest = Math.round(s % 60);
    return m + ':' + String(rest).padStart(2, '0');
  }

  function render() {
    listEl.innerHTML = '';
    if (!results.length) {
      listEl.classList.add('hidden');
      emptyEl.classList.remove('hidden');
      emptyEl.textContent = queryEl.value.trim()
        ? '没找到匹配的音效'
        : '输入关键词开始搜索';
      return;
    }
    listEl.classList.remove('hidden');
    emptyEl.classList.add('hidden');

    results.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'row' + (index === activeIndex ? ' active' : '');
      row.dataset.index = String(index);

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = item.filename || '(未命名)';

      const meta = document.createElement('div');
      meta.className = 'meta';
      // 库里没填时长的条目是 0，别显示「0.0 秒」占位置
      meta.textContent = item.duration > 0 ? formatDuration(item.duration) : '';

      row.appendChild(name);
      if (item.format) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = String(item.format).toUpperCase();
        row.appendChild(tag);
      }
      row.appendChild(meta);

      row.addEventListener('mouseenter', () => {
        activeIndex = index;
        paintActive();
      });
      row.addEventListener('click', (event) => {
        // Ctrl/Cmd 点等于「在回声里打开」
        if (event.ctrlKey || event.metaKey) openInApp(item);
        else playItem(item);
      });

      listEl.appendChild(row);
    });

    scrollActiveIntoView();
  }

  function paintActive() {
    const rows = listEl.querySelectorAll('.row');
    rows.forEach((row, index) => {
      row.classList.toggle('active', index === activeIndex);
    });
    scrollActiveIntoView();
  }

  function scrollActiveIntoView() {
    const row = listEl.querySelector('.row.active');
    if (!row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < listEl.scrollTop) listEl.scrollTop = top - 4;
    else if (bottom > listEl.scrollTop + listEl.clientHeight) {
      listEl.scrollTop = bottom - listEl.clientHeight + 4;
    }
  }

  // ---------- 搜索 ----------
  function normalizeResults(payload) {
    const items = (payload && payload.results) || [];
    return items.map((r) => {
      const file = r.audio_file || {};
      return {
        id: file.id || file.file_uuid || '',
        filename: file.filename || '',
        path: file.path || '',
        duration: file.duration || 0,
        format: file.format || '',
        score: r.score || 0
      };
    });
  }

  async function runSearch(rawQuery) {
    const query = String(rawQuery || '').trim();
    if (!query) {
      results = [];
      activeIndex = 0;
      render();
      hintEl.textContent = '';
      return;
    }

    const mySeq = ++seq;
    hintEl.textContent = '搜索中…';
    try {
      const data = await backendPost('/api/v1/search', buildPayload(query));
      if (mySeq !== seq) return;   // 又输新词了，丢弃这次
      results = normalizeResults(data);
      activeIndex = 0;
      hintEl.textContent = results.length ? results.length + ' 条' : '';
      render();
    } catch (error) {
      if (mySeq !== seq) return;
      results = [];
      activeIndex = 0;
      hintEl.textContent = '搜索失败';
      render();
      emptyEl.textContent = '搜索失败：' + (error.message || error);
    }
  }

  function scheduleSearch() {
    clearTimeout(debounceTimer);
    const value = queryEl.value;
    // 输入停顿 130ms 再发，连打一串字只发一次
    debounceTimer = setTimeout(() => runSearch(value), 130);
  }

  // ---------- 动作 ----------
  async function playItem(item) {
    if (!item || !item.path) return;
    try {
      // 走主进程的音频协议，它内部有库根边界校验
      const url = 'soundmind-audio://local/' + encodeURIComponent(item.path);
      if (!audioEl) audioEl = new Audio();
      audioEl.src = url;
      await audioEl.play();
      hintEl.textContent = '▶ ' + (item.filename || '');
    } catch (error) {
      hintEl.textContent = '播放失败：' + (error.message || error);
    }
  }

  async function openInApp(item) {
    if (!item || !item.path) return;
    hintEl.textContent = '正在打开…';
    try {
      await globalSearch.openInMainWindow?.({
        filePath: item.path,
        fileId: item.id
      });
      globalSearch.hide?.();
    } catch (error) {
      hintEl.textContent = '打开失败：' + (error.message || error);
    }
  }

  // ---------- 键盘 ----------
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      queryEl.value = '';
      globalSearch.hide?.();
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!results.length) return;
      activeIndex = (activeIndex + 1) % results.length;
      paintActive();
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!results.length) return;
      activeIndex = (activeIndex - 1 + results.length) % results.length;
      paintActive();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const item = results[activeIndex];
      if (!item) return;
      if (event.ctrlKey || event.metaKey) openInApp(item);
      else playItem(item);
    }
  });

  queryEl.addEventListener('input', () => {
    activeIndex = 0;
    scheduleSearch();
  });

  // 每次被唤起时清空，从干净状态开始
  if (globalSearch.onOpened) {
    globalSearch.onOpened(() => {
      queryEl.value = '';
      results = [];
      activeIndex = 0;
      seq++;
      hintEl.textContent = '';
      render();
      queryEl.focus();
    });
  }

  // 页面加载好先聚焦，免得用户按了快捷键还要再点一下输入框
  window.addEventListener('DOMContentLoaded', () => {
    queryEl.focus();
    render();
  });

  // 让主进程知道这个页面活着，热键唤起时可以安全地发事件
  try { globalSearch.ready?.(); } catch (_error) { /* 忽略 */ }

  window.addEventListener('error', (event) => {
    console.error('[SearchPopup] 未捕获错误:', event.message);
  });
})();
