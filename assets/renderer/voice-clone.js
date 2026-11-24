/* voice-clone.js —— 声音克隆
 * 从 index.html 原样搬出的完整顶层函数。
 */
async function loadVoiceProfiles() {
    try {
        const data = await rendererApi.get('/api/v1/voice/profiles');
        voiceState.profiles = Array.isArray(data?.profiles) ? data.profiles : [];
        if (!voiceState.speakerId && voiceState.profiles.length) {
            voiceState.speakerId = voiceState.profiles[0].speaker_id;
        }
    } catch (error) {
        console.warn('[Voice] 读取音色失败:', error);
        voiceState.profiles = [];
    }
    return voiceState.profiles;
}

function showVoiceCloneModal(options = {}) {
    document.getElementById('voiceCloneOverlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'voiceCloneOverlay';
    overlay.className = 'fixed inset-0 flex items-center justify-center';
    overlay.style.cssText = 'z-index:330;background:rgba(0,0,0,0.6)';
    overlay.innerHTML = [
        "                <div class=\"rounded-xl shadow-2xl w-[560px] max-h-[86vh] overflow-y-auto p-5 flex flex-col gap-3\"",
        "                     style=\"background: var(--bg-secondary); border: 1px solid var(--border-color);\">",
        "                    <div class=\"flex items-center gap-2\">",
        "                        <span class=\"w-7 h-7 rounded-lg flex items-center justify-center\" style=\"background: rgba(107,138,253,0.22);\">",
        "                            <span style=\"font-size:11px;font-weight:700;color:#8ea7ff\">声</span>",
        "                        </span>",
        "                        <div class=\"flex flex-col leading-tight\">",
        "                            <span class=\"text-sm font-semibold\">声音克隆</span>",
        "                            <span class=\"text-[11px] opacity-50\">选一段约 15 秒人声 → 复刻音色 → 输入台词生成语音</span>",
        "                        </div>",
        "                        <button id=\"voiceCloseBtn\" class=\"ml-auto text-xs opacity-50 hover:opacity-100\">关闭</button>",
        "                    </div>",
        "                    <div class=\"flex items-center gap-1 p-1 rounded-lg\" style=\"background:var(--bg-tertiary)\">",
        "                        <button id=\"voiceTabShort\" class=\"flex-1 px-3 py-1.5 rounded-md text-xs font-medium\" style=\"background:var(--accent-color,#6b8afd);color:#fff\">短音频克隆</button>",
        "                        <button id=\"voiceTabLong\" class=\"flex-1 px-3 py-1.5 rounded-md text-xs font-medium\" style=\"color:var(--text-secondary)\">长音频克隆</button>",
        "                    </div>",
        "                    <div id=\"voiceShortPane\" class=\"flex flex-col gap-3\">",
        "                    <div class=\"rounded-lg p-3\" style=\"border:1px solid var(--border-color)\">",
        "                        <div class=\"text-xs font-medium mb-2\">① 选择样音</div>",
        "                        <div class=\"flex items-center gap-2 mb-2\">",
        "                            <span class=\"text-[11px] opacity-50\">合成引擎</span>",
        "                            <select id=\"voiceEngineSelect\" class=\"px-2 py-1 rounded text-xs\" style=\"background:var(--bg-tertiary);border:1px solid var(--border-color);color:var(--text-primary)\">",
        "                                <option value=\"breeze\">本地 Breeze TTS 2（离线）</option>",
        "                                <option value=\"voicestudio\">本地 VoiceStudio（OmniVoice）</option>",
        "                                <option value=\"volc\">豆包云端（需 API Key）</option>",
        "                            </select>",
        "                        </div>",
        "                        <div id=\"voiceRefTextBox\" class=\"flex items-center gap-2 mb-2\">",
        "                            <span class=\"text-[11px] opacity-50\">样音文稿</span>",
        "                            <textarea id=\"voiceRefTextInput\" rows=\"2\" class=\"flex-1 px-2 py-1 rounded text-xs\" style=\"background:var(--bg-tertiary);border:1px solid var(--border-color);color:var(--text-primary);resize:vertical\" placeholder=\"这段样音里说的原话（本地克隆必需，要完整）\"></textarea>",
        "                        </div>",
        "                        <div class=\"flex items-center gap-2\">",
        "                            <button id=\"voicePickFileBtn\" class=\"px-3 py-1 rounded text-xs border\" style=\"border-color:var(--border-color)\">选择音频文件…</button>",
        "                            <button id=\"voiceUseCurrentBtn\" class=\"px-3 py-1 rounded text-xs border\" style=\"border-color:var(--border-color)\">用列表里选中的音效</button>",
        "                            <span id=\"voiceSampleInfo\" class=\"text-[11px] opacity-55 truncate\"></span>",
        "                        </div>",
        "                        <div class=\"flex items-center gap-2 mt-2\">",
        "                            <span class=\"text-[11px] opacity-50\">音色名称</span>",
        "                            <input id=\"voiceNameInput\" class=\"flex-1 px-2 py-1 rounded text-xs\" style=\"background:var(--bg-tertiary);border:1px solid var(--border-color);color:var(--text-primary)\" placeholder=\"例如：我的声音\">",
        "                        </div>",
        "                    </div>",
        "                    <div class=\"rounded-lg p-3\" style=\"border:1px solid var(--border-color)\">",
        "                        <div class=\"flex items-center gap-2 mb-2\">",
        "                            <span class=\"text-xs font-medium\">② 克隆音色</span>",
        "                            <button id=\"voiceLibOpenBtn\" class=\"ml-auto text-[11px] opacity-60 hover:opacity-100\">管理音色库</button>",
        "                        </div>",
        "                        <div class=\"flex items-center gap-2\">",
        "                            <button id=\"voiceCloneRunBtn\" class=\"px-3 py-1.5 rounded text-xs font-medium\" style=\"background:#3b82f6;color:#fff\">开始克隆</button>",
        "                            <span id=\"voiceCloneStatus\" class=\"text-[11px] opacity-55\"></span>",
        "                        </div>",
        "                        <div id=\"voiceProfileList\" class=\"mt-2 flex flex-col gap-1\"></div>",
        "                    </div>",
        "                    <div class=\"rounded-lg p-3\" style=\"border:1px solid var(--border-color)\">",
        "                        <div class=\"flex items-center gap-2 mb-2\">",
        "                            <span class=\"text-xs font-medium\">③ 用这个音色说话</span>",
        "                            <span class=\"text-[11px] opacity-45 ml-auto\">输出</span>",
        "                            <select id=\"voiceFormatSelect\" class=\"px-2 py-0.5 rounded text-[11px]\" style=\"background:var(--bg-tertiary);border:1px solid var(--border-color);color:var(--text-primary)\">",
        "                                <option value=\"1-24000\">单声道 24 kHz</option>",
        "                                <option value=\"2-24000\">双声道 24 kHz</option>",
        "                                <option value=\"2-48000\">双声道 48 kHz</option>",
        "                                <option value=\"1-48000\">单声道 48 kHz</option>",
        "                            </select>",
        "                        </div>",
        "                        <textarea id=\"voiceTextInput\" rows=\"3\" class=\"w-full px-2 py-1 rounded text-xs\" style=\"background:var(--bg-tertiary);border:1px solid var(--border-color);color:var(--text-primary)\" placeholder=\"输入要念的台词，例如：欢迎使用回声音效库\"></textarea>",
        "                        <div id=\"voiceSpeakProgressWrap\" class=\"mt-2\" style=\"display:none\">",
        "                            <div style=\"height:6px;border-radius:999px;background:var(--bg-tertiary);overflow:hidden;border:1px solid var(--border-color)\">",
        "                                <div id=\"voiceSpeakProgressFill\" style=\"height:100%;width:2%;background:linear-gradient(90deg,#3b82f6,#60a5fa);transition:width .35s ease-out\"></div>",
        "                            </div>",
        "                            <div id=\"voiceSpeakProgressText\" class=\"text-[11px] opacity-55 mt-1\">合成中…</div>",
        "                        </div>",
        "                        <div class=\"flex items-center gap-2 mt-2\">",
        "                            <button id=\"voicePlayBtn\" class=\"px-3 py-1.5 rounded text-xs border\" style=\"border-color:var(--border-color)\" disabled>试听</button>",
        "                            <button id=\"voiceSaveBtn\" class=\"px-3 py-1.5 rounded text-xs border\" style=\"border-color:var(--border-color)\" disabled>导出音频…</button>",
        "                            <button id=\"voiceToLibBtn\" class=\"px-3 py-1.5 rounded text-xs border\" style=\"border-color:var(--border-color)\" disabled>保存到音效库</button>",
        "                            <button id=\"voiceSpeakBtn\" class=\"px-3 py-1.5 rounded text-xs font-medium\" style=\"background:#3b82f6;color:#fff\">生成语音</button>",
        "                            <span id=\"voiceSpeakStatus\" class=\"text-[11px] opacity-55\"></span>",
        "                        </div>",
        "                    </div>",
        "                    </div>",
        "                    <div id=\"voiceLongPane\" class=\"hidden\"></div>",
        "                </div>"
    ].join('');
    document.body.appendChild(overlay);
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) overlay.remove(); });
    overlay.querySelector('#voiceCloseBtn').addEventListener('click', () => overlay.remove());

    // ===== 两个模式共用一个音色库（voiceState.profiles），只是承接的文本长度不同 =====
    const shortPane = overlay.querySelector('#voiceShortPane');
    const longPane = overlay.querySelector('#voiceLongPane');
    const tabShort = overlay.querySelector('#voiceTabShort');
    const tabLong = overlay.querySelector('#voiceTabLong');
    let activeTab = 'short';
    const setTab = (tab) => {
        activeTab = tab;
        const isShort = tab === 'short';
        shortPane?.classList.toggle('hidden', !isShort);
        longPane?.classList.toggle('hidden', isShort);
        const on = 'background:var(--accent-color,#6b8afd);color:#fff';
        const off = 'color:var(--text-secondary)';
        if (tabShort) tabShort.style.cssText = isShort ? on : off;
        if (tabLong) tabLong.style.cssText = isShort ? off : on;
        // 长文本面板按需挂载：每次切过去重建，避免它和短音频那套状态互相干扰
        if (!isShort && typeof renderLongTtsPanel === 'function' && longPane) {
            renderLongTtsPanel(longPane, { profiles: voiceState.profiles });
        }
    };
    tabShort?.addEventListener('click', () => setTab('short'));
    tabLong?.addEventListener('click', () => setTab('long'));
    // 从音色库的「长文本转语音」进来，直接落在长音频页
    if (options?.tab === 'long') setTab('long');

    const sampleInfo = overlay.querySelector('#voiceSampleInfo');
    const nameInput = overlay.querySelector('#voiceNameInput');
    const statusEl = overlay.querySelector('#voiceCloneStatus');
    const speakStatus = overlay.querySelector('#voiceSpeakStatus');

    const useSample = (path, duration) => {
        voiceState.samplePath = path;
        voiceState.sampleDuration = Number(duration) || 0;
        const name = String(path || '').split(/[\\/]/).pop();
        sampleInfo.textContent = name + (voiceState.sampleDuration ? ' · ' + voiceState.sampleDuration.toFixed(1) + 's' : '');
        if (!nameInput.value) nameInput.value = name.replace(/\.[^.]+$/, '').slice(0, 20);
    };

    overlay.querySelector('#voicePickFileBtn').addEventListener('click', async () => {
        try {
            // preload 暴露的是 dialogs.showOpenDialog（不是 dialog.openFile）
            const picked = await window.electronAPI?.dialogs?.showOpenDialog?.({
                title: '选择一段约 15 秒的人声',
                properties: ['openFile'],
                filters: [{ name: '音频', extensions: ['wav', 'mp3', 'flac', 'm4a', 'ogg', 'caf', 'aiff'] }],
            });
            const filePath = picked?.filePaths?.[0] || picked?.filePath || '';
            if (!filePath) return;
            useSample(String(filePath), 0);
        } catch (error) {
            showNotification('选择文件失败: ' + (error?.message || error), 'error');
        }
    });

    overlay.querySelector('#voiceUseCurrentBtn').addEventListener('click', () => {
        if (!currentSound?.filePath) { showNotification('先在列表里选一个音效', 'info'); return; }
        const duration = Number(currentSound.duration) > 1000 ? Number(currentSound.duration) / 1000 : Number(currentSound.duration) || 0;
        useSample(currentSound.filePath, duration);
    });

    const renderProfiles = () => {
        const host = overlay.querySelector('#voiceProfileList');
        host.innerHTML = '';
        if (!voiceState.profiles.length) {
            host.innerHTML = '<div class="text-[11px] opacity-40">还没有克隆过音色</div>';
            return;
        }
        voiceState.profiles.forEach((profile) => {
            const row = document.createElement('div');
            row.className = 'flex items-center gap-2 text-[11px] px-2 py-1 rounded';
            const isActive = String(profile.id) === String(voiceState.profileId);
            row.style.cssText = 'border:1px solid ' + (isActive ? 'var(--accent-color,#6b8afd)' : 'var(--border-color)');
            const label = document.createElement('span');
            label.textContent = profile.name || '未命名';
            label.style.color = 'var(--text-primary)';
            const meta = document.createElement('span');
            meta.className = 'opacity-45';
            const providerName = String(profile.provider || '');
            meta.textContent = providerName === 'breeze'
                ? '本地·Breeze'
                : (providerName === 'voicestudio' ? '本地·VoiceStudio' : '云端·豆包');
            if (providerName === 'breeze' && !String(profile.ref_text || '').trim()) {
                meta.textContent += ' · 缺文稿';
                meta.title = 'Breeze 必须知道样音说的原话才能复刻，点右边的「补文稿」';
            }
            const pick = document.createElement('button');
            pick.className = 'ml-auto opacity-60 hover:opacity-100';
            pick.textContent = isActive ? '使用中' : '使用';
            pick.addEventListener('click', () => {
                voiceState.speakerId = profile.speaker_id || '';
                voiceState.profileId = profile.id || '';
                voiceState.provider = profile.provider || 'volc';
                renderProfiles();
                speakStatus.textContent = '已选：' + (profile.name || '未命名');
            });
            const del = document.createElement('button');
            del.className = 'opacity-40 hover:opacity-100';
            del.textContent = '删除';
            del.addEventListener('click', async () => {
                try {
                    await rendererApi.delete('/api/v1/voice/profiles/' + encodeURIComponent(profile.id));
                    await loadVoiceProfiles();
                    renderProfiles();
                } catch (error) {
                    showNotification('删除失败: ' + (error?.message || error), 'error');
                }
            });
            const fill = document.createElement('button');
            const needsRefText = providerName === 'breeze' && !String(profile.ref_text || '').trim();
            fill.className = 'opacity-60 hover:opacity-100';
            fill.textContent = needsRefText ? '补文稿' : '';
            fill.style.display = needsRefText ? '' : 'none';
            fill.addEventListener('click', async (event) => {
                event.stopPropagation();
                const text = window.prompt('这段样音里说的原话是什么？（Breeze 靠它复刻音色）', '');
                if (!text || !text.trim()) return;
                try {
                    await rendererApi.patch('/api/v1/voice/profiles/' + encodeURIComponent(profile.id), {
                        ref_text: text.trim(),
                    }, { timeoutMs: 30000 });
                    await loadVoiceProfiles();
                    renderProfiles();
                    showNotification('已补上文稿，现在可以生成了', 'success');
                } catch (error) {
                    showNotification('补文稿失败: ' + (error?.message || error), 'error');
                }
            });
            row.appendChild(label); row.appendChild(meta); row.appendChild(fill); row.appendChild(pick); row.appendChild(del);
            host.appendChild(row);
        });
    };

    overlay.querySelector('#voiceCloneRunBtn').addEventListener('click', async () => {
        if (!voiceState.samplePath) { showNotification('先选一段样音', 'info'); return; }
        statusEl.textContent = '正在上传样音并复刻…';
        try {
            const engine = overlay.querySelector('#voiceEngineSelect')?.value || 'breeze';
            const refText = overlay.querySelector('#voiceRefTextInput')?.value.trim() || '';
            if (engine === 'breeze' && !refText) {
                statusEl.textContent = '';
                showNotification('本地 Breeze 克隆需要填写样音里说的原话', 'info');
                return;
            }
            if (engine === 'voicestudio') {
                statusEl.textContent = '推给 VoiceStudio 建档案…（它要开着）';
            }
            const result = await rendererApi.post('/api/v1/voice/clone', {
                path: voiceState.samplePath,
                name: nameInput.value.trim() || '我的音色',
                duration: voiceState.sampleDuration || 0,
                provider: engine,
                ref_text: refText,
            }, { timeoutMs: 240000 });
            voiceState.speakerId = result?.speaker_id || '';
            voiceState.profileId = result?.profile?.id || '';
            voiceState.provider = result?.profile?.provider || 'volc';
            const providerLabel = voiceState.provider === 'breeze'
                ? '（本地 Breeze）'
                : (voiceState.provider === 'voicestudio' ? '（本地 VoiceStudio）' : '（云端）');
            statusEl.textContent = '已登记：' + (result?.profile?.name || '') + providerLabel;
            await loadVoiceProfiles();
            renderProfiles();
        } catch (error) {
            statusEl.textContent = '';
            showNotification(error?.message || String(error), 'error');
        }
    });

    // ===== 合成进度条 =====
    // 合成是一个阻塞请求，没有逐帧进度可拿，所以别装成"精确百分比"：
    // 按文字长度和引擎速度估一条曲线，先快步到 55%，之后慢慢爬到 92% 等结果；
    // 请求返回时直接补到 100%。VoiceStudio 首次调用还要加载模型，单独提示。
    const progressUi = {
        wrap: overlay.querySelector('#voiceSpeakProgressWrap'),
        fill: overlay.querySelector('#voiceSpeakProgressFill'),
        text: overlay.querySelector('#voiceSpeakProgressText'),
        timer: null,
        startedAt: 0,
        estimateMs: 6000,
    };
    const setProgress = (percent, label) => {
        if (progressUi.fill) progressUi.fill.style.width = Math.max(2, Math.min(100, percent)) + '%';
        if (label && progressUi.text) progressUi.text.textContent = label;
    };
    const stopProgress = () => {
        if (progressUi.timer) { clearInterval(progressUi.timer); progressUi.timer = null; }
    };
    const startProgress = (engine, charCount) => {
        if (!progressUi.wrap) return;
        // 粗估：Breeze 约 12 字/秒；VoiceStudio 首次含加载模型，给 40 秒底
        const perChar = engine === 'voicestudio' ? 260 : 85;
        progressUi.estimateMs = Math.max(3000, Math.min(180000, charCount * perChar));
        progressUi.startedAt = Date.now();
        progressUi.wrap.style.display = '';
        setProgress(2, '合成中… 0.0s');
        stopProgress();
        progressUi.timer = setInterval(() => {
            const elapsed = Date.now() - progressUi.startedAt;
            const ratio = elapsed / progressUi.estimateMs;
            let percent;
            if (ratio <= 1) {
                percent = 2 + ratio * 53;                     // 0~1 倍估时：走到 55%
            } else {
                percent = 55 + Math.min(37, Math.log(ratio) * 20);  // 超出估时：爬到 92%
            }
            const secs = (elapsed / 1000).toFixed(1);
            const hint = engine === 'voicestudio' && elapsed > 20000
                ? '（VoiceStudio 首次调用在加载模型，慢是正常的）'
                : '';
            setProgress(percent, '合成中… ' + secs + 's' + hint);
        }, 250);
    };
    const finishProgress = (ok, message) => {
        stopProgress();
        if (!progressUi.wrap) return;
        if (ok) {
            setProgress(100, message || '完成');
            setTimeout(() => { if (progressUi.wrap) progressUi.wrap.style.display = 'none'; }, 900);
        } else {
            setProgress(100, message || '失败');
            if (progressUi.fill) progressUi.fill.style.background = '#ef4444';
            setTimeout(() => {
                if (progressUi.wrap) progressUi.wrap.style.display = 'none';
                if (progressUi.fill) progressUi.fill.style.background = 'linear-gradient(90deg,#3b82f6,#60a5fa)';
                setProgress(2, '');
            }, 1800);
        }
    };

    overlay.querySelector('#voiceSpeakBtn').addEventListener('click', async () => {
        const text = overlay.querySelector('#voiceTextInput').value.trim();
        if (!text) { showNotification('先输入要念的台词', 'info'); return; }
        // 本地 Breeze 音色没有 speaker_id，必须用 profileId 判断
        if (!voiceState.profileId && !voiceState.speakerId) { showNotification('先选一个音色（或先克隆一个）', 'info'); return; }
        speakStatus.textContent = '正在合成…';
        const engineForProgress = overlay.querySelector('#voiceEngineSelect')?.value || '';
        startProgress(engineForProgress, text.length);
        try {
            const fmt = (overlay.querySelector('#voiceFormatSelect')?.value || '1-24000').split('-');
            const engine = engineForProgress;
            const callSpeak = () => rendererApi.post('/api/v1/voice/speak', {
                text,
                speaker_id: voiceState.speakerId || '',
                profile_id: voiceState.profileId || '',
                engine,
                channels: Number(fmt[0]) || 1,
                sample_rate: Number(fmt[1]) || 24000,
            }, { timeoutMs: 600000 });
            let result;
            try {
                result = await callSpeak();
            } catch (firstError) {
                // Breeze 缺样音文稿：别再静默用默认声音，当场让用户补上再重试
                if (firstError?.code === 'voice_ref_text_missing' && voiceState.profileId) {
                    const text = window.prompt('这个音色还没有「样音文稿」，Breeze 会用默认声音。这段样音里说的原话是什么？', '');
                    if (text && text.trim()) {
                        await rendererApi.patch('/api/v1/voice/profiles/' + encodeURIComponent(voiceState.profileId), {
                            ref_text: text.trim(),
                        }, { timeoutMs: 30000 });
                        await loadVoiceProfiles();
                        result = await callSpeak();
                    } else {
                        throw firstError;
                    }
                } else {
                    throw firstError;
                }
            }
            voiceState.lastOutput = result?.path || '';
            const elapsedSecs = ((Date.now() - progressUi.startedAt) / 1000).toFixed(1);
            finishProgress(true, '完成 · ' + elapsedSecs + 's');
            speakStatus.textContent = '已生成：' + String(result?.path || '').split(/[\\/]/).pop();
            const playBtnEl = overlay.querySelector('#voicePlayBtn');
            const saveBtnEl = overlay.querySelector('#voiceSaveBtn');
            const toLibBtnEl = overlay.querySelector('#voiceToLibBtn');
            if (voiceState.lastOutput) {
                if (playBtnEl) playBtnEl.disabled = false;
                if (saveBtnEl) saveBtnEl.disabled = false;
                if (toLibBtnEl) toLibBtnEl.disabled = false;
                if (!audioPlayer) initAudioPlayer();
                audioPlayer.src = 'soundmind-audio://local/' + encodeURIComponent(voiceState.lastOutput);
                audioPlayer.load();
                await audioPlayer.play().catch(() => { });
                isPlaying = true;
            }
        } catch (error) {
            speakStatus.textContent = '';
            finishProgress(false, '失败：' + (error?.message || String(error)).slice(0, 40));
            showNotification(error?.message || String(error), 'error');
        }
    });

    overlay.querySelector('#voicePlayBtn').addEventListener('click', async () => {
        if (!voiceState.lastOutput) return;
        try {
            if (!audioPlayer) initAudioPlayer();
            audioPlayer.src = 'soundmind-audio://local/' + encodeURIComponent(voiceState.lastOutput);
            audioPlayer.load();
            await audioPlayer.play();
            isPlaying = true;
        } catch (error) {
            showNotification('播放失败: ' + (error?.message || error), 'error');
        }
    });

    // 导出目录记住上次选的，下次直接落在那里（11-24 反馈：每次都要重新点进去）
    const EXPORT_DIR_KEY = 'echomind.voice.exportDir';
    const lastExportDir = () => {
        try { return localStorage.getItem(EXPORT_DIR_KEY) || ''; } catch (_) { return ''; }
    };
    const rememberExportDir = (filePath) => {
        try {
            const idx = String(filePath || '').lastIndexOf('\\');
            if (idx > 2) localStorage.setItem(EXPORT_DIR_KEY, filePath.slice(0, idx));
        } catch (_) { }
    };
    const stampName = () => {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return '克隆_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    };
    const revealFile = (filePath) => {
        try { window.electronAPI?.fileImport?.revealInExplorer?.(filePath); } catch (_) { }
    };

    // 导出音频…：存到用户自己选的任意目录（后端不做素材库范围校验）
    overlay.querySelector('#voiceSaveBtn').addEventListener('click', async () => {
        if (!voiceState.lastOutput) return;
        const baseName = (nameInput.value.trim() || stampName()) + '_' + stampName().slice(3);
        const dir = lastExportDir();
        try {
            const picked = await window.electronAPI?.dialogs?.showSaveDialog?.({
                title: '导出音频',
                defaultPath: (dir ? dir + '\\' : '') + baseName.replace(/[\\/:*?"<>|]/g, '_') + '.wav',
                filters: [{ name: 'WAV 音频', extensions: ['wav'] }],
            });
            const target = picked?.filePath || '';
            if (!target) return;   // 用户取消：不写文件、不报错
            speakStatus.textContent = '导出中…';
            const res = await rendererApi.post('/api/v1/voice/export', {
                source: voiceState.lastOutput,
                destination: target,
                overwrite: true,
            }, { timeoutMs: 120000 });
            const saved = res?.path || target;
            rememberExportDir(saved);
            speakStatus.textContent = '已导出：' + String(saved).split(/[\\/]/).pop();
            speakStatus.title = saved;
            showNotification('已导出到 ' + saved, 'success');
            revealFile(saved);
        } catch (error) {
            speakStatus.textContent = '';
            showNotification('导出失败: ' + (error?.message || error), 'error');
        }
    });

    // 保存到音效库：先把缓存文件复制进库，再走正常入库（不再拿 tts_cache 路径硬过校验）
    overlay.querySelector('#voiceToLibBtn').addEventListener('click', async () => {
        if (!voiceState.lastOutput) return;
        const btn = overlay.querySelector('#voiceToLibBtn');
        try {
            if (btn) btn.disabled = true;
            speakStatus.textContent = '保存到音效库…';
            const res = await rendererApi.post('/api/v1/voice/save-to-library', {
                source: voiceState.lastOutput,
                folder: '克隆语音',
            }, { timeoutMs: 120000 });
            const saved = res?.path || '';
            speakStatus.textContent = '已入库：' + String(saved).split(/[\\/]/).pop();
            speakStatus.title = saved;
            showNotification('已保存到音效库 ' + saved, 'success');
        } catch (error) {
            speakStatus.textContent = '';
            showNotification('保存到音效库失败: ' + (error?.message || error), 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    });

    const engineSelect = overlay.querySelector('#voiceEngineSelect');
    const refBox = overlay.querySelector('#voiceRefTextBox');
    const syncEngine = () => {
        const engine = engineSelect?.value || 'breeze';
        // 只有 Breeze 强制要文稿；VoiceStudio 自己会转写，豆包按 speaker 走
        if (refBox) refBox.style.display = engine === 'breeze' ? '' : 'none';
    };
    engineSelect?.addEventListener('change', syncEngine);
    syncEngine();

    overlay.querySelector('#voiceLibOpenBtn')?.addEventListener('click', () => {
        // 不关掉克隆面板：音色库叠在它上面（z-index 更高），
        // 关掉音色库就自然回到克隆界面，录入的内容也还在。
        showVoiceLibraryModal({ fromVoiceClone: true });
    });

    overlay.addEventListener('voice-profiles-changed', () => {
        loadVoiceProfiles().then(renderProfiles);
    });

    loadVoiceProfiles().then(renderProfiles).then(() => {
        // 面板已打开在长音频页时，音色列表刷新了要跟着重建下拉
        if (activeTab === 'long' && typeof renderLongTtsPanel === 'function' && longPane) {
            renderLongTtsPanel(longPane, { profiles: voiceState.profiles });
        }
    });
}

