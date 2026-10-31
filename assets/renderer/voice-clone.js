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

function showVoiceCloneModal() {
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
        "                    <div class=\"rounded-lg p-3\" style=\"border:1px solid var(--border-color)\">",
        "                        <div class=\"text-xs font-medium mb-2\">① 选择样音</div>",
        "                        <div class=\"flex items-center gap-2 mb-2\">",
        "                            <span class=\"text-[11px] opacity-50\">合成引擎</span>",
        "                            <select id=\"voiceEngineSelect\" class=\"px-2 py-1 rounded text-xs\" style=\"background:var(--bg-tertiary);border:1px solid var(--border-color);color:var(--text-primary)\">",
        "                                <option value=\"breeze\">本地 Breeze TTS 2（离线，推荐）</option>",
        "                                <option value=\"volc\">豆包云端（需 API Key）</option>",
        "                            </select>",
        "                        </div>",
        "                        <div id=\"voiceRefTextBox\" class=\"flex items-center gap-2 mb-2\">",
        "                            <span class=\"text-[11px] opacity-50\">样音文稿</span>",
        "                            <input id=\"voiceRefTextInput\" class=\"flex-1 px-2 py-1 rounded text-xs\" style=\"background:var(--bg-tertiary);border:1px solid var(--border-color);color:var(--text-primary)\" placeholder=\"这段样音里说的原话（本地克隆必需）\">",
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
        "                        <div class=\"flex items-center gap-2 mt-2\">",
        "                            <button id=\"voicePlayBtn\" class=\"px-3 py-1.5 rounded text-xs border\" style=\"border-color:var(--border-color)\" disabled>试听</button>",
        "                            <button id=\"voiceSaveBtn\" class=\"px-3 py-1.5 rounded text-xs border\" style=\"border-color:var(--border-color)\" disabled>保存为 WAV…</button>",
        "                            <button id=\"voiceSpeakBtn\" class=\"px-3 py-1.5 rounded text-xs font-medium\" style=\"background:#3b82f6;color:#fff\">生成语音</button>",
        "                            <span id=\"voiceSpeakStatus\" class=\"text-[11px] opacity-55\"></span>",
        "                        </div>",
        "                    </div>",
        "                </div>"
    ].join('');
    document.body.appendChild(overlay);
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) overlay.remove(); });
    overlay.querySelector('#voiceCloseBtn').addEventListener('click', () => overlay.remove());

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
            meta.textContent = (profile.provider === 'breeze' ? '本地' : '云端')
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
            row.appendChild(label); row.appendChild(meta); row.appendChild(pick); row.appendChild(del);
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
                showNotification('本地克隆需要填写样音里说的原话', 'info');
                return;
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
            statusEl.textContent = '已登记：' + (result?.profile?.name || '') + (voiceState.provider === 'breeze' ? '（本地可用）' : '（云端）');
            await loadVoiceProfiles();
            renderProfiles();
        } catch (error) {
            statusEl.textContent = '';
            showNotification(error?.message || String(error), 'error');
        }
    });

    overlay.querySelector('#voiceSpeakBtn').addEventListener('click', async () => {
        const text = overlay.querySelector('#voiceTextInput').value.trim();
        if (!text) { showNotification('先输入要念的台词', 'info'); return; }
        // 本地 Breeze 音色没有 speaker_id，必须用 profileId 判断
        if (!voiceState.profileId && !voiceState.speakerId) { showNotification('先选一个音色（或先克隆一个）', 'info'); return; }
        speakStatus.textContent = '正在合成…';
        try {
            const fmt = (overlay.querySelector('#voiceFormatSelect')?.value || '1-24000').split('-');
            const result = await rendererApi.post('/api/v1/voice/speak', {
                text,
                speaker_id: voiceState.speakerId || '',
                profile_id: voiceState.profileId || '',
                channels: Number(fmt[0]) || 1,
                sample_rate: Number(fmt[1]) || 24000,
            }, { timeoutMs: 240000 });
            voiceState.lastOutput = result?.path || '';
            speakStatus.textContent = '已生成：' + String(result?.path || '').split(/[\\/]/).pop();
            const playBtnEl = overlay.querySelector('#voicePlayBtn');
            const saveBtnEl = overlay.querySelector('#voiceSaveBtn');
            if (voiceState.lastOutput) {
                if (playBtnEl) playBtnEl.disabled = false;
                if (saveBtnEl) saveBtnEl.disabled = false;
                if (!audioPlayer) initAudioPlayer();
                audioPlayer.src = 'soundmind-audio://local/' + encodeURIComponent(voiceState.lastOutput);
                audioPlayer.load();
                await audioPlayer.play().catch(() => { });
                isPlaying = true;
            }
        } catch (error) {
            speakStatus.textContent = '';
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

    overlay.querySelector('#voiceSaveBtn').addEventListener('click', async () => {
        if (!voiceState.lastOutput) return;
        try {
            const picked = await window.electronAPI?.dialogs?.showSaveDialog?.({
                title: '保存语音',
                defaultPath: (nameInput.value.trim() || '语音') + '.wav',
                filters: [{ name: 'WAV', extensions: ['wav'] }],
            });
            const target = picked?.filePath || '';
            if (!target) return;
            const res = await rendererApi.post('/api/v1/files/copy', {
                source: voiceState.lastOutput,
                destination: target,
                overwrite: true,
            }, { timeoutMs: 60000 });
            speakStatus.textContent = '已保存：' + String(res?.path || target).split(/[\\/]/).pop();
            showNotification('已保存到 ' + (res?.path || target), 'success');
        } catch (error) {
            showNotification('保存失败: ' + (error?.message || error), 'error');
        }
    });

    const engineSelect = overlay.querySelector('#voiceEngineSelect');
    const refBox = overlay.querySelector('#voiceRefTextBox');
    const syncEngine = () => {
        const local = (engineSelect?.value || 'breeze') === 'breeze';
        if (refBox) refBox.style.display = local ? '' : 'none';
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

    loadVoiceProfiles().then(renderProfiles);
}

