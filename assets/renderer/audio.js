(function (global) {
    'use strict';

    const namespace = global.SoundBotRenderer = global.SoundBotRenderer || {};
    // 只有 Chromium 自己播不了的格式才转码。
    // wav/m4a/aac 本来能直接播，以前也塞进来走转码，结果解码器少吐样本：
    // 实测 138.52 秒的 AAC 转出来只有 130.92 秒 —— 声音比时长快 5%，
    // 进度条和声音越播越偏（用户反馈「相差 15 秒」就是这一条）。
    const TRANSCODE_EXTENSIONS = new Set(['aif', 'aiff', 'wma', 'caf', 'au', 'ape']);
    const playbackSourceCache = new Map();

    function extensionOf(sound) {
        const candidate = sound?.filePath || sound?.name || sound?.type || '';
        const clean = String(candidate).split(/[?#]/, 1)[0];
        const match = clean.match(/\.([^.\\/]+)$/);
        if (match) return match[1].toLowerCase();
        return String(sound?.type || '').replace(/^\./, '').toLowerCase();
    }

    function requiresPlaybackSource(sound) {
        return TRANSCODE_EXTENSIONS.has(extensionOf(sound));
    }

    function playbackAction(currentSound, requestedSound, isPlaying, options = {}) {
        const currentId = currentSound?.id ?? currentSound?.fileId ?? null;
        const requestedId = requestedSound?.id ?? requestedSound?.fileId ?? null;
        const sameSound = currentId !== null
            && requestedId !== null
            && String(currentId) === String(requestedId);
        return sameSound && isPlaying && !options.forcePlay ? 'pause' : 'play';
    }

    function localSource(filePath) {
        if (!filePath) return '';
        const value = String(filePath);
        if (/^(blob:|https?:|soundmind-audio:)/i.test(value)) return value;
        return `soundmind-audio://local/${encodeURIComponent(value)}`;
    }

    async function resolvePlaybackSource(sound, options = {}) {
        const filePath = sound?.filePath;
        if (!filePath) throw new Error('Audio path is missing');
        if (!requiresPlaybackSource(sound)) return localSource(filePath);

        const fileId = sound?.fileId;
        if (typeof fileId !== 'string' || !fileId.trim()) {
            const error = new Error('A stable file ID is required for this audio format');
            error.code = 'PLAYBACK_FILE_ID_REQUIRED';
            throw error;
        }

        const projectId = options.projectId || 'default';
        const cacheKey = `${projectId}:${fileId}:${filePath}`;
        if (playbackSourceCache.has(cacheKey)) return await playbackSourceCache.get(cacheKey);

        const api = options.api || namespace.api;
        if (!api?.get) throw new Error('Renderer API is unavailable');
        const pendingSource = api.get(
            `/api/v1/files/${encodeURIComponent(fileId)}/playback-source?project_id=${encodeURIComponent(projectId)}`
        ).then(payload => {
            if (!payload?.path) {
                const error = new Error('Playback source response has no path');
                error.code = 'PLAYBACK_SOURCE_INVALID';
                throw error;
            }
            return localSource(payload.path);
        });
        playbackSourceCache.set(cacheKey, pendingSource);
        try {
            return await pendingSource;
        } finally {
            // Cache only concurrent requests. The backend owns an LRU cache and
            // may evict a generated WAV at any time, so a persisted renderer
            // path would eventually point at a deleted file.
            if (playbackSourceCache.get(cacheKey) === pendingSource) {
                playbackSourceCache.delete(cacheKey);
            }
        }
    }

    function waitForMetadata(player) {
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                player.removeEventListener('loadedmetadata', onLoaded);
                player.removeEventListener('error', onError);
            };
            const onLoaded = () => {
                cleanup();
                resolve();
            };
            const onError = () => {
                cleanup();
                reject(new Error('音频加载失败'));
            };
            if (player.readyState >= 1) {
                resolve();
                return;
            }
            player.addEventListener('loadedmetadata', onLoaded);
            player.addEventListener('error', onError);
        });
    }

    namespace.audio = Object.freeze({
        extensionOf,
        requiresPlaybackSource,
        playbackAction,
        localSource,
        resolvePlaybackSource,
        waitForMetadata,
        clearPlaybackSourceCache: () => playbackSourceCache.clear()
    });
})(typeof window !== 'undefined' ? window : globalThis);
