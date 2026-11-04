/* voice-library.js —— 音色库管理
 * 从 index.html 原样搬出的完整顶层函数。
 */
// 试听专用播放器：自己持有引用，不依赖别的文件的全局变量。
// new Audio() 不会变成 DOM 节点，所以「遍历 document 里的 audio 元素」抓不到它，
// 必须靠这个模块级引用才能停干净。
let __voicePreviewAudio = null;

function stopVoicePreview() {
    const el = __voicePreviewAudio;
    if (!el) return;
    try {
        el.pause();
        el.removeAttribute('src');
        el.src = '';
        try { el.currentTime = 0; } catch (_e) {}
        el.load();
    } catch (_e) { /* 播放器已失效 */ }
}

async function showVoiceLibraryModal(options = {}) {
    // 重新打开时先把上一轮的试听停掉：这里是直接 remove 旧面板，不走 closeOverlay，
    // 声音会留在背景里继续响（11-04 反馈「关掉界面还有声音」的一种路径）。
    stopVoicePreview();
    document.getElementById('voiceLibOverlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'voiceLibOverlay';
    overlay.className = 'fixed inset-0 flex items-center justify-center';
    overlay.style.cssText = 'z-index:331;background:rgba(0,0,0,0.6)';
    overlay.innerHTML = [
        '<div class="rounded-xl shadow-2xl w-[680px] max-h-[82vh] flex flex-col" style="background:var(--bg-secondary);border:1px solid var(--border-color)">',
        '  <div class="flex items-center gap-2 px-4 py-3 border-b" style="border-color:var(--border-color)">',
        '    <span class="text-sm font-semibold">音色库</span>',
        '    <span id="voiceLibCount" class="text-[11px] opacity-50"></span>',
        '    <span id="voiceLibEngine" class="text-[11px] opacity-45 ml-2"></span>',
        '    <button id="voiceLibStop" class="ml-auto px-2 py-1 rounded text-xs border" style="border-color: var(--border-color)">⏸ 暂停试听</button>',
        '    <button id="voiceLibClose" class="ml-2 text-xs opacity-50 hover:opacity-100">关闭</button>',
        '  </div>',
        '  <div class="px-4 py-2 text-[11px] opacity-45 border-b" style="border-color:var(--border-color)">',
        '    本地音色：参考音频 + 文稿，零样本克隆，不联网；云端音色走豆包 API。',
        '  </div>',
        '  <div id="voiceLibBody" class="flex-1 overflow-y-auto p-3 flex flex-col gap-2 min-h-0"></div>',
        '</div>'
    ].join('');
    document.body.appendChild(overlay);
    // 关闭界面时把试听也停掉：以前只 remove 了 overlay，audioPlayer 还挂在全局，
    // 声音会一直放到结束（11-04 反馈）。统一走 closeOverlay，三种关闭方式都停。
    // 关面板要把声音停干净。这里不依赖任何单个变量：
    // 挨个把页面上的 Audio 停掉，再兜一层全局播放器。
    // 之所以这么写：audioPlayer 会被主界面反复换（换音源时新建 Audio 再赋值），
    // 只要有一条路径漏了，声音就会留在后台（11-04 反复反馈）。
    const body = overlay.querySelector('#voiceLibBody');
    const stopBtn = overlay.querySelector('#voiceLibStop');
    const countEl = overlay.querySelector('#voiceLibCount');
    const engineEl = overlay.querySelector('#voiceLibEngine');

    const setPlayBtnState = (state) => {
        const btn = stopBtn;
        if (!btn) return;
        btn.textContent = state === 'playing' ? '⏸ 暂停试听' : '▶ 继续试听';
        btn.disabled = !__voicePreviewAudio;
    };

    const togglePreview = () => {
        const player = __voicePreviewAudio;
        if (!player || !player.src) {
            showNotification('先点一个「试听原声」', 'info');
            return;
        }
        if (player.paused) {
            player.play().then(() => setPlayBtnState('playing')).catch(() => {});
        } else {
            player.pause();
            setPlayBtnState('idle');
        }
    };

    const stopPreview = () => {
        stopVoicePreview();
        setPlayBtnState('idle');
    };
    const closeOverlay = () => {
        stopPreview();
        overlay.remove();
    };
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeOverlay(); });
    overlay.querySelector('#voiceLibClose').addEventListener('click', closeOverlay);
    if (stopBtn) {
        stopBtn.disabled = true;
        stopBtn.addEventListener('click', togglePreview);
    }
    overlay.addEventListener('remove', stopPreview);



    const playPath = async (path) => {
        if (!path) return;
        stopVoicePreview();
        try {
            if (!__voicePreviewAudio) __voicePreviewAudio = new Audio();
            const player = __voicePreviewAudio;
            player.preload = 'auto';
            player.src = 'soundmind-audio://local/' + encodeURIComponent(path);
            player.load();
            setPlayBtnState('playing');
            player.onended = () => setPlayBtnState('idle');
            player.onerror = () => setPlayBtnState('idle');
            await player.play().catch(() => { setPlayBtnState('idle'); });
        } catch (error) {
            setPlayBtnState('idle');
            showNotification('试听播放失败: ' + (error?.message || error), 'error');
        }
    };

    // 暂停/继续：用户手上有个直接能按的开关，比等关闭时自动停更踏实


    const render = (profiles, engine) => {
        countEl.textContent = '共 ' + profiles.length + ' 个';
        engineEl.textContent = engine ? '引擎：' + engine : '';
        body.innerHTML = '';
        if (!profiles.length) {
            body.innerHTML = '<div class="text-[12px] opacity-45 p-3">还没有音色。打开「声音克隆」登记一个再来。</div>';
            return;
        }
        profiles.forEach((profile) => {
            const card = document.createElement('div');
            card.className = 'rounded-lg p-3 flex flex-col gap-2';
            card.style.cssText = 'border:1px solid var(--border-color)';
            const local = (profile.provider || 'volc') === 'breeze';
            const head = document.createElement('div');
            head.className = 'flex items-center gap-2';
            head.innerHTML = '<span style="font-size:12px;font-weight:600">' + (profile.name || '未命名') + '</span>'
                + '<span class="px-1.5 py-0.5 rounded" style="font-size:10px;background:' + (local ? 'rgba(96,220,180,.18)' : 'rgba(140,160,255,.18)') + '">'
                + (local ? '本地' : '云端') + '</span>'
                + '<span class="opacity-40" style="font-size:10px">' + (profile.duration ? profile.duration.toFixed(1) + 's' : '') + '</span>'
                + '<span class="opacity-30 ml-auto" style="font-size:10px">' + (profile.id || '') + '</span>';
            card.appendChild(head);

            const meta = document.createElement('div');
            meta.style.cssText = 'font-size:11px;opacity:.6;line-height:1.6;word-break:break-all';
            meta.textContent = local
                ? ('参考音频：' + String(profile.sample || '').split(/[\\/]/).pop() + '\n文稿：' + (profile.ref_text || '（未填写）'))
                : ('speaker：' + (profile.speaker_id || ''));
            meta.style.whiteSpace = 'pre-wrap';
            card.appendChild(meta);

            const actions = document.createElement('div');
            actions.className = 'flex items-center gap-2';
            const mk = (label, handler, primary) => {
                const b = document.createElement('button');
                b.className = primary ? 'px-2 py-1 rounded text-xs' : 'px-2 py-1 rounded text-xs border';
                b.style.cssText = primary
                    ? 'background:#3b82f6;color:#fff'
                    : 'border-color:var(--border-color)';
                b.textContent = label;
                b.addEventListener('click', handler);
                return b;
            };
            actions.appendChild(mk('试听原声', () => playPath(profile.sample)));
            actions.appendChild(mk('试听合成', async () => {
                try {
                    const res = await rendererApi.post('/api/v1/voice/speak', {
                        text: '这是一段试听，用来确认音色像不像。',
                        profile_id: profile.id,
                    }, { timeoutMs: 240000 });
                    if (res?.path) await playPath(res.path);
                } catch (error) {
                    showNotification('试听失败: ' + (error?.message || error), 'error');
                }
            }));
            actions.appendChild(mk('改名', async () => {
                const next = prompt('新的音色名称', profile.name || '');
                if (!next) return;
                try {
                    await rendererApi.patch('/api/v1/voice/profiles/' + encodeURIComponent(profile.id), { name: next });
                    reload();
                } catch (error) {
                    showNotification('改名失败: ' + (error?.message || error), 'error');
                }
            }));
            if (local) {
                actions.appendChild(mk('改文稿', async () => {
                    const next = prompt('这段样音里说的原话（必须完全一致）', profile.ref_text || '');
                    if (next === null) return;
                    try {
                        await rendererApi.patch('/api/v1/voice/profiles/' + encodeURIComponent(profile.id), { ref_text: next });
                        reload();
                    } catch (error) {
                        showNotification('修改失败: ' + (error?.message || error), 'error');
                    }
                }));
            }
            actions.appendChild(mk('删除', async () => {
                if (!confirm('删除音色「' + (profile.name || '未命名') + '」？')) return;
                try {
                    await rendererApi.delete('/api/v1/voice/profiles/' + encodeURIComponent(profile.id));
                    reload();
                } catch (error) {
                    showNotification('删除失败: ' + (error?.message || error), 'error');
                }
            }));
            card.appendChild(actions);
            body.appendChild(card);
        });
    };

    const reload = async () => {
        try {
            const data = await rendererApi.get('/api/v1/voice/profiles');
            render(data.profiles || [], data.engine || '');
        } catch (error) {
            body.innerHTML = '<div class="text-xs text-red-400 p-3">读取失败：' + (error?.message || error) + '</div>';
        }
    };
    await reload();
}

function bindVoiceClone() {
    document.getElementById('voiceCloneBtn')?.addEventListener('click', () => {
        showVoiceCloneModal();
    });
}

