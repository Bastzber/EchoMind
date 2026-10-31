/* ambient-loop.js —— 环境音：可循环
 * 从 index.html 原样搬出的完整顶层函数。
 */
function fadeAudio(audio, from, to, ms, done) {
    const steps = Math.max(1, Math.round(ms / 50));
    let i = 0;
    const timer = setInterval(() => {
        i += 1;
        const value = from + (to - from) * (i / steps);
        try { audio.volume = Math.min(1, Math.max(0, value)); } catch (_) { }
        if (i >= steps) {
            clearInterval(timer);
            done && done();
        }
    }, 50);
}

function stopAmbience() {
    recipeState.ambiencePlaying = false;
    if (ambienceTimer) { clearInterval(ambienceTimer); ambienceTimer = null; }
    if (ambiencePlayer) {
        const old = ambiencePlayer;
        ambiencePlayer = null;
        fadeAudio(old, old.volume, 0, 250, () => {
            try { old.pause(); } catch (_) { }
        });
    }
    const btn = document.getElementById('recipeStopAmbience');
    if (btn) btn.classList.add('hidden');
}

async function fetchAmbience(x, y) {
    const base = rendererApi.getConfig?.().apiBase || 'http://127.0.0.1:8000';
    const data = await rendererApi.post(
        `/api/v1/recipes/${encodeURIComponent(recipeState.current.id)}/ambience`,
        {
            x, y, seconds: 6,
            enabled: [...recipeState.enabled],
            layer_samples: recipeState.layerSamples,
        },
        { timeoutMs: 60000 }
    );
    return base + data.url;
}

function recordAmbiencePoint(x, y) {
    recipeState.lastPoint = { x, y };
    if (!recipeState.recording) return;
    recipeState.events.push({
        t: (Date.now() - recipeState.startedAt) / 1000,
        x, y,
    });
}

async function startAmbience(x, y) {
    if (!recipeState.current) return;
    recipeState.ambiencePlaying = true;
    stopRecipeAudio();
    recordAmbiencePoint(x, y);
    const btn = document.getElementById('recipeStopAmbience');
    if (btn) btn.classList.remove('hidden');
    try {
        const url = await fetchAmbience(x, y);
        const audio = new Audio(url);
        audio.loop = true;
        audio.volume = 0;
        await audio.play().catch(() => {});
        const previous = ambiencePlayer;
        ambiencePlayer = audio;
        fadeAudio(audio, 0, 0.9, 350);
        if (previous) fadeAudio(previous, previous.volume, 0, 350, () => { try { previous.pause(); } catch (_) { } });
    } catch (error) {
        showNotification('环境音生成失败: ' + error.message, 'error');
    }
}

function updateAmbience(x, y) {
    if (!recipeState.ambiencePlaying || ambiencePending) return;
    const now = Date.now();
    if (now - ambienceLastAt < 450) return;
    ambienceLastAt = now;
    ambiencePending = true;
    recordAmbiencePoint(x, y);
    (async () => {
        try {
            const base = rendererApi.getConfig?.().apiBase || 'http://127.0.0.1:8000';
            const data = await rendererApi.post(
                `/api/v1/recipes/${encodeURIComponent(recipeState.current.id)}/ambience`,
                {
                    x, y, seconds: 6,
                    enabled: [...recipeState.enabled],
                    layer_samples: recipeState.layerSamples,
                },
                { timeoutMs: 60000 }
            );
            const audio = new Audio(base + data.url);
            audio.loop = true;
            audio.volume = 0;
            await audio.play().catch(() => {});
            const previous = ambiencePlayer;
            ambiencePlayer = audio;
            const swap = () => {
                fadeAudio(audio, 0, 0.9, 450);
                if (previous) {
                    fadeAudio(previous, previous.volume, 0, 450, () => {
                        try { previous.pause(); } catch (_) { }
                    });
                }
            };
            // 等新的一段真正出声后再交叉淡化，避免中间出现空档
            if (audio.readyState >= 2) swap();
            else audio.addEventListener('playing', swap, { once: true });
        } catch (_) { }
        ambiencePending = false;
    })();
}

