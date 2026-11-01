/* EchoMind PR 面板 —— 自然语言搜音效 → 试听 → 导入到 PR 项目。
 *
 * 全部数据都走本机 127.0.0.1:8000（EchoMind 后端），不联网、不碰云端。
 * 面板本身是明文 JS，所以 DeepSeek 的 Key 留在后端，这里只发一句话。
 */
(function () {
  'use strict';

  var API = 'http://127.0.0.1:8000';
  var PLAYABLE = ['wav', 'mp3', 'flac', 'ogg', 'oga', 'm4a', 'aac', 'aif', 'aiff', 'mp4'];
  var state = { project: 'default', items: [], playingId: null, busy: false, mode: 'term' };

  function loadMode() {
    try {
      var saved = localStorage.getItem('echomind.panelMode');
      if (saved === 'semantic' || saved === 'term') { state.mode = saved; }
    } catch (e) { /* CEP 里 localStorage 可能不可用 */ }
  }

  function applyMode() {
    document.querySelectorAll('#modes .mode').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === state.mode);
    });
  }

  function setMode(mode) {
    state.mode = mode === 'semantic' ? 'semantic' : 'term';
    try { localStorage.setItem('echomind.panelMode', state.mode); } catch (e) { /* ignore */ }
    applyMode();
    toast(state.mode === 'semantic'
      ? '语义模式：和软件里那套一致，第一次搜索可能要 10~30 秒'
      : '精确模式：按字面命中，毫秒级返回');
  }

  function $(id) { return document.getElementById(id); }

  function cepAvailable() {
    return typeof window.__adobe_cep__ !== 'undefined';
  }

  function evalScript(script) {
    return new Promise(function (resolve) {
      if (!cepAvailable()) { resolve('NO_CEP'); return; }
      try {
        window.__adobe_cep__.evalScript(script, function (result) { resolve(result); });
      } catch (e) { resolve('ERROR:' + e); }
    });
  }

  function xhr(method, url, body) {
    return new Promise(function (resolve, reject) {
      var req = new XMLHttpRequest();
      req.open(method, url, true);
      req.timeout = 120000;
      if (body) { req.setRequestHeader('Content-Type', 'application/json'); }
      req.onload = function () {
        var data = null;
        try { data = JSON.parse(req.responseText); } catch (e) { data = null; }
        if (req.status >= 200 && req.status < 300) { resolve(data); }
        else { reject(new Error((data && (data.detail || data.message)) || ('HTTP ' + req.status))); }
      };
      req.onerror = function () { reject(new Error('连不上 EchoMind')); };
      req.ontimeout = function () { reject(new Error('请求超时')); };
      req.send(body ? JSON.stringify(body) : null);
    });
  }

  function setStatus(text, kind) {
    var el = $('status');
    el.textContent = text;
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  var toastTimer = null;
  function toast(text, isError) {
    var el = $('toast');
    if (!el) { return; }
    el.textContent = text;
    el.className = 'toast' + (isError ? ' err' : '');
    if (toastTimer) { clearTimeout(toastTimer); }
    toastTimer = setTimeout(function () { el.textContent = ''; }, 6000);
  }

  function fmtDuration(seconds) {
    var s = Number(seconds || 0);
    if (!s) { return '—'; }
    if (s < 60) { return s.toFixed(1) + 's'; }
    var m = Math.floor(s / 60);
    return m + 'm' + Math.round(s - m * 60) + 's';
  }

  function extOf(item) {
    var name = (item.filename || item.path || '').toLowerCase();
    var dot = name.lastIndexOf('.');
    return dot < 0 ? '' : name.slice(dot + 1);
  }

  // ---------- 启动：探活 + 拉工程列表 ----------
  async function boot() {
    try {
      var health = await xhr('GET', API + '/api/v1/health');
      if (!health || health.status !== 'healthy') { throw new Error('后端未就绪'); }
      setStatus('已连接 · v' + (health.version || '?'), 'ok');
    } catch (e) {
      setStatus('EchoMind 未启动', 'err');
      $('empty').textContent = 'EchoMind 没在运行：先打开 EchoMind 主程序，再回来点搜索。';
      return;
    }
    try {
      var projects = await xhr('GET', API + '/api/v1/projects');
      var list = (projects && projects.projects) || [];
      var select = $('project');
      select.innerHTML = '';
      list.forEach(function (p) {
        var opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name + ' (' + (p.file_count || 0) + ')';
        select.appendChild(opt);
      });
      if (list.length) { state.project = list[0].id; }
      select.value = state.project;
      select.onchange = function () { state.project = select.value; };
    } catch (e) { /* 工程列表拉不到不影响搜索 */ }
  }

  function renderHint(data) {
    var interpreted = data.interpreted || {};
    var parts = [];
    if (interpreted.explain) { parts.push(interpreted.explain); }
    if ((interpreted.keywords || []).length) {
      parts.push('关键词: ' + interpreted.keywords.join(' / '));
    }
    if ((interpreted.tags || []).length) {
      parts.push('标签: ' + interpreted.tags.join(' / '));
    }
    if (interpreted.max_duration) { parts.push('时长 ≤ ' + interpreted.max_duration + 's'); }
    if (interpreted.min_duration) { parts.push('时长 ≥ ' + interpreted.min_duration + 's'); }
    var warn = data.degraded ? '<span class="warn">（AI 未配置或调用失败，已降级为关键词搜索）</span>' : '';
    if (data.mode === 'semantic') {
      parts.push('语义模式');
    } else if (!warn) {
      parts.push('精确模式');
    }
    $('hint').innerHTML = (parts.length ? parts.join(' · ') : '') + warn;
  }

  function makeWave(canvas, peaks) {
    if (!peaks || !peaks.length) { return; }
    var dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    var ctx = canvas.getContext('2d');
    var w = canvas.width, h = canvas.height, mid = h / 2;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#3b82f6';
    var step = Math.max(1, Math.floor(peaks.length / w));
    for (var x = 0; x < w; x++) {
      var peak = peaks[Math.min(peaks.length - 1, x * step)] || 0;
      var bar = Math.max(1, peak * mid);
      ctx.fillRect(x, mid - bar, 1, bar * 2);
    }
  }

  async function loadWaveform(item, canvas) {
    try {
      var data = await xhr('GET', API + '/api/v1/files/' + encodeURIComponent(item.id) +
        '/waveform?project_id=' + encodeURIComponent(state.project));
      makeWave(canvas, (data && data.peaks) || []);
    } catch (e) { /* 波形只是锦上添花 */ }
  }

  // CEP 的 Chromium 有时候不肯直接连 http 音频（file:// 页面 + 媒体元素），
  // 失败时退到「XHR 抓成 Blob 再播」；成功一次就记住，下次直接走 Blob。
  var blobMode = false;
  var transMode = false;
  var lastObjectUrl = null;

  function directPlay(url) {
    return new Promise(function (resolve, reject) {
      var player = $('player');
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) { settled = true; reject('timeout'); }
      }, 4000);
      var onError = function () {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        reject('media error ' + (player.error ? player.error.code : '?'));
      };
      player.addEventListener('error', onError, { once: true });
      player.src = url;
      player.load();
      var attempt = player.play();
      if (!attempt || !attempt.then) {
        settled = true; clearTimeout(timer); resolve(); return;
      }
      attempt.then(function () {
        if (settled) { return; }
        settled = true; clearTimeout(timer); resolve();
      }).catch(function (err) {
        if (settled) { return; }
        settled = true; clearTimeout(timer);
        reject((err && (err.name || err.message)) || 'play rejected');
      });
    });
  }

  // CEP 里最可靠的一条：用面板自带的 Node 直接读文件，做成 Blob 交给 <audio>。
  // 既绕开 http 媒体策略，也绕开非 ASCII 路径问题。
  function nodePlay(path, mime) {
    return new Promise(function (resolve, reject) {
      var node = window.cep_node;
      if (!node || !path) { reject('没有 Node 权限'); return; }
      try {
        var fs = node.require('fs');
        var buf = fs.readFileSync(path);
        var bytes = new Uint8Array(buf.length);
        for (var i = 0; i < buf.length; i++) { bytes[i] = buf[i]; }
        if (lastObjectUrl) { URL.revokeObjectURL(lastObjectUrl); }
        lastObjectUrl = URL.createObjectURL(new Blob([bytes], { type: mime || 'audio/wav' }));
        var player = $('player');
        player.src = lastObjectUrl;
        player.play().then(resolve).catch(function (e) {
          reject('decode: ' + ((e && e.name) || 'play rejected'));
        });
      } catch (e) {
        reject('fs: ' + e);
      }
    });
  }

  function blobPlay(url, mime) {
    return new Promise(function (resolve, reject) {
      var req = new XMLHttpRequest();
      req.open('GET', url, true);
      req.responseType = 'arraybuffer';
      req.timeout = 30000;
      req.onload = function () {
        if (req.status < 200 || req.status >= 300) { reject('HTTP ' + req.status); return; }
        try {
          if (lastObjectUrl) { URL.revokeObjectURL(lastObjectUrl); }
          lastObjectUrl = URL.createObjectURL(new Blob([req.response], { type: mime || 'audio/wav' }));
          var player = $('player');
          player.src = lastObjectUrl;
          player.play().then(resolve).catch(function (e) { reject((e && e.name) || 'play rejected'); });
        } catch (e) { reject('blob: ' + e); }
      };
      req.onerror = function () { reject('XHR 失败'); };
      req.ontimeout = function () { reject('XHR 超时'); };
      req.send();
    });
  }

  function preview(item, rowEl) {
    var player = $('player');
    if (state.playingId === item.id) { player.pause(); state.playingId = null; return; }
    var ext = extOf(item);
    if (PLAYABLE.indexOf(ext) < 0) {
      toast(ext.toUpperCase() + ' 面板放不了，请回 EchoMind 试听', true);
      return;
    }
    var url = API + '/api/v1/files/' + encodeURIComponent(item.id) + '/audio?project_id=' +
      encodeURIComponent(state.project);
    var mime = 'audio/' + (ext === 'mp3' ? 'mpeg' : ext);
    state.playingId = item.id;
    document.querySelectorAll('.item.playing').forEach(function (n) { n.classList.remove('playing'); });
    if (rowEl) { rowEl.classList.add('playing'); }

    // 依次尝试，前一个失败才走下一个：
    //   1. CEP 里用 Node 直读（绕开 http 策略）
    //   2. 原始文件直连
    //   3. 后端转成 PCM WAV 再直连（IMA ADPCM / 浮点 WAV 浏览器解不了，靠这条）
    //   4. 转码结果抓成 Blob 再播
    var transUrl = url + '&transcode=1';
    var attempts = [];
    if (window.cep_node && item.path) {
      attempts.push(function () { return nodePlay(item.path, mime); });
    }
    if (!transMode) {
      attempts.push(function () { return directPlay(url); });
    }
    attempts.push(function () {
      transMode = true;
      return directPlay(transUrl).catch(function () { return blobPlay(transUrl, 'audio/wav'); });
    });

    var chain = attempts[0]();
    var errors = [];
    attempts.slice(1).forEach(function (next) {
      chain = chain.catch(function (err) {
        errors.push(String(err));
        return next();
      });
    });
    chain = chain.catch(function (err) {
      errors.push(String(err));
      throw new Error(errors.join(' / '));
    });
    chain.catch(function (err) {
      state.playingId = null;
      toast('播放失败（' + (err && err.message ? err.message : err) + '），可用「复制路径」在别的播放器里听', true);
    });
  }

  async function importToProject(item) {
    var path = (item.path || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    var result = await evalScript('EchoMindImport("' + path + '")');
    if (result === 'OK') {
      toast('已导入项目面板：' + item.filename);
    } else if (result === 'NO_PROJECT') {
      toast('PR 里还没有打开项目，先新建/打开一个再导入', true);
    } else if (result === 'NO_CEP') {
      toast('不在 PR 里运行，无法导入（浏览器预览模式）', true);
    } else {
      toast('导入失败：' + result, true);
    }
  }

  function copyPath(item) {
    var text = item.path || '';
    try {
      if (cepAvailable() && window.cep && window.cep.util) { window.cep.util.copyToClipboard(text); }
      else { navigator.clipboard.writeText(text); }
      toast('已复制路径：' + text);
    } catch (e) { toast(text, true); }
  }

  function render(data) {
    var box = $('results');
    box.innerHTML = '';
    state.items = (data && data.results) || [];
    if (!state.items.length) {
      box.innerHTML = '<div class="empty">没搜到。换个说法，或者去掉「短一点」这类限制再试。</div>';
      return;
    }
    state.items.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'item';

      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = item.filename || item.path;
      name.title = item.path || '';

      var meta = document.createElement('div');
      meta.className = 'meta';
      var bits = [fmtDuration(item.duration), (item.format || extOf(item)).toUpperCase()];
      if (item.sample_rate) { bits.push(item.sample_rate + 'Hz'); }
      var terms = item.matched_terms || [];
      if (terms.length) {
        // 词命中的分数是「相对最高分」的，并列第一时都是 100%，写出来是误导；
        // 直接显示命中了哪些词更有用。
        bits.push('命中 ' + terms.slice(0, 4).join('/'));
      } else if (item.score) {
        bits.push('相似 ' + Math.round(item.score * 100) + '%');
      }
      bits.forEach(function (bit) {
        var span = document.createElement('span');
        span.textContent = bit;
        meta.appendChild(span);
      });
      (item.tags || []).slice(0, 5).forEach(function (tag) {
        var chip = document.createElement('span');
        chip.className = 'tagchip';
        chip.textContent = tag;
        meta.appendChild(chip);
      });

      row.appendChild(name);
      row.appendChild(meta);

      if (item.description) {
        var desc = document.createElement('div');
        desc.className = 'desc';
        desc.textContent = item.description;
        row.appendChild(desc);
      }

      var canvas = document.createElement('canvas');
      canvas.className = 'wave';
      row.appendChild(canvas);

      var acts = document.createElement('div');
      acts.className = 'acts';
      var playBtn = document.createElement('button');
      playBtn.textContent = '试听';
      playBtn.onclick = function () { preview(item, row); };
      var importBtn = document.createElement('button');
      importBtn.className = 'main';
      importBtn.textContent = '导入到项目';
      importBtn.onclick = function () { importToProject(item); };
      var copyBtn = document.createElement('button');
      copyBtn.textContent = '复制路径';
      copyBtn.onclick = function () { copyPath(item); };
      acts.appendChild(playBtn);
      acts.appendChild(importBtn);
      acts.appendChild(copyBtn);
      row.appendChild(acts);

      box.appendChild(row);
      if (item.id) { loadWaveform(item, canvas); }
    });
  }

  async function search() {
    if (state.busy) { return; }
    var query = ($('query').value || '').trim();
    if (!query) { $('query').focus(); return; }
    state.busy = true;
    $('go').disabled = true;
    setStatus(state.mode === 'semantic' ? '语义搜索中…（首次可能 10~30 秒）' : '搜索中…');
    $('hint').textContent = '';
    try {
      var data = await xhr('POST', API + '/api/v1/ai/nl-search', {
        query: query,
        project_id: state.project,
        limit: 30,
        mode: state.mode,
      });
      render(data);
      renderHint(data);
      setStatus('找到 ' + ((data.results || []).length) + ' 条', 'ok');
    } catch (e) {
      setStatus('搜索失败', 'err');
      $('hint').innerHTML = '<span class="warn">' + e.message + '</span>';
    } finally {
      state.busy = false;
      $('go').disabled = false;
    }
  }

  document.querySelectorAll('#modes .mode').forEach(function (btn) {
    btn.onclick = function () { setMode(btn.getAttribute('data-mode')); };
  });

  $('go').onclick = search;
  $('clear').onclick = function () {
    $('query').value = '';
    $('hint').textContent = '';
    $('results').innerHTML = '<div class="empty">输入一句话，回车即可。</div>';
  };
  $('query').addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { search(); }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); search(); }
  });

  loadMode();
  applyMode();
  boot();
})();