/* assistant-voice.js —— 眨眼 / 语音
 * 从 index.html 原样搬出的完整顶层函数。
 */
function mbStartBlink() {
    if (mbBlinkTimer) return;
    mbBlinkTimer = setInterval(() => {
        if (document.hidden) return;
        if (Math.random() > 0.7) return;
        const open = document.getElementById('mbEyes');
        const closed = document.getElementById('mbEyesClosed');
        if (!open || !closed) return;
        open.style.display = 'none';
        closed.style.display = '';
        setTimeout(() => {
            open.style.display = '';
            closed.style.display = 'none';
        }, 130);
    }, 3400);
}

function fishVoiceEnabled() { return localStorage.getItem('echomind.fishVoice') === '1'; }


function splitSpeech(text) {
    const raw = String(text || '').replace(/\r/g, '');
    const clean = raw.trim();
    if (!clean) return [];
    const lead = raw.indexOf(clean);
    const base = lead < 0 ? 0 : lead;
    const out = [];
    const MAX = 26;
    let cursor = 0;
    const sentences = clean.split(/(?<=[。！？!?；;\n])/);
    for (const rawSentence of sentences) {
        const s = rawSentence;
        if (!s.trim()) { cursor += s.length; continue; }
        const cap = out.length ? MAX : 12;
        const push = (piece) => {
            if (!piece) return;
            const at = clean.indexOf(piece, cursor);
            const start = (at < 0 ? cursor : at) + base;
            out.push({ text: piece, start, end: start + piece.length });
        };
        if (s.length <= cap) { push(s); cursor += s.length; continue; }
        let buf = '';
        for (const seg of s.split(/(?<=[，,、：:])/)) {
            const limit = out.length ? MAX : cap;
            if (buf && (buf + seg).length > limit) { push(buf); buf = seg; }
            else buf += seg;
        }
        push(buf);
        cursor += s.length;
    }
    if (!out.length) return [{ text: clean, start: base, end: base + clean.length }];
    return out;
}

function highlightAssistantSentence(gen, start, end) {
    fishHighlightGen = gen;
    const chatBody = document.getElementById('fishChatBody');
    if (!chatBody) return;
    const bubbles = chatBody.querySelectorAll('[data-fish-reply]');
    const bubble = bubbles.length ? bubbles[bubbles.length - 1] : null;
    if (!bubble) return;
    let firstActive = null;
    bubble.querySelectorAll('.fish-sent').forEach((span) => {
        const s = Number(span.dataset.start || 0);
        const e = Number(span.dataset.end || 0);
        const active = e > start && s < end;
        span.classList.toggle('fish-sent-active', active);
        if (active && !firstActive) firstActive = span;
    });
    if (firstActive && typeof firstActive.scrollIntoView === 'function') {
        try { firstActive.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) { }
    }
}

function clearAssistantHighlight() {
    fishHighlightGen = -1;
    document.querySelectorAll('#fishChatBody .fish-sent-active')
        .forEach((span) => span.classList.remove('fish-sent-active'));
}

function stopAssistantSpeech() {
    fishSpeechGen += 1;
    if (fishSpeechAudio) { try { fishSpeechAudio.pause(); } catch (_) { } fishSpeechAudio = null; }
    clearAssistantHighlight();
    if (window.echoAvatar) { try { window.echoAvatar.stopTalk(); } catch (_) { } }
}

