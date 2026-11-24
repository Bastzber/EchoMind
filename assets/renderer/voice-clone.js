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


// 声音克隆面板的样式（变体 D：左音色库 + 右工作区）。
// 全部 vc- 前缀，避免和 index.html 里那套 utility class 撞名。
const VC_CSS = [
  '.vc-panel{width:900px;max-width:96vw;max-height:86vh;overflow-y:auto;border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.5);padding:16px;display:flex;flex-direction:column;gap:10px}',
  '.vc-head{display:flex;align-items:center;gap:8px}',
  '.vc-logo{width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:rgba(107,138,253,.22);font-size:11px;font-weight:700;color:#8ea7ff}',
  '.vc-title-wrap{display:flex;flex-direction:column;line-height:1.25}',
  '.vc-title{font-size:13px;font-weight:600}',
  '.vc-sub{font-size:11px;color:var(--text-secondary)}',
  '.vc-tabs{display:flex;gap:4px;padding:4px;border-radius:8px;background:var(--bg-tertiary)}',
  '.vc-tab{flex:1;padding:6px 12px;border-radius:6px;font-size:12px;font-weight:500;color:var(--text-secondary);background:transparent;border:0;cursor:pointer}',
  '.vc-tab.is-on{background:var(--accent-color,#6b8afd);color:#fff}',
  '.vc-cols{display:grid;grid-template-columns:300px minmax(0,1fr);gap:12px}',
  '@media(max-width:860px){.vc-cols{grid-template-columns:1fr}}',
  '.vc-lib{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--border-color);border-radius:10px;background:var(--bg-secondary)}',
  '.vc-lib-head{display:flex;align-items:center;gap:6px}',
  '.vc-label{font-size:11px;color:var(--text-secondary)}',
  '.vc-input{background:var(--bg-tertiary);border:1px solid var(--border-color);color:var(--text-primary);border-radius:6px;padding:7px 9px;font-size:12px;font-family:inherit;width:100%}',
  '.vc-input:focus{outline:none;border-color:var(--accent-color,#6b8afd)}',
  '.vc-chips{display:flex;flex-wrap:wrap;gap:6px}',
  '.vc-chip{font-size:11px;padding:3px 8px;border-radius:999px;border:1px solid var(--border-color);background:transparent;color:var(--text-secondary);cursor:pointer}',
  '.vc-chip.is-on{color:var(--text-primary);border-color:var(--accent-color,#6b8afd)}',
  '.vc-lib-list{display:flex;flex-direction:column;gap:6px;max-height:300px;overflow-y:auto}',
  '.vc-voice{display:flex;align-items:center;gap:6px;padding:7px 9px;border-radius:8px;border:1px solid var(--border-color);background:var(--bg-tertiary);flex-wrap:nowrap}',
  '.vc-voice.is-active{border-color:var(--accent-color,#6b8afd);box-shadow:inset 0 0 0 1px var(--accent-color,#6b8afd)}',
  '.vc-dot{width:7px;height:7px;border-radius:50%;background:var(--accent-color,#6b8afd);flex:0 0 auto}',
  '.vc-dot--warn{background:#f59e0b}',
  '.vc-vname{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.vc-vmeta{font-size:11px;color:var(--text-secondary)}',
  '.vc-current{font-size:11px;color:var(--text-secondary)}',
  '.vc-work{display:flex;flex-direction:column;gap:10px;min-width:0}',
  '.vc-card{border:1px solid var(--border-color);border-radius:10px;padding:12px;background:var(--bg-primary)}',
  '.vc-card--tight{padding:10px}',
  '.vc-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.vc-sample{font-size:11px;color:var(--text-secondary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.vc-btn{border:1px solid var(--border-color);background:var(--bg-tertiary);color:var(--text-primary);border-radius:6px;padding:8px 14px;font-size:12px;font-weight:500;cursor:pointer;line-height:1.2;white-space:nowrap}',
  '.vc-btn--primary{background:#3b82f6;border-color:#3b82f6;color:#fff}',
  '.vc-btn--ghost{background:transparent}',
  '.vc-btn--danger{color:#ef4444;border-color:#3a2222;background:transparent}',
  '.vc-btn--block{width:100%}',
  '.vc-btn[disabled]{opacity:.38;cursor:not-allowed}',
  '.vc-link{background:transparent;border:0;color:var(--text-secondary);font-size:11px;cursor:pointer;padding:0}',
  '.vc-link:hover{color:var(--text-primary)}',
  '.vc-note{font-size:11px;color:var(--text-secondary)}',
  '.vc-status{font-size:11px;color:var(--text-secondary);min-height:14px}',
  '.vc-status--err{color:#ef4444}',
  '.vc-bar{height:6px;border-radius:999px;background:var(--bg-tertiary);overflow:hidden;border:1px solid var(--border-color)}',
  '.vc-bar>i{display:block;height:100%;background:linear-gradient(90deg,#3b82f6,#60a5fa);transition:width .35s ease-out}',
  '.vc-grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}'
].join('');

