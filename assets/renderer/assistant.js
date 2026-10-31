/* assistant.js —— 大肥鱼 AI 助理
 * 从 index.html 原样搬出的完整顶层函数。
 */
function fishChatHistory() {
    try {
        return JSON.parse(localStorage.getItem('echomind.fishChat') || '[]');
    } catch (_) { return []; }
}

function fishChatSave(list) {
    try { localStorage.setItem('echomind.fishChat', JSON.stringify((list || []).slice(-20))); } catch (_) { }
}

function showFishChat(anchor) {
    document.getElementById('fishChatPanel')?.remove();
    const panel = document.createElement('div');
    panel.id = 'fishChatPanel';
    panel.className = 'fixed rounded-xl shadow-2xl flex flex-col';
    panel.style.cssText = 'z-index:342;background:var(--bg-secondary);border:1px solid var(--border-color);width:380px;height:460px;overflow:hidden';
    panel.innerHTML = [
        '<div class="flex items-center gap-2 px-3 py-2 border-b" style="border-color:var(--border-color)">',
        '  <span style="font-size:13px;font-weight:600">回声</span>',
        '  <span class="opacity-40" style="font-size:10px">AI 助理</span>',
        '  <button id="fishVoiceBtn" class="ml-auto opacity-60 hover:opacity-100" style="font-size:11px">语音关</button>',
        '  <button id="fishChatClear" class="opacity-50 hover:opacity-100" style="font-size:11px">清空</button>',
        '  <button id="fishChatClose" class="opacity-50 hover:opacity-100" style="font-size:11px">关闭</button>',
        '</div>',
        '  <div id="fishChatBody" class="flex-1 overflow-y-auto px-3 py-2 space-y-2" style="font-size:12px;min-height:0"></div>',
        '  <div class="px-3 py-2 border-t flex items-center gap-2" style="border-color:var(--border-color)">',
        '    <input id="fishChatInput" class="flex-1 px-2 py-1.5 rounded text-xs" style="background:var(--bg-tertiary);border:1px solid var(--border-color);color:var(--text-primary)" placeholder="问回声：找雨声 / 索引还有多少 / 帮我看看待归类">',
        '    <button id="fishChatSend" class="px-3 py-1.5 rounded text-xs text-white" style="background:#8b5cf6">发送</button>',
        '  </div>'
    ].join('');
    document.body.appendChild(panel);
    const rect = anchor.getBoundingClientRect();
    panel.style.left = Math.max(8, Math.min(rect.left - 160, window.innerWidth - 396)) + 'px';
    panel.style.top = Math.min(rect.bottom + 8, window.innerHeight - 476) + 'px';

    const body = panel.querySelector('#fishChatBody');
    const input = panel.querySelector('#fishChatInput');

    const paint = () => {
        body.innerHTML = '';
        if (!fishChat.messages.length) {
            body.innerHTML = '<div class="opacity-50" style="font-size:11px;line-height:1.7">'
                + '我是回声，住在你顶栏。<br>可以问我：<br>'
                + '· 找雨声 / 找玻璃碎裂<br>· 索引还有多少没跑<br>· 库里还有多少待归类</div>';
            return;
        }
        fishChat.messages.forEach((m) => {
            if (m.role === 'tool') {
                const chip = document.createElement('div');
                chip.className = 'inline-block px-2 py-0.5 rounded';
                chip.style.cssText = 'background:rgba(107,138,253,.14);font-size:10px;opacity:.85';
                chip.textContent = '🔧 ' + m.text;
                body.appendChild(chip);
                return;
            }
            const bubble = document.createElement('div');
            const mine = m.role === 'user';
            bubble.style.cssText = 'max-width:88%;padding:6px 9px;border-radius:8px;line-height:1.6;white-space:pre-wrap;'
                + (mine ? 'margin-left:auto;background:rgba(139,92,246,.22);' : 'background:rgba(255,255,255,.06);');
            if (mine) {
                bubble.textContent = m.text;
            } else {
                // 助手回复按「句 → 字」两层切开（B21 逐字同步）：
                // 句子用来判断当前播放到哪一段，字用来做卡拉OK式的高亮。
                bubble.dataset.fishReply = String(fishChat.messages.indexOf(m));
                let cursor = 0;
                const parts = String(m.text || '').match(/[^。！？!?\n]*[。！？!?\n]?/g) || [];
                parts.forEach((part) => {
                    if (!part) return;
                    const sent = document.createElement('span');
                    sent.className = 'fish-sent';
                    sent.dataset.start = String(cursor);
                    sent.dataset.end = String(cursor + part.length);
                    sent.textContent = part;
                    bubble.appendChild(sent);
                    cursor += part.length;
                });
            }
            body.appendChild(bubble);
        });
        body.scrollTop = body.scrollHeight;
    };

    const send = async () => {
        const text = input.value.trim();
        if (!text || fishChat.busy) return;
        fishChat.busy = true;
        input.value = '';
        fishChat.messages.push({ role: 'user', text: text });
        paint();
        const thinking = document.createElement('div');
        thinking.id = 'fishThinking';
        thinking.className = 'opacity-50';
        thinking.style.fontSize = '11px';
        thinking.textContent = '回声正在想…';
        body.appendChild(thinking);
        body.scrollTop = body.scrollHeight;
        try {
            const payload = {
                messages: fishChat.messages.filter((m) => m.role !== 'tool').map((m) => ({ role: m.role, content: m.text })),
                project_id: 'default'
            };
            const res = await rendererApi.post('/api/v1/assistant/chat', payload, { timeoutMs: 120000 });
            (res?.traces || []).forEach((tr) => {
                let desc = tr.action;
                if (tr.action === 'search') desc += '「' + (tr.args?.query || '') + '」→ ' + (tr.result?.count ?? '?') + ' 条';
                if (tr.action === 'stats') desc += ' → 文件 ' + (tr.result?.total_files ?? '?');
                if (tr.action === 'unclassified') desc += ' → 待归类 ' + (tr.result?.total ?? '?');
                if (tr.action === 'status') desc += ' → 已读';
                fishChat.messages.push({ role: 'tool', text: desc });
            });
            fishChat.messages.push({ role: 'assistant', text: res?.reply || '（没有回复）' });
            fishChatSave(fishChat.messages);
            // 语音模式：文字先不出现，等第一段语音就绪再显示，
            // 这样文字和声音从第一句就是对齐的（用户建议的方案）。
            const replyText = String(res?.reply || '');
            if (fishVoiceEnabled() && replyText) {
                const pendingMsg = fishChat.messages[fishChat.messages.length - 1];
                // 等语音期间先显示占位，别留一个空气泡
                pendingMsg.text = '正在准备语音…';
                paint();
                let revealed = false;
                const reveal = () => {
                    if (revealed) return;
                    revealed = true;
                    pendingMsg.text = replyText;
                    paint();
                };
                // 兜底：语音 8 秒还没就绪就先显示文字，别让用户干等
                const fallback = setTimeout(reveal, 8000);
                fishSpeak(replyText, {
                    onFirstAudio: () => {
                        clearTimeout(fallback);
                        // 先显示文字（重建 span），下一帧再开始高亮
                        reveal();
                        return new Promise((r) => requestAnimationFrame(() => r()));
                    },
                    onGiveUp: () => { clearTimeout(fallback); reveal(); }
                });
            } else {
                fishSpeak(replyText);
            }

            // 助理搜到的音效直接铺到主列表：不切窗口也能看到、试听、拖拽
            try {
                const searchTrace = (res?.traces || [])
                    .filter((t) => t.action === 'search' && (t.result?.items || []).length)
                    .pop();
                const hits = searchTrace?.result?.items || [];
                if (hits.length && typeof displayAiSearchResults === 'function') {
                    displayAiSearchResults(hits.map((item) => ({
                        filename: item.name || String(item.path || '').split(/[\\/]/).pop() || '',
                        file_path: item.path || '',
                        similarity: item.score,
                        tags: [],
                    })));
                }
            } catch (err) {
                console.warn('[Fish] 搜索结果铺到主列表失败:', err);
            }
        } catch (error) {
            fishChat.messages.push({ role: 'assistant', text: '出错了：' + (error?.message || error) });
        } finally {
            fishChat.busy = false;
            paint();
        }
    };

    const voiceBtn = panel.querySelector('#fishVoiceBtn');
    const paintVoice = () => { if (voiceBtn) voiceBtn.textContent = fishVoiceEnabled() ? '语音开' : '语音关'; };
    paintVoice();
    voiceBtn?.addEventListener('click', () => {
        localStorage.setItem('echomind.fishVoice', fishVoiceEnabled() ? '0' : '1');
        // 关掉语音就立刻停播，别让高亮和声音继续跑（B21）
        if (!fishVoiceEnabled()) stopAssistantSpeech();
        paintVoice();
    });
    panel.querySelector('#fishChatClose').addEventListener('click', () => {
        stopAssistantSpeech();
        panel.remove();
    });
    panel.querySelector('#fishChatClear').addEventListener('click', () => {
        fishChat.messages = [];
        fishChatSave([]);
        paint();
    });
    panel.querySelector('#fishChatSend').addEventListener('click', send);
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') send(); });

    fishChat.messages = fishChatHistory();
    paint();
    input.focus();
}

