/* tts-long.js —— 长音频克隆（长文本转语音）
 * 并以「声音克隆」的第二个标签页存在，和短音频克隆共用同一个音色库。
 * 一次十分钟的稿子要跑六分钟，所以做成「起任务 → 轮询进度」。
 */

const ttsLongState = {
    jobId: null,
    timer: null,
    outDir: '',
    filename: '',
};

function _fmtSeconds(sec) {
    const n = Math.max(0, Math.round(Number(sec) || 0));
    const m = Math.floor(n / 60);
    const s = n % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function _fmtBytes(bytes) {
    const n = Number(bytes || 0);
    if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
    if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
    return Math.round(n / 1024) + ' KB';
}

/**
 * 把长音频面板渲染进 container（现在并进「声音克隆」的第二个标签页）。
 * options.profiles —— 克隆那边已加载好的音色列表，直接复用，不再重复请求。
 */
async function renderLongTtsPanel(container, options = {}) {
    if (!container) return;
    if (ttsLongState.timer) { clearInterval(ttsLongState.timer); ttsLongState.timer = null; }
    ttsLongState.jobId = null;
    container.innerHTML = `
        <div class="flex flex-col gap-3">
            <p class="text-[11px] opacity-50 leading-5">
                粘贴整章文字，按 150 字分段生成，边生成边落盘。音色和「短音频克隆」共用同一个音色库。
            </p>

            <div class="rounded-lg p-3" style="border:1px solid var(--border-color)">
                <div class="text-xs font-medium mb-2">① 文本</div>
                <textarea id="longTtsText" rows="7" placeholder="粘贴要念的整段文字…"
                    class="w-full px-2 py-1.5 rounded text-xs resize-y"
                    style="background: var(--bg-tertiary); border:1px solid var(--border-color); color: var(--text-primary);"></textarea>
                <div class="flex items-center gap-2 mt-1.5">
                    <span id="longTtsCount" class="text-[11px] opacity-50">0 字 · 预计 00:00</span>
                    <span class="text-[11px] opacity-35">中文约 5.3 字/秒</span>
                    <button id="longTtsSplitOversize" class="ml-auto px-2 py-0.5 rounded text-[11px] border"
                        style="border-color: var(--border-color);">按 150 字预览分段</button>
                </div>
            </div>

            <div class="rounded-lg p-3" style="border:1px solid var(--border-color)">
                <div class="text-xs font-medium mb-2">② 音色</div>
                <div class="flex items-center gap-2 mb-2">
                    <select id="longTtsVoice" class="flex-1 px-2 py-1 rounded text-xs"
                        style="background: var(--bg-tertiary); border:1px solid var(--border-color); color: var(--text-primary);">
                        <option value="">声音设计（不克隆，按下面的描述构造音色）</option>
                    </select>
                    <span id="longTtsEngine" class="text-[11px] opacity-50"></span>
                </div>
                <input id="longTtsInstruction" class="w-full px-2 py-1 rounded text-xs"
                    placeholder="音色描述，如：低沉男声，语速偏慢，纪录片旁白"
                    style="background: var(--bg-tertiary); border:1px solid var(--border-color); color: var(--text-primary);">
            </div>

            <div class="rounded-lg p-3" style="border:1px solid var(--border-color)">
                <div class="text-xs font-medium mb-2">③ 保存位置</div>
                <div class="flex items-center gap-2">
                    <input id="longTtsDir" class="flex-1 px-2 py-1 rounded text-xs font-mono" readonly
                        style="background: var(--bg-tertiary); border:1px solid var(--border-color); color: var(--text-secondary);">
                    <button id="longTtsPickDir" class="px-2.5 py-1 rounded text-xs border whitespace-nowrap"
                        style="border-color: var(--border-color);">选文件夹…</button>
                </div>
                <div class="flex items-center gap-2 mt-2">
                    <span class="text-[11px] opacity-50 whitespace-nowrap">文件名</span>
                    <input id="longTtsFilename" class="flex-1 px-2 py-1 rounded text-xs"
                        placeholder="留空用时间戳"
                        style="background: var(--bg-tertiary); border:1px solid var(--border-color); color: var(--text-primary);">
                    <span class="text-[11px] opacity-40">.wav</span>
                </div>
                <div id="longTtsDirHint" class="text-[11px] opacity-50 mt-1.5"></div>
            </div>

            <div id="longTtsProgressBox" class="rounded-lg p-3 hidden" style="border:1px solid var(--border-color)">
                <div class="flex items-center justify-between mb-1.5">
                    <span id="longTtsStatusText" class="text-xs">准备中…</span>
                    <span id="longTtsPct" class="text-xs font-mono opacity-70">0%</span>
                </div>
                <div class="h-1.5 rounded-full overflow-hidden" style="background: var(--bg-tertiary)">
                    <div id="longTtsBar" class="h-full transition-all" style="width:0%;background:#8ea7ff"></div>
                </div>
                <div id="longTtsDetail" class="text-[11px] opacity-50 mt-1.5"></div>
            </div>

            <div class="flex items-center gap-2">
                <button id="longTtsStart" class="px-4 py-1.5 rounded-md text-sm text-white"
                    style="background:#3b5bdb">开始生成</button>
                <button id="longTtsCancel" class="px-3 py-1.5 rounded-md text-sm border hidden"
                    style="border-color: var(--border-color);">停止</button>
                <button id="longTtsReveal" class="px-3 py-1.5 rounded-md text-sm border hidden"
                    style="border-color: var(--border-color);">打开所在文件夹</button>
                <span class="text-[11px] opacity-40 ml-auto">生成过程可切换标签页，任务继续跑</span>
            </div>
        </div>`;
    if (window.lucide?.createIcons) window.lucide.createIcons();

    const $ = (id) => container.querySelector('#' + id);
    const textEl = $('longTtsText');
    const countEl = $('longTtsCount');
    const voiceEl = $('longTtsVoice');
    const dirEl = $('longTtsDir');
    const nameEl = $('longTtsFilename');
    const hintEl = $('longTtsDirHint');
    const progressBox = $('longTtsProgressBox');
    const statusEl = $('longTtsStatusText');
    const pctEl = $('longTtsPct');
    const barEl = $('longTtsBar');
    const detailEl = $('longTtsDetail');
    const startBtn = $('longTtsStart');
    const cancelBtn = $('longTtsCancel');
    const revealBtn = $('longTtsReveal');

    // 读默认值：目录 / 音色 / 引擎状态
    try {
        const defaults = await rendererApi.get('/api/v1/tts/long/defaults');
        ttsLongState.outDir = defaults.default_dir || '';
        dirEl.value = ttsLongState.outDir;
        // 后端把 echomind-<profile.id> 反查成用户起的名字后以 {id,name} 返回，
        // 直接用它，别在前端再猜一次（猜不准会显示成 echomind-07e096ecca39）。
        // 同时兼容纯字符串的老返回格式。
        const seenIds = new Set();
        (defaults.voices || []).forEach((v) => {
            const id = String(typeof v === 'string' ? v : (v?.id || ''));
            if (!id || seenIds.has(id)) return;
            seenIds.add(id);
            const label = typeof v === 'string' ? id : String(v?.name || id);
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = label;
            voiceEl.appendChild(opt);
        });
        $('longTtsEngine').textContent = defaults.available
            ? ('本地 Breeze · 每段 ' + (defaults.split_chars || 150) + ' 字')
            : '本地 Breeze 未启动';
        // Breeze 是独立进程，可能这一秒还没起来、过几秒就好了。
        // 以前只在打开面板时判定一次，判定为「未启动」就一直卡着（11-04 反馈）。
        // 现在自动重试 12 次（每 3 秒一次，共 36 秒），期间显示「正在启动」。
        const setEngineState = (ready) => {
            startBtn.disabled = !ready;
            startBtn.style.opacity = ready ? '1' : '0.5';
            if (ready) {
                $('longTtsEngine').textContent = '本地 Breeze · 每段 ' + (defaults.split_chars || 150) + ' 字';
            }
        };
        setEngineState(!!defaults.available);
        if (!defaults.available) {
            hintEl.textContent = '本地语音服务还没起来，正在等它启动…';
            let tries = 0;
            const retry = async () => {
                tries += 1;
                try {
                    const again = await rendererApi.get('/api/v1/tts/long/defaults');
                    if (again && again.available) {
                        defaults.available = true;
                        defaults.split_chars = again.split_chars || defaults.split_chars;
                        setEngineState(true);
                        hintEl.textContent = '本地语音服务已就绪';
                        return;
                    }
                } catch (_) { /* 后端刚启动时接口可能还没通，忽略 */ }
                if (tries < 12) {
                    setTimeout(retry, 3000);
                } else {
                    hintEl.textContent = '本地语音服务没起来。确认 breeze-server.exe 在运行（127.0.0.1:8080），或点下方「重新检测」';
                    const retryBtn = document.createElement('button');
                    retryBtn.className = 'ml-2 px-2 py-0.5 rounded text-[11px] border';
                    retryBtn.style.borderColor = 'var(--border-color)';
                    retryBtn.textContent = '重新检测';
                    retryBtn.addEventListener('click', () => {
                        tries = 0;
                        hintEl.textContent = '正在重新检测…';
                        retry();
                    });
                    hintEl.appendChild(retryBtn);
                }
            };
            setTimeout(retry, 2000);
        }
    } catch (error) {
        hintEl.textContent = '读取默认值失败：' + (error.message || error);
    }

    const refreshCount = () => {
        const chars = (textEl.value || '').trim().length;
        const est = chars / 5.3;
        countEl.textContent = chars + ' 字 · 预计 ' + _fmtSeconds(est);
    };
    textEl.addEventListener('input', refreshCount);
    refreshCount();


    $('longTtsPickDir').addEventListener('click', async () => {
        try {
            const res = await window.electronAPI?.showOpenDialog?.({
                properties: ['openDirectory', 'createDirectory'],
            });
            if (res?.canceled || !res?.filePaths?.length) return;
            const picked = res.filePaths[0];
            const check = await rendererApi.get('/api/v1/tts/long/dir/check?path=' + encodeURIComponent(picked));
            if (!check.usable) {
                hintEl.textContent = '这个目录不能用：' + check.reason;
                return;
            }
            ttsLongState.outDir = picked;
            dirEl.value = picked;
            hintEl.textContent = check.free_bytes
                ? '可写，剩余空间 ' + _fmtBytes(check.free_bytes)
                : '可写';
        } catch (error) {
            hintEl.textContent = '选目录失败：' + (error.message || error);
        }
    });

    $('longTtsSplitOversize').addEventListener('click', () => {
        const chars = (textEl.value || '').trim().length;
        const pieces = Math.max(1, Math.ceil(chars / 150));
        hintEl.textContent = chars + ' 字会切成 ' + pieces + ' 段（每段约 '
            + _fmtSeconds(150 / 5.3) + '），预计总长 ' + _fmtSeconds(chars / 5.3);
    });

    const stopPolling = () => {
        if (ttsLongState.timer) clearInterval(ttsLongState.timer);
        ttsLongState.timer = null;
    };

    const renderJob = (job) => {
        const pct = Number(job.progress || 0);
        barEl.style.width = Math.min(100, pct) + '%';
        pctEl.textContent = pct.toFixed(0) + '%';
        const statusMap = {
            queued: '排队中…',
            running: '生成中…',
            done: '完成',
            failed: '失败',
            cancelled: '已停止',
        };
        statusEl.textContent = statusMap[job.status] || job.status;
        const bits = [];
        if (job.seconds_generated) bits.push('已生成 ' + _fmtSeconds(job.seconds_generated));
        if (job.estimated_seconds) bits.push('预计 ' + _fmtSeconds(job.estimated_seconds));
        if (job.bytes) bits.push(_fmtBytes(job.bytes));
        if (job.elapsed) bits.push('耗时 ' + _fmtSeconds(job.elapsed));
        if (job.error) bits.push(job.error);
        detailEl.textContent = bits.join(' · ');
        if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
            stopPolling();
            startBtn.disabled = false;
            startBtn.style.opacity = '1';
            cancelBtn.classList.add('hidden');
            if (job.status === 'done') {
                revealBtn.classList.remove('hidden');
                revealBtn.dataset.path = job.path || '';
                showNotification('已生成 ' + _fmtSeconds(job.seconds_generated) + ' → ' + (job.path || ''), 'success');
            } else if (job.status === 'failed') {
                showNotification('生成失败: ' + (job.error || ''), 'error');
            }
        }
    };

    const poll = async () => {
        if (!ttsLongState.jobId) return;
        try {
            const data = await rendererApi.get('/api/v1/tts/long/' + ttsLongState.jobId);
            if (data?.job) renderJob(data.job);
        } catch (error) {
            stopPolling();
            statusEl.textContent = '查询进度失败';
            detailEl.textContent = String(error.message || error);
        }
    };

    startBtn.addEventListener('click', async () => {
        const text = (textEl.value || '').trim();
        if (!text) {
            showNotification('先粘贴要念的文字', 'error');
            return;
        }
        startBtn.disabled = true;
        startBtn.style.opacity = '0.5';
        progressBox.classList.remove('hidden');
        revealBtn.classList.add('hidden');
        statusEl.textContent = '提交中…';
        try {
            const res = await rendererApi.post('/api/v1/tts/long', {
                text,
                voice_id: voiceEl.value || '',
                instruction: $('longTtsInstruction').value || '',
                out_dir: ttsLongState.outDir || '',
                filename: (nameEl.value || '').trim(),
            });
            if (!res?.job?.job_id) throw new Error('没有返回任务号');
            ttsLongState.jobId = res.job.job_id;
            renderJob(res.job);
            cancelBtn.classList.remove('hidden');
            stopPolling();
            ttsLongState.timer = setInterval(poll, 1000);
        } catch (error) {
            startBtn.disabled = false;
            startBtn.style.opacity = '1';
            statusEl.textContent = '提交失败';
            detailEl.textContent = String(error.message || error);
            showNotification('提交失败: ' + (error.message || error), 'error');
        }
    });

    cancelBtn.addEventListener('click', async () => {
        if (!ttsLongState.jobId) return;
        try {
            await rendererApi.post('/api/v1/tts/long/' + ttsLongState.jobId + '/cancel', {});
            showNotification('已请求停止，已生成部分会保留', 'info');
        } catch (error) {
            showNotification('停止失败: ' + (error.message || error), 'error');
        }
    });

    revealBtn.addEventListener('click', () => {
        const p = revealBtn.dataset.path;
        if (!p) return;
        // preload 把 revealInExplorer 挂在 electronAPI.fileImport 下
        const api = window.electronAPI;
        const fn = api?.fileImport?.revealInExplorer;
        if (typeof fn === 'function') {
            fn(p);
        } else {
            showNotification('这个版本没有打开文件夹的能力，路径已复制', 'info');
            navigator.clipboard?.writeText(p);
        }
    });
}