async function fishSpeak(text, options) {
    const opts = options || {};
    if (!fishVoiceEnabled() || !text) {
        if (typeof opts.onGiveUp === 'function') opts.onGiveUp();
        return;
    }
    const gen = ++fishSpeechGen;
    if (fishSpeechAudio) { try { fishSpeechAudio.pause(); } catch (_) { } fishSpeechAudio = null; }
    const chunks = splitSpeech(text);
    if (!chunks.length) return;
    const stats = { chunks: chunks.length, t0: performance.now(), firstAudio: 0, done: 0, failed: 0, log: [] };
    window.__fishSpeechStats = stats;

    // 合成请求：失败重试一次，避免某一段静默丢失导致「念到一半没了」
    const pending = new Array(chunks.length).fill(null);
    const request = (i) => {
        if (i >= chunks.length) return;
        if (pending[i]) return;
        pending[i] = (async () => {
            // 冷启动时 Breeze 可能还没起来（503），退避重试 4 次；
            // 第一段尤其重要——以前这里只重试一次就放弃了，用户听到的是「第一句没声音」。
            const delays = [0, 800, 2000, 4000];
            for (let attempt = 0; attempt < delays.length; attempt += 1) {
                if (delays[attempt]) {
                    await new Promise((r) => setTimeout(r, delays[attempt]));
                }
                try {
                    const r = await rendererApi.post('/api/v1/assistant/speak',
                        { text: String(chunks[i].text || '').slice(0, 400) }, { timeoutMs: 90000 });
                    if (r && r.path) return r.path;
                } catch (error) {
                    if (attempt === delays.length - 1) {
                        console.warn('[Fish] 第 ' + (i + 1) + ' 段合成失败:', error?.message || error);
                    }
                }
            }
            return null;
        })();
    };
    for (let i = 0; i < Math.min(2, chunks.length); i++) request(i);

    for (let i = 0; i < chunks.length; i++) {
        if (gen !== fishSpeechGen) return;   // 有新回复插进来，放弃这一条
        const path = await pending[i];
        request(i + 2);
        if (gen !== fishSpeechGen) return;
        if (!path) {
            stats.failed += 1;
            stats.log.push({ i, chars: chunks[i].text.length, ok: false });
            console.warn('[Fish] 第 ' + (i + 1) + ' 段语音合成失败，已跳过');
            // B14：以前这种失败被 catch 吞掉，用户只觉得「没声音」。
            // 第一次失败就明确提示一次，别每次都弹。
            if (!window.__fishSpeakWarned) {
                window.__fishSpeakWarned = true;
                try {
                    showNotification('语音合成失败，这一段跳过朗读（可稍后重试）', 'error');
                } catch (_) { }
            }
            continue;
        }
        const started = performance.now();
        if (i === 0 && typeof opts.onFirstAudio === 'function') {
            try { await opts.onFirstAudio(); } catch (_) { }
        }
        highlightAssistantSentence(gen, chunks[i].start, chunks[i].end);
        await new Promise((resolve) => {
            const audio = new Audio('soundmind-audio://local/' + encodeURIComponent(path));
            audio.volume = 0.9;
            fishSpeechAudio = audio;
            if (!stats.firstAudio) stats.firstAudio = performance.now() - stats.t0;
            if (window.echoAvatar) window.echoAvatar.talk(chunks[i].text);
            let finished = false;
            const finish = (reason) => {
                if (finished) return;
                finished = true;
                clearTimeout(watch);
                audio.onended = null;
                audio.onerror = null;
                if (reason !== 'ended') stats.log.push({ i, chars: chunks[i].text.length, ok: false, reason });
                resolve();
            };
            // 看门狗：音频一旦卡住（onended 不来）也要让队列继续，别把后面全堵死
            const watch = setTimeout(() => finish('timeout'), 45000);
            audio.onended = () => finish('ended');
            audio.onerror = () => finish('error');
            audio.play().catch(() => finish('play-failed'));
        });
        stats.log.push({ i, chars: chunks[i].text.length, ok: true, ms: Math.round(performance.now() - started) });
    }
    stats.done = performance.now() - stats.t0;
    if (stats.failed === chunks.length && typeof opts.onGiveUp === 'function') {
        try { opts.onGiveUp(); } catch (_) { }
    }
    if (gen === fishSpeechGen) clearAssistantHighlight();
    if (gen === fishSpeechGen && window.echoAvatar) window.echoAvatar.stopTalk();
}

function fishBubble(text, ms = 7000) {
    document.getElementById('fishBubbleTip')?.remove();
    const wrap = document.getElementById('navFishWrap');
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const tip = document.createElement('div');
    tip.id = 'fishBubbleTip';
    tip.style.cssText = 'position:fixed;z-index:342;max-width:230px;padding:6px 9px;border-radius:9px;'
        + 'background:var(--bg-secondary);border:1px solid var(--border-color);font-size:11px;line-height:1.6;'
        + 'box-shadow:0 6px 18px rgba(0,0,0,.28);animation:emSlideDown .16s ease-out both';
    tip.textContent = text;
    tip.style.left = Math.max(8, Math.min(rect.left - 60, window.innerWidth - 244)) + 'px';
    tip.style.top = (rect.bottom + 7) + 'px';
    document.body.appendChild(tip);
    setTimeout(() => tip.remove(), ms);
}

async function fishPollEvents() {
    try {
        const data = await rendererApi.get('/api/v1/assistant/events');
        if (!fishEventState) { fishEventState = data; return; }
        const before = fishEventState;
        fishEventState = data;
        if ((data.failed || 0) > (before.failed || 0)) {
            fishBubble('有 ' + (data.failed - before.failed) + ' 个文件索引失败，要我看看吗？');
        } else if (before.last_job && data.last_job
            && before.last_job.created_at === data.last_job.created_at
            && before.last_job.state !== 'completed' && data.last_job.state === 'completed') {
            fishBubble('索引跑完啦：' + (data.last_job.kind || '任务'));
        }
    } catch (error) { }
}

function bindNavFish() {
    fishApplyVisibility();
    mbStartBlink();
    fishPollEvents();
    setInterval(fishPollEvents, 60000);
    fishApplyCustomImage();
    const btn = document.getElementById('navFishBtn');
    if (!btn) return;
    btn.addEventListener('click', () => showFishChat(btn));
    btn.addEventListener('dblclick', () => showFishPopover(btn));
    btn.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        localStorage.setItem('echomind.fishHidden', '1');
        fishApplyVisibility();
        showNotification('回声已隐藏，右键顶栏空白处可恢复（或设置里）', 'info');
    });
    fishSetPlaying(typeof isPlaying !== 'undefined' ? isPlaying : false);
}