function showFishPopover(anchor) {
    document.getElementById('fishPopover')?.remove();
    const pop = document.createElement('div');
    pop.id = 'fishPopover';
    pop.className = 'fixed rounded-xl shadow-2xl p-3 text-xs';
    pop.style.cssText = 'z-index:341;background:var(--bg-secondary);border:1px solid var(--border-color);width:230px';
    pop.innerHTML = [
        '<div class="flex items-center gap-2 mb-2">',
        '  <span style="font-size:13px;font-weight:600">回声</span>',
        '  <span id="fishStatusText" class="opacity-50" style="font-size:10px">待机中</span>',
        '</div>',
        '<div id="fishStats" class="space-y-1" style="font-size:11px"></div>',
        '<div class="flex items-center gap-2 mt-2 pt-2" style="border-top:1px solid var(--border-color)">',
        '  <button id="fishPickBtn" class="px-2 py-1 rounded border" style="border-color:var(--border-color)">换成我的图</button>',
        '  <button id="fishHideBtn" class="px-2 py-1 rounded border" style="border-color:var(--border-color)">藏起来</button>',
        '  <button id="fishCloseBtn" class="ml-auto opacity-50 hover:opacity-100">关闭</button>',
        '</div>'
    ].join('');
    const rect = anchor.getBoundingClientRect();
    pop.style.left = Math.min(rect.left, window.innerWidth - 250) + 'px';
    pop.style.top = (rect.bottom + 8) + 'px';
    document.body.appendChild(pop);

    const stats = pop.querySelector('#fishStats');
    stats.innerHTML = '<div class="opacity-50">读取中…</div>';
    (async () => {
        try {
            const data = await rendererApi.get('/api/v1/projects/default/index/status');
            const a = data.artifacts?.audio_vector || {};
            const tx = data.artifacts?.text_vector || {};
            const playing = currentSound ? (currentSound.name || '') : '（未播放）';
            stats.innerHTML = [
                '<div class="flex justify-between"><span class="opacity-60">音乐索引</span><span>', String(a.ready || 0), ' / ', String((a.ready || 0) + (a.pending || 0) + (a.stale || 0) + (a.failed || 0)), '</span></div>',
                '<div class="flex justify-between"><span class="opacity-60">文本索引</span><span>', String(tx.ready || 0), ' / ', String((tx.ready || 0) + (tx.pending || 0) + (tx.stale || 0)), '</span></div>',
                '<div class="flex justify-between gap-2"><span class="opacity-60 shrink-0">正在播放</span><span class="truncate" title="', playing, '">', playing, '</span></div>'
            ].join('');
        } catch (error) {
            stats.innerHTML = '<div class="opacity-50">状态读不到</div>';
        }
    })();

    pop.querySelector('#fishPickBtn').addEventListener('click', async () => {
        try {
            const res = await window.electronAPI?.fileImport?.pickMascot?.();
            if (res?.success && res.image) {
                await fishApplyCustomImage();
                pop.remove();
                showNotification('吉祥物已换成你的图', 'success');
            }
        } catch (error) {
            showNotification('换图失败: ' + (error?.message || error), 'error');
        }
    });
    pop.querySelector('#fishCloseBtn').addEventListener('click', () => pop.remove());
    pop.querySelector('#fishHideBtn').addEventListener('click', () => {
        localStorage.setItem('echomind.fishHidden', '1');
        fishApplyVisibility();
        pop.remove();
        showNotification('回声藏起来了，可在设置里叫回来', 'info');
    });
    const close = (e) => {
        if (!pop.contains(e.target) && e.target.id !== 'navFishBtn') {
            pop.remove();
            document.removeEventListener('mousedown', close);
        }
    };
    setTimeout(() => document.addEventListener('mousedown', close), 0);
}