function ensureVoiceCloneStyles() {
    if (document.getElementById('voiceCloneStyles')) return;
    const style = document.createElement('style');
    style.id = 'voiceCloneStyles';
    style.textContent = VC_CSS;
    document.head.appendChild(style);
}

function showVoiceCloneModal(options = {}) {
    ensureVoiceCloneStyles();
    document.getElementById('voiceCloneOverlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'voiceCloneOverlay';
    overlay.className = 'fixed inset-0 flex items-center justify-center';
    overlay.style.cssText = 'z-index:330;background:rgba(0,0,0,0.6)';
    overlay.innerHTML = [
        "<div class=\"vc-panel\" style=\"background:var(--bg-secondary);border:1px solid var(--border-color)\">",
        "  <div class=\"vc-head\">",
        "    <span class=\"vc-logo\">声</span>",
        "    <span class=\"vc-title-wrap\">",
        "      <span class=\"vc-title\">声音克隆</span>",
        "      <span class=\"vc-sub\">选一段约 15 秒人声 → 复刻音色 → 输入台词生成语音</span>",
        "    </span>",
        "    <button id=\"voiceCloseBtn\" class=\"vc-link\" style=\"margin-left:auto\">关闭</button>",
        "  </div>",
        "  <div class=\"vc-tabs\">",
        "    <button id=\"voiceTabShort\" class=\"vc-tab is-on\">短音频克隆</button>",
        "    <button id=\"voiceTabLong\" class=\"vc-tab\">长音频克隆</button>",
        "  </div>",
        "  <div id=\"voiceShortPane\" class=\"vc-cols\">",
        "    <aside class=\"vc-lib\">",
        "      <div class=\"vc-lib-head\"><span class=\"vc-title\">音色库</span><span id=\"voiceLibCount\" class=\"vc-label\" style=\"margin-left:auto\">0</span></div>",
        "      <input id=\"voiceLibSearch\" class=\"vc-input\" placeholder=\"搜音色名…\">",
        "      <div class=\"vc-chips\" id=\"voiceLibFilters\">",
        "        <button class=\"vc-chip is-on\" data-engine=\"all\">全部</button>",
        "        <button class=\"vc-chip\" data-engine=\"breeze\">Breeze</button>",
        "        <button class=\"vc-chip\" data-engine=\"voicestudio\">VoiceStudio</button>",
        "        <button class=\"vc-chip\" data-engine=\"volc\">云端</button>",
        "      </div>",
        "      <div id=\"voiceProfileList\" class=\"vc-lib-list\"></div>",
        "      <div id=\"voiceLibCurrent\" class=\"vc-current\">当前没选音色</div>",
        "      <button id=\"voiceCloneNewBtn\" class=\"vc-btn vc-btn--block\" style=\"margin-top:2px\">+ 克隆新音色</button>",
        "    </aside>",
        "    <section class=\"vc-work\">",
        "      <div class=\"vc-card vc-card--tight\">",
        "        <div class=\"vc-row\">",
        "          <span class=\"vc-title\">样音</span>",
        "          <span id=\"voiceSampleInfo\" class=\"vc-sample\">还没选样音</span>",
        "          <button id=\"voicePickFileBtn\" class=\"vc-btn vc-btn--ghost\" style=\"padding:6px 10px;font-size:11px\">换一个…</button>",
        "        </div>",
        "      </div>",
        "      <div class=\"vc-card vc-card--tight\">",
        "        <div class=\"vc-row\">",
        "          <span class=\"vc-label\" style=\"width:56px\">音色名称</span>",
        "          <input id=\"voiceNameInput\" class=\"vc-input\" style=\"flex:1;min-width:0\" placeholder=\"例如：我的声音\">",
        "          <button id=\"voiceCloneRunBtn\" class=\"vc-btn vc-btn--primary\">开始克隆</button>",
        "        </div>",
        "        <div id=\"voiceRefTextBox\" class=\"vc-row\" style=\"margin-top:8px\">",
        "          <span class=\"vc-label\" style=\"width:56px\">样音文稿</span>",
        "          <textarea id=\"voiceRefTextInput\" rows=\"2\" class=\"vc-input\" style=\"flex:1;min-width:0;resize:vertical\" placeholder=\"这段样音里说的原话（Breeze / OmniVoice 克隆必需，要完整）\"></textarea>",
        "        </div>",
        "        <div id=\"voiceCloneStatus\" class=\"vc-status\" style=\"margin-top:6px\"></div>",
        "      </div>",
        "      <div class=\"vc-card vc-card--tight\">",
        "        <div class=\"vc-row\">",
        "          <span class=\"vc-label\" style=\"width:56px\">合成引擎</span>",
        "          <select id=\"voiceEngineSelect\" class=\"vc-input\" style=\"width:260px;flex:0 0 auto\">",
        "            <option value=\"omnivoice\">本地 OmniVoice（内置，无需装 VoiceStudio）</option>",
        "            <option value=\"breeze\">本地 Breeze TTS 2（离线）</option>",
        "            <option value=\"voicestudio\">VoiceStudio 应用（需先打开它）</option>",
        "            <option value=\"volc\">豆包云端（需 API Key）</option>",
        "          </select>",
        "          <span class=\"vc-label\">输出</span>",
        "          <select id=\"voiceFormatSelect\" class=\"vc-input\" style=\"width:150px;flex:0 0 auto\">",
        "            <option value=\"1-24000\">单声道 24 kHz</option>",
        "            <option value=\"2-24000\">双声道 24 kHz</option>",
        "            <option value=\"2-48000\">双声道 48 kHz</option>",
        "            <option value=\"1-48000\">单声道 48 kHz</option>",
        "          </select>",
        "        </div>",
        "        <div class=\"vc-note\" style=\"margin-top:6px\">选哪个引擎就用哪个模型念；这条音色当初是用哪个引擎克隆的，不影响</div>",
        "        <div id=\"voiceOmniRow\" class=\"vc-row\" style=\"display:none;margin-top:8px\">",
        "          <span id=\"voiceOmniStatus\" class=\"vc-status\" style=\"flex:1\">内置模型还没下载（约 3.1 GB）</span>",
        "          <button id=\"voiceOmniDownloadBtn\" class=\"vc-btn vc-btn--block\" style=\"width:auto;padding:6px 12px;font-size:11px\">下载模型</button>",
        "        </div>",
        "      </div>",
        "      <div class=\"vc-card\">",
        "        <textarea id=\"voiceTextInput\" rows=\"5\" class=\"vc-input\" style=\"min-height:120px\" placeholder=\"输入要念的台词，例如：欢迎使用回声音效库\"></textarea>",
        "        <div id=\"voiceSpeakProgressWrap\" style=\"display:none;margin-top:10px\">",
        "          <div class=\"vc-bar\"><i id=\"voiceSpeakProgressFill\" style=\"width:2%\"></i></div>",
        "          <div id=\"voiceSpeakProgressText\" class=\"vc-status\" style=\"margin-top:5px\">合成中…</div>",
        "        </div>",
        "        <div class=\"vc-grid2\" style=\"margin-top:12px\">",
        "          <button id=\"voiceSpeakBtn\" class=\"vc-btn vc-btn--primary\" style=\"grid-column:1/-1;padding:11px\">生成语音</button>",
        "          <button id=\"voicePlayBtn\" class=\"vc-btn\" disabled>试听</button>",
        "          <button id=\"voiceSaveBtn\" class=\"vc-btn\" disabled>导出音频…</button>",
        "          <button id=\"voiceToLibBtn\" class=\"vc-btn vc-btn--ghost\" style=\"grid-column:1/-1\" disabled>保存到音效库</button>",
        "        </div>",
        "        <div id=\"voiceSpeakStatus\" class=\"vc-status\" style=\"margin-top:6px\"></div>",
        "      </div>",
        "    </section>",
        "  </div>",
        "  <div id=\"voiceLongPane\" class=\"hidden\"></div>",
        "</div>"
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
        // 高亮走 .vc-tab.is-on，别再写内联 cssText —— 会把新样式整块覆盖掉
        if (tabShort) tabShort.classList.toggle('is-on', isShort);
        if (tabLong) tabLong.classList.toggle('is-on', !isShort);
        // 长文本面板按需挂载：每次切过去重建，避免它和短音频那套状态互相干扰
        if (!isShort && typeof renderLongTtsPanel === 'function' && longPane) {
            renderLongTtsPanel(longPane, { profiles: voiceState.profiles });
        }
    };
    tabShort?.addEventListener('click', () => setTab('short'));
    tabLong?.addEventListener('click', () => setTab('long'));

    // 音色库：搜索框 + 引擎筛选 + 「克隆新音色」快捷入口
    const libSearch = overlay.querySelector('#voiceLibSearch');
    libSearch?.addEventListener('input', () => {
        voiceState.libSearch = libSearch.value || '';
        renderProfiles();
    });
    overlay.querySelectorAll('#voiceLibFilters .vc-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
            voiceState.libEngineFilter = chip.dataset.engine || 'all';
            overlay.querySelectorAll('#voiceLibFilters .vc-chip').forEach((item) => {
                item.classList.toggle('is-on', item === chip);
            });
            renderProfiles();
        });
    });
    overlay.querySelector('#voiceCloneNewBtn')?.addEventListener('click', () => {
        overlay.querySelector('#voiceNameInput')?.focus();
        overlay.querySelector('#voicePickFileBtn')?.click();
    });
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


    // 音色库行的试听状态：记「谁在响」，主试听按钮和每行按钮共用同一个播放器
    let previewing = { id: '', kind: '' };   // kind: 'output' | 'sample'
    const isPreviewing = (kind, id) => Boolean(audioPlayer)
        && previewing.kind === kind
        && String(previewing.id) === String(id || '')
        && !audioPlayer.paused
        && !audioPlayer.ended;

    // 音色库：搜索 + 按引擎筛选 + 每行「引擎 / 试听 / 使用 / 删除」
    const providerLabel = (profile) => {
        const provider = String(profile.provider || '');
        if (provider === 'breeze') return '本地 · Breeze';
        if (provider === 'voicestudio') return '本地 · VoiceStudio';
        if (provider === 'omnivoice') return '本地 · OmniVoice';
        return '云端 · 豆包';
    };
    const renderProfiles = () => {
        const host = overlay.querySelector('#voiceProfileList');
        if (!host) return;
        const keyword = String(voiceState.libSearch || '').trim().toLowerCase();
        const engineFilter = String(voiceState.libEngineFilter || 'all');
        host.innerHTML = '';

        const visible = voiceState.profiles.filter((profile) => {
            const provider = String(profile.provider || '');
            if (engineFilter !== 'all' && provider !== engineFilter) return false;
            if (!keyword) return true;
            return String(profile.name || '').toLowerCase().includes(keyword);
        });

        const countEl = overlay.querySelector('#voiceLibCount');
        if (countEl) countEl.textContent = String(voiceState.profiles.length);
        const currentEl = overlay.querySelector('#voiceLibCurrent');
        const active = voiceState.profiles.find((item) => String(item.id) === String(voiceState.profileId));
        if (currentEl) {
            currentEl.textContent = active
                ? '当前使用：' + (active.name || '未命名') + '（' + providerLabel(active) + '）'
                : '当前没选音色';
        }

        if (!voiceState.profiles.length) {
            host.innerHTML = '<div class="vc-label">还没有克隆过音色</div>';
            return;
        }
        if (!visible.length) {
            host.innerHTML = '<div class="vc-label">没有匹配的音色</div>';
            return;
        }

        visible.forEach((profile) => {
            const providerName = String(profile.provider || '');
            const needsRefText = (providerName === 'breeze' || providerName === 'omnivoice')
                && !String(profile.ref_text || '').trim();
            const isActive = String(profile.id) === String(voiceState.profileId);

            const row = document.createElement('div');
            row.className = 'vc-voice' + (isActive ? ' is-active' : '');
            row.style.flexWrap = 'nowrap';
            row.title = needsRefText ? 'Breeze 必须知道样音说的原话才能复刻，点「补文稿」' : (profile.name || '');

            const dot = document.createElement('span');
            dot.className = 'vc-dot' + (needsRefText ? ' vc-dot--warn' : '');

            const info = document.createElement('span');
            info.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column';
            const nameEl = document.createElement('span');
            nameEl.className = 'vc-vname';
            nameEl.textContent = profile.name || '未命名';
            const metaEl = document.createElement('span');
            metaEl.className = 'vc-vmeta';
            metaEl.textContent = providerLabel(profile) + (needsRefText ? ' · 缺文稿' : '');
            info.appendChild(nameEl);
            info.appendChild(metaEl);

            const mkBtn = (text, className, onClick) => {
                const button = document.createElement('button');
                button.className = className;
                button.textContent = text;
                button.style.padding = '3px 6px';
                button.style.fontSize = '10px';
                button.addEventListener('click', onClick);
                return button;
            };

            // 缺文稿不再单独占一个按钮（一行放 4 个按钮会把名字挤没）：
            // 黄点本身就是入口，点一下补原话，补完黄点消失
            if (needsRefText) {
                dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#f59e0b;flex:0 0 auto;cursor:pointer';
                dot.title = '缺样音文稿：点一下补上这句原话';
                dot.addEventListener('click', async (event) => {
                    event.stopPropagation();
                    const text = window.prompt('这段样音里说的原话是什么？（Breeze / OmniVoice 靠它复用音色）', '');
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
            }
            row.appendChild(dot);
            row.appendChild(info);
            row.appendChild(mkBtn(isPreviewing('sample', profile.id) ? '暂停' : '试听', 'vc-btn vc-btn--ghost', async (event) => {
                event.stopPropagation();
                const samplePath = String(profile.sample || '');
                if (!samplePath) {
                    showNotification('这条音色没有样音文件，试听不了', 'info');
                    return;
                }
                try {
                    ensurePlayer();
                    if (isPreviewing('sample', profile.id)) {
                        audioPlayer.pause();
                    } else {
                        audioPlayer.pause();
                        audioPlayer.src = 'soundmind-audio://local/' + encodeURIComponent(samplePath);
                        audioPlayer.dataset.output = '';
                        audioPlayer.load();
                        previewing = { id: String(profile.id), kind: 'sample' };
                        await audioPlayer.play();
                    }
                } catch (error) {
                    showNotification('试听失败: ' + (error?.message || error), 'error');
                }
                renderProfiles();
                syncPlayButton();
            }));
            row.appendChild(mkBtn(isActive ? '使用中' : '使用', 'vc-btn vc-btn--ghost', () => {
                voiceState.speakerId = profile.speaker_id || '';
                voiceState.profileId = profile.id || '';
                voiceState.provider = profile.provider || 'volc';
                renderProfiles();
                if (speakStatus) speakStatus.textContent = '已选：' + (profile.name || '未命名');
            }));
            row.appendChild(mkBtn('删除', 'vc-btn vc-btn--danger', async () => {
                try {
                    await rendererApi.delete('/api/v1/voice/profiles/' + encodeURIComponent(profile.id));
                    await loadVoiceProfiles();
                    renderProfiles();
                } catch (error) {
                    showNotification('删除失败: ' + (error?.message || error), 'error');
                }
            }));
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
                // 生成完不再自动播放（老板要求：要听自己点试听）。
                // 但先把音源挂上，点试听就不用再等加载。
                const player = ensurePlayer();
                player.pause();
                player.src = 'soundmind-audio://local/' + encodeURIComponent(voiceState.lastOutput);
                player.dataset.output = voiceState.lastOutput;
                player.load();
                isPlaying = false;
                syncPlayButton();
            }
        } catch (error) {
            speakStatus.textContent = '';
            finishProgress(false, '失败：' + (error?.message || String(error)).slice(0, 40));
            showNotification(error?.message || String(error), 'error');
        }
    });

    // 试听按钮 = 播放/暂停切换：正在放就显示「暂停」，暂停或放完回到「试听」
    const playBtn = overlay.querySelector('#voicePlayBtn');
    let playerHooked = false;
    const ensurePlayer = () => {
        if (!audioPlayer) initAudioPlayer();
        if (audioPlayer && !playerHooked) {
            const refresh = () => {
                syncPlayButton();
                try {
                    renderProfiles();     // 每行的「试听/暂停」也要跟着换
                } catch (_) { }
            };
            audioPlayer.addEventListener('play', refresh);
            audioPlayer.addEventListener('pause', refresh);
            audioPlayer.addEventListener('ended', () => { isPlaying = false; refresh(); });
            playerHooked = true;
        }
        return audioPlayer;
    };
    const syncPlayButton = () => {
        if (!playBtn) return;
        // 主按钮只管「生成结果」这一路；正在试听某条音色的样音时它保持「试听」
        const playing = isPreviewing('output', voiceState.lastOutput);
        playBtn.textContent = playing ? '暂停' : '试听';
        playBtn.title = playing ? '点一下暂停' : '点一下试听';
    };

    playBtn?.addEventListener('click', async () => {
        if (!voiceState.lastOutput) return;
        try {
            ensurePlayer();
            // 换了产物、或上一段放完了，才重新挂音源；否则直接续播
            if (!audioPlayer.src || audioPlayer.ended || audioPlayer.dataset.output !== voiceState.lastOutput) {
                audioPlayer.src = 'soundmind-audio://local/' + encodeURIComponent(voiceState.lastOutput);
                audioPlayer.dataset.output = voiceState.lastOutput;
                audioPlayer.load();
            }
            if (!audioPlayer.paused) {
                audioPlayer.pause();
                syncPlayButton();
                return;
            }
            previewing = { id: String(voiceState.lastOutput || ''), kind: 'output' };
            await audioPlayer.play();
            isPlaying = true;
            syncPlayButton();
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
    const omniRow = overlay.querySelector('#voiceOmniRow');
    const omniStatus = overlay.querySelector('#voiceOmniStatus');
    const omniDownloadBtn = overlay.querySelector('#voiceOmniDownloadBtn');
    let omniWeightsReady = false;
    let omniPollTimer = null;

    const renderOmniRow = () => {
        if (!omniRow) return;
        const isOmni = (engineSelect?.value || '') === 'omnivoice';
        omniRow.style.display = isOmni ? '' : 'none';
        if (!isOmni || !omniStatus) return;
        omniStatus.textContent = omniWeightsReady
            ? '内置模型已就绪（这台机器离线也能用）'
            : '内置模型还没下载（约 3.1 GB，下一次就够，之后离线可用）';
        if (omniDownloadBtn) {
            omniDownloadBtn.style.display = omniWeightsReady ? 'none' : '';
            omniDownloadBtn.disabled = Boolean(omniPollTimer);
            omniDownloadBtn.textContent = omniPollTimer ? '下载中…' : '下载模型';
        }
    };

    const refreshOmniStatus = async () => {
        try {
            const state = await rendererApi.get('/api/v1/voice/omnivoice/status', { timeoutMs: 15000 });
            omniWeightsReady = Boolean(state?.present);
        } catch (error) {
            omniWeightsReady = false;
        }
        renderOmniRow();
        return omniWeightsReady;
    };

    const startOmniDownload = async () => {
        if (omniPollTimer || omniWeightsReady) return;
        try {
            await rendererApi.post('/api/v1/voice/omnivoice/download', {}, { timeoutMs: 30000 });
        } catch (error) {
            showNotification('下载启动失败: ' + (error?.message || error), 'error');
            return;
        }
        if (omniStatus) omniStatus.textContent = '正在下载模型（约 3.1 GB）…可以先去干别的，下载完这里会变';
        if (omniDownloadBtn) { omniDownloadBtn.disabled = true; omniDownloadBtn.textContent = '下载中…'; }
        let ticks = 0;
        omniPollTimer = setInterval(async () => {
            ticks += 1;
            const ready = await refreshOmniStatus();
            if (ready) {
                clearInterval(omniPollTimer);
                omniPollTimer = null;
                renderOmniRow();
                showNotification('OmniVoice 模型就绪，可以直接生成了', 'success');
            } else if (ticks > 480) {  // 20 分钟还没好就停，别无限轮询
                clearInterval(omniPollTimer);
                omniPollTimer = null;
                renderOmniRow();
            }
        }, 2500);
    };

    const syncEngine = () => {
        const engine = engineSelect?.value || 'omnivoice';
        // Breeze 和内置 OmniVoice 都靠「样音 + 文稿」零样本复刻；
        // VoiceStudio 会自己转写，豆包按 speaker 走
        if (refBox) refBox.style.display = (engine === 'breeze' || engine === 'omnivoice') ? '' : 'none';
        renderOmniRow();
        if (engine === 'omnivoice') refreshOmniStatus();
    };
    engineSelect?.addEventListener('change', syncEngine);
    omniDownloadBtn?.addEventListener('click', startOmniDownload);
    // 默认就用内置引擎（不需要装 VoiceStudio）
    if (engineSelect) engineSelect.value = 'omnivoice';
    syncEngine();


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