function fishSetImage(src) {
    const wrap = document.getElementById('navFishWrap');
    if (!wrap || !src) return;
    let img = wrap.querySelector('#navFishCustom');
    if (!img) {
        wrap.querySelector('#navFish')?.remove();
        img = document.createElement('img');
        img.id = 'navFishCustom';
        img.alt = '吉祥物';
        img.style.cssText = 'width:48px;height:62px;object-fit:contain;pointer-events:none;';
        img.style.filter = 'drop-shadow(0 2px 6px rgba(56,132,255,.35))';
        img.style.animation = 'fishBob 3.2s ease-in-out infinite';
        wrap.querySelector('button')?.appendChild(img);
    }
    if (img.getAttribute('src') !== src) img.src = src;
}

async function fishApplyCustomImage() {
    const wrap = document.getElementById('navFishWrap');
    if (!wrap) return;
    try {
        const res = await window.electronAPI?.fileImport?.loadMascot?.();
        if (res?.success && res.image) {
            let img = wrap.querySelector('#navFishCustom');
            if (!img) {
                wrap.querySelector('#navFish')?.remove();
                img = document.createElement('img');
                img.id = 'navFishCustom';
                img.alt = '吉祥物';
                img.style.cssText = 'width:48px;height:62px;object-fit:contain;pointer-events:none;';
                img.style.filter = 'drop-shadow(0 2px 6px rgba(56,132,255,.35))';
                img.addEventListener('load', () => {
                    img.style.animation = 'fishBob 3.2s ease-in-out infinite';
                });
                wrap.querySelector('button')?.appendChild(img);
            }
            img.src = res.image;
            return;
        }
    } catch (error) {
        console.warn('[Fish] 读取自定义图片失败:', error);
    }

}

