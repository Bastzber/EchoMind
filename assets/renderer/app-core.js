/* 从 index.html 内联脚本拆出来的第 1 段（app-core.js）—— 纯搬家，逻辑未改动 */

        // ===== 帮助问号：鼠标悬浮显示功能说明 =====
        (function initHelpTips() {
            const ensureTip = () => {
                let tip = document.getElementById('helpTip');
                if (!tip) { tip = document.createElement('div'); tip.id = 'helpTip'; document.body.appendChild(tip); }
                return tip;
            };
            const show = (event) => {
                const el = event.target.closest('[data-help]');
                if (!el) return;
                const tip = ensureTip();
                tip.textContent = el.getAttribute('data-help') || '';
                tip.classList.add('show');
                const rect = el.getBoundingClientRect();
                const tipRect = tip.getBoundingClientRect();
                let left = rect.left + rect.width / 2 - tipRect.width / 2;
                left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
                let top = rect.bottom + 8;
                if (top + tipRect.height > window.innerHeight - 8) top = Math.max(8, rect.top - tipRect.height - 8);
                tip.style.left = left + 'px';
                tip.style.top = top + 'px';
            };
            const hide = (event) => {
                const el = event.target && event.target.closest ? event.target.closest('[data-help]') : null;
                if (!el) return;
                document.getElementById('helpTip')?.classList.remove('show');
            };
            document.addEventListener('mouseover', show);
            document.addEventListener('mouseout', hide);
            document.addEventListener('click', (event) => {
                const el = event.target.closest && event.target.closest('[data-help]');
                if (el) { show(event); setTimeout(() => document.getElementById('helpTip')?.classList.remove('show'), 4000); }
            });
            window.addEventListener('scroll', () => document.getElementById('helpTip')?.classList.remove('show'), true);
        })();

        // ===== 常用工具条：可自定义（＋添加 / －移除，存 localStorage） =====
        (function initQuickActions() {
            const STORAGE_KEY = 'echomind.quickActions';
            const pickTargets = () => {
                try {
                    if (typeof selectedSounds === 'undefined' || !selectedSounds || !selectedSounds.size) return [];
                    // 选中项可能不在当前 soundData 里（分页/搜索/文件夹视图），
                    // 统一用 resolveSoundsForIds 从所有已渲染来源解析。
                    const resolved = typeof resolveSoundsForIds === 'function'
                        ? resolveSoundsForIds([...selectedSounds])
                        : soundData.filter((item) => selectedSounds.has(item.id));
                    if (resolved.length) return resolved;
                    return soundData.filter((item) => selectedSounds.has(item.id));
                } catch (error) { return []; }
            };
            const requireTargets = (label) => {
                const targets = pickTargets();
                if (!targets.length) { showNotification('先在列表里选中要' + label + '的音效', 'info'); return null; }
                return targets;
            };
            const REGISTRY = [
                { id: 'dup', label: '重复检测', icon: 'copy-check', help: '按文件内容找完全相同的音效，每组保留一份，其余删到回收站或备份。', run: () => showDuplicatesModal() },
                { id: 'tags', label: '标签管理', icon: 'tags', help: '批量改名、合并同义标签、删除空标签，也能套用 21 个预设标签。', run: () => showTagManagerModal() },
                { id: 'rename', label: '批量重命名', icon: 'pencil-line', help: '按规则批量改文件名，先在列表里选好音效。', run: () => { const t = requireTargets('重命名'); if (t) showBatchRenameModal(t); } },
                { id: 'transcode', label: '转码', icon: 'repeat', help: '把 OGG / CAF / APE / WMA 等转成 WAV 或 MP3，先在列表里选好音效。', run: () => { const t = requireTargets('转码'); if (t) showTranscodeModal(t); } },
                { id: 'voiceLib', label: '音色库', icon: 'library', help: '管理已登记的音色：试听、改名、修正样音文稿、删除。', run: () => { showVoiceLibraryModal(); } },
                { id: 'review', label: '待归类审阅', icon: 'list-checks', help: '把 _待归类 里的文件逐个试听并移动到正确目录（保留标签与索引）。', run: () => { showReviewPanel(); } },
                { id: 'fx', label: '效果器', icon: 'sliders', help: '给当前音效加混响（房间/大厅/教堂…），可试听并导出为新文件。', run: () => { openEffectPanel(); } },
                                                { id: 'devocal', label: '去人声', icon: 'mic-off', help: '把带人声的歌做成人声消除，生成一版伴奏 WAV。会先检查声道：单声道文件做不了中置消除，会被挑出来跳过。结果先放临时区，试听后自己决定存不存、存到哪，不会写回原文件夹。', run: async () => {
                    const targets = requireTargets('去人声');
                    if (!targets) return;
                    const music = targets.filter((item) => (item.filePath || item.path || '').toLowerCase().match(/\.(mp3|wav|flac|m4a|aac|ogg)$/));
                    if (!music.length) { showNotification('选中的文件里没有可处理的音轨', 'warning'); return; }
                    // 先探声道：单声道做不了中置消除，提前挑出来，别等跑完才报失败
                    const probeChannels = async (file) => {
                        try {
                            const info = await rendererApi.get('/api/v1/audio/channels?path='
                                + encodeURIComponent(file.filePath || file.path) + '&points=50');
                            return Number(info?.channels || 0);
                        } catch (_) {
                            return 0;
                        }
                    };
                    const probed = [];
                    for (const item of music) {
                        probed.push({ item, channels: await probeChannels(item) });
                    }
                    const stereoItems = probed.filter((entry) => entry.channels >= 2).map((entry) => entry.item);
                    const monoItems = probed.filter((entry) => entry.channels < 2);
                    if (monoItems.length) {
                        const names = monoItems.slice(0, 5)
                            .map((entry) => String(entry.item.filePath || entry.item.path || '').split(/[\\/]/).pop())
                            .join('、');
                        showNotification('有 ' + monoItems.length + ' 个是单声道，做不了中置消除：' + names, 'warning');
                    }
                    if (!stereoItems.length) {
                        showNotification('选中的都是单声道，去人声需要立体声音源', 'error');
                        return;
                    }
                    if (!confirm('对 ' + stereoItems.length + ' 首立体声音乐做去人声？'
                        + (monoItems.length ? '（另外 ' + monoItems.length + ' 个单声道会跳过）' : '')
                        + '\n\n会生成一版伴奏 WAV，先放临时区，不会动原文件；试听后自己选保存位置。')) return;
                    showNotification('正在去人声，请稍候…', 'info');
                    try {
                        const result = await rendererApi.post('/api/v1/audio/remove-vocals', {
                            paths: stereoItems.map((item) => item.filePath || item.path),
                        }, { timeoutMs: 900000 });
                        const rows = (result?.results || [])
                            .filter((item) => item.ok && item.destination)
                            .map((item) => ({
                                label: String(item.source || '').split(/[\\/]/).pop() || '伴奏',
                                stemPath: item.destination,
                            }));
                        const failures = (result?.results || []).filter((item) => !item.ok);
                        if (failures.length) {
                            showNotification('有 ' + failures.length + ' 个没法处理：' + (failures[0].error || '未知原因'), 'warning');
                        }
                        if (!rows.length) {
                            if (!failures.length) showNotification('没有生成任何伴奏文件', 'warning');
                            return;
                        }
                        openAudioSaveDialog({
                            title: '去人声完成 · 试听并保存伴奏',
                            hint: '先试听，满意再保存；保存位置自己选，不会写回原文件夹。',
                            rows,
                        });
                    } catch (error) {
                        showNotification('去人声失败: ' + (error?.message || error), 'error');
                    }
                } },
                { id: 'separate', label: 'AI 分轨', icon: 'layers', help: '用 Demucs 把音乐拆成人声/鼓/贝斯/其他四条轨。结果先放临时区，试听后自己选保存哪几条、存到哪个文件夹，不会写回原文件夹。模型已内置，无需联网下载；每首十几到几十秒。', run: async () => {
                    const targets = requireTargets('分轨');
                    if (!targets) return;
                    const music = targets.filter((item) => (item.filePath || item.path || '').toLowerCase().match(/\.(mp3|wav|flac|m4a|aac|ogg)$/));
                    if (!music.length) { showNotification('选中的文件里没有可处理的音轨', 'warning'); return; }
                    if (!confirm('对 ' + music.length + ' 个文件做 AI 分轨？\n\n会分出 人声/鼓/贝斯/其他 四条轨。分轨结果先放临时区，不会动你的原始文件夹——试听后自己选要保存哪几条、存到哪。\n模型已内置，不需要联网下载；每首十几到几十秒。')) return;
                    showNotification('正在分轨，请稍候（首次加载模型会慢一点）…', 'info');
                    try {
                        const result = await rendererApi.post('/api/v1/audio/separate', {
                            paths: music.map((item) => item.filePath || item.path),
                        }, { timeoutMs: 3600000 });
                        openStemsDialog(result);
                    } catch (error) {
                        showNotification('分轨失败: ' + (error?.message || error), 'error');
                    }
                } },
                { id: 'repair', label: '修复路径', icon: 'wrench', help: '磁盘上改了文件夹名或移动了位置后，按同名同大小把库里的路径对上。', run: () => repairLibraryPaths(null) },
                { id: 'reindex', label: '修复索引', icon: 'refresh-cw', help: '只补缺少和过期的索引（波形 + 两种向量一起跑）。', run: () => runProjectIndexAction('reconcile') },
                { id: 'reindex_audio', label: '修复音频向量', icon: 'music', help: '只补「听感指纹」这一路（CLAP）。和文本向量分开跑，互不干扰。', run: () => runProjectIndexAction('reconcile', ['audio_vector']) },
                { id: 'reindex_text', label: '修复文本向量', icon: 'file-text', help: '只补「按描述搜」这一路。导入描述包之后先点这个。', run: () => runProjectIndexAction('reconcile', ['text_vector']) },
                { id: 'rebuild', label: '重建索引', icon: 'database', help: '把当前工程所有音效的索引全部重算，7 万条约 1~2 小时。', run: () => runProjectIndexAction('rebuild') },
                { id: 'importdesc', label: '导入描述包', icon: 'file-down', help: '导入别人导出的描述包或标签包（.json），一次套用几万条描述和标签；纯标签包也支持。', run: () => document.getElementById('descPackImportBtn')?.click() },
                { id: 'exportdesc', label: '导出描述包', icon: 'file-up', help: '把当前库的描述和标签导出成 json，方便换机或分享。', run: () => document.getElementById('descPackExportBtn')?.click() },
                { id: 'sfx', label: '创造音效', icon: 'sparkles', help: '用一句话生成新的音效。', run: () => document.getElementById('sfxMenuBtn')?.click() },
                { id: 'recipe', label: '拟音工坊', icon: 'sliders-horizontal', help: '按配方叠加、裁切、变速生成新音效。', run: () => document.getElementById('recipeMenuBtn')?.click() },
                { id: 'update', label: '检查更新', icon: 'download', help: '检查是否有新版本。', run: () => document.getElementById('checkUpdateMenuBtn')?.click() },
                { id: 'cleartemp', label: '清理临时文件', icon: 'trash-2', help: '清理裁切/转码产生的临时文件。', run: () => document.getElementById('clearTempClipsBtn')?.click() }
            ];
            const DEFAULTS = ['dup', 'tags', 'fx', 'transcode', 'devocal', 'rename', 'repair', 'reindex_audio', 'reindex_text'];
            // 重要新功能：老用户的已保存配置里没有的，也自动补上
            const MUST_HAVE = ['fx', 'reindex_audio', 'reindex_text'];
            const load = () => {
                try {
                    const raw = localStorage.getItem(STORAGE_KEY);
                    if (!raw) return DEFAULTS.slice();
                    const parsed = JSON.parse(raw);
                    if (!Array.isArray(parsed)) return DEFAULTS.slice();
                    return parsed.filter((id) => REGISTRY.some((item) => item.id === id));
                } catch (error) { return DEFAULTS.slice(); }
            };
            const save = (ids) => {
                try { localStorage.setItem(STORAGE_KEY, JSON.stringify(ids)); } catch (error) { }
            };
            let current = load();
            (function migrate() {
                let changed = false;
                MUST_HAVE.forEach((id, index) => {
                    if (!current.includes(id) && REGISTRY.some((item) => item.id === id)) {
                        current.splice(Math.min(index + 1, current.length), 0, id);
                        changed = true;
                    }
                });
                if (changed) save(current);
            })();
            const container = () => document.getElementById('quickActions');

            const render = () => {
                const box = container();
                if (!box) return;
                box.innerHTML = '';
                current.forEach((id) => {
                    const meta = REGISTRY.find((item) => item.id === id);
                    if (!meta) return;
                    const btn = document.createElement('button');
                    btn.className = 'quick-btn';
                    btn.setAttribute('data-help', meta.help);
                    btn.innerHTML = '<i data-lucide="' + meta.icon + '" class="w-3.5 h-3.5"></i>' + meta.label;
                    btn.addEventListener('click', () => { try { meta.run(); } catch (error) { showNotification('执行失败: ' + (error?.message || error), 'error'); } });
                    box.appendChild(btn);
                });
                if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();
            };

            const closeMenu = () => document.getElementById('quickMenu')?.remove();
            const openMenu = (mode, anchor) => {
                closeMenu();
                const menu = document.createElement('div');
                menu.id = 'quickMenu';
                menu.className = 'fixed z-[300] rounded-lg shadow-xl py-1 w-56 max-h-[60vh] overflow-y-auto';
                menu.style.background = 'var(--bg-secondary)';
                menu.style.border = '1px solid var(--border-color)';
                const rect = anchor.getBoundingClientRect();
                menu.style.left = Math.min(rect.left, window.innerWidth - 240) + 'px';
                menu.style.top = (rect.bottom + 6) + 'px';
                const pool = mode === 'add'
                    ? REGISTRY.filter((item) => !current.includes(item.id))
                    : REGISTRY.filter((item) => current.includes(item.id));
                if (!pool.length) {
                    const empty = document.createElement('div');
                    empty.className = 'px-3 py-2 text-xs opacity-50';
                    empty.textContent = mode === 'add' ? '所有功能都已添加' : '常用条是空的，点 ＋ 添加';
                    menu.appendChild(empty);
                }
                pool.forEach((meta) => {
                    const row = document.createElement('button');
                    row.className = 'w-full px-3 py-1.5 text-xs text-left hover:bg-white/5 flex items-center gap-2';
                    row.innerHTML = '<i data-lucide="' + meta.icon + '" class="w-3.5 h-3.5 opacity-70"></i>' + (mode === 'add' ? '＋ ' : '－ ') + meta.label;
                    row.addEventListener('click', () => {
                        current = mode === 'add' ? current.concat(meta.id) : current.filter((id) => id !== meta.id);
                        save(current);
                        render();
                        closeMenu();
                    });
                    menu.appendChild(row);
                });
                document.body.appendChild(menu);
                if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();
                setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 50);
            };

            document.getElementById('quickAddBtn')?.addEventListener('click', (event) => { event.stopPropagation(); openMenu('add', event.currentTarget); });
            document.getElementById('quickDelBtn')?.addEventListener('click', (event) => { event.stopPropagation(); openMenu('remove', event.currentTarget); });
            render();
        })();



        // ==================== DATA ====================
        // 初始为空，用户导入音频后会自动添加
        let soundData = [];
        let lastRenderedSounds = [];
        let allSearchResults = [];   // 全局：搜索结果列表（播放回调跨作用域引用）
        let aiResultMode = false;    // AI 搜索结果模式（滚动分批追加，不触发搜索框/数据库分页）
        let aiRenderedCount = 0;     // AI 结果已渲染条数
        let waveformLoadTimer = null;
        let waveformLoadRequestId = 0;
        let activeWaveformBackendRequestId = null;
        let waveformResizeObserver = null;

        const rendererModules = window.SoundBotRenderer;
        const rendererApi = rendererModules.api;
        const rendererState = rendererModules.state;
        const rendererAudio = rendererModules.audio;
        const rendererWaveform = rendererModules.waveform;
        const rendererSearch = rendererModules.search;
        const rendererProjects = rendererModules.projects;
        const rendererSettings = rendererModules.settings;
        const rendererRename = rendererModules.rename;
        const UNSUPPORTED_LLM_PROVIDERS = rendererSettings.unsupportedProviders;
        const getApiKeyForRequest = rendererSettings.getApiKeyForRequest;
        const setSecretInputState = (inputId, config) => rendererSettings.setSecretInputState(
            inputId,
            config,
            { document, translate: key => i18n.t(key) }
        );
        const getAiSecretUpdates = (llmProvider, embeddingProvider) => (
            rendererSettings.collectSecretUpdates(document, llmProvider, embeddingProvider)
        );
        
        // 用户自定义文件夹数据
        let userFolders = [];
        // 导入的文件夹结构数据
        let importedFolderData = [];
        // 文件夹映射关系（导入文件夹 -> 用户文件夹）
        let folderMappings = {};

        const appState = rendererState.createStore({
            currentProject: { id: 'default', name: '默认工程' }
        });
        let currentProject = appState.get('currentProject');
        let backendReady = false;
        let backendReadyHandled = false;

        const isSameOrChildPath = rendererState.isSameOrChildPath;
        const getParentPath = rendererState.parentPath;
        const isValidWaveformData = rendererWaveform.isValidData;
        const getSoundWaveform = rendererWaveform.getForSound;




        // 后端状态轮询配置
        let backendStatusCheckInterval = null;
        const BACKEND_CHECK_INTERVAL = 2000; // 每2秒检查一次
        const BACKEND_CHECK_MAX_RETRIES = 120; // 最多重试 120 次（约 240 秒，给 BGE/CLAP 预热留时间）
        let backendCheckRetryCount = 0;



        // 后端就绪后的回调

        // 监听主进程发送的后端就绪事件
        if (window.electronAPI && window.electronAPI.onBackendReady) {
            window.electronAPI.onBackendReady((event, data) => {
                console.log('[Frontend] 收到后端就绪事件:', data);
                if (data && data.success) {
                    backendReady = true;
                    onBackendReady();
                }
            });
        }

        // 分类数据（动态生成）
        let categoryData = [
            { id: 'tag-all', name: '全部', count: 0 }
        ];
        

        // ==================== STATE ====================
        let currentSound = null;
        let isPlaying = false;
        let isLooping = false;
        let playbackProgress = 0;
        let playbackInterval = null;
        let selectedSounds = new Set();
        let currentVolume = 80;
        let isMuted = false;
        let activeCategory = 'tag-all';
        
        // 播放上下文跟踪（用于智能选区播放）
        let playbackStartedInSelection = false;  // 播放开始时光标是否在选区内或选区前
        let playbackStartTime = 0;               // 播放开始时的时间（秒）
        let lastStoppedAtSelectionEnd = false;   // 上一次播放是否因为到达选区结束而停止

        // ==================== WAVEFORM ZOOM STATE ====================
        let waveformZoomLevel = 1.0;           // 当前缩放级别 (1.0 = 100%)
        let waveformScrollOffset = 0;          // 水平滚动偏移量
        let isDraggingTimeline = false;        // 是否正在拖动时间条
        let selectionStart = null;              // 选区起始时间 (秒)
        let selectionEnd = null;                // 选区结束时间 (秒)
        let isSelecting = false;                // 是否正在框选
        let selectionStartX = 0;                 // 选区起始X坐标

        const WAVEFORM_MIN_ZOOM = 1.0;
        const WAVEFORM_MAX_ZOOM = 50.0;
        const WAVEFORM_ZOOM_FACTOR = 1.1;       // 滚轮缩放因子
        const ZOOM_BUTTON_FACTOR = 1.5;         // 按钮缩放因子
        
        // ==================== 工具函数 ====================

        
        // 更新磁盘空间显示

        // 检查模型加载状态

        let indexJobRunning = false;



        let indexStatusFailures = 0;
        let indexStatusRetryTimer = null;



        // 内置知识包提示：库还没索引过、且安装目录带了包时，给一张卡片一键导入
        let knowledgeOfferChecked = false;
        // 待索引积压卡片：只在「有积压 + 没在跑 + 用户没关掉」时出现


        // kinds 可以只给一部分：音频向量和文本向量分开跑，避免两条管道互相拖死

        // ==================== NOTIFICATIONS ====================
        function showNotification(message, type = 'info', durationMs = 3000) {
            // 独立浮窗内不弹通知（后端就绪/语言等全局提示不需要）
            if (document.body.dataset.floatMode) return;
            // 创建通知元素
            const notification = document.createElement('div');
            notification.className = `notification ${type}`;
            notification.textContent = message;
            notification.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                padding: 12px 16px;
                border-radius: 8px;
                background-color: var(--bg-secondary);
                border: 1px solid var(--border-color);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
                z-index: 10000;
                animation: slideIn 0.3s ease;
            `;

            document.body.appendChild(notification);

            // 默认 3 秒；需要用户读一段话时传更长的时长
            setTimeout(() => {
                notification.style.animation = 'slideOut 0.3s ease';
                setTimeout(() => {
                    if (notification.parentNode) {
                        notification.parentNode.removeChild(notification);
                    }
                }, 300);
            }, Math.max(1000, Number(durationMs) || 3000));
        }
        
        // 添加动画样式
        const notificationStyle = document.createElement('style');
        notificationStyle.textContent = `
            @keyframes slideIn {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            @keyframes slideOut {
                from { transform: translateX(0); opacity: 1; }
                to { transform: translateX(100%); opacity: 0; }
            }
            .notification.success { border-left: 4px solid #10b981; }
            .notification.error { border-left: 4px solid #ef4444; }
            .notification.info { border-left: 4px solid #3b82f6; }
        `;
        document.head.appendChild(notificationStyle);
        
        // ==================== AUDIO PLAYER ====================
        let audioPlayer = null;
        let currentBlobUrl = null; // 追踪当前使用的 Blob URL，用于释放
        let animationFrameId = null;
        
        // 使用 requestAnimationFrame 实现毫秒级平滑播放头更新
        function startPlaybackAnimation() {
            try { fishSetPlaying(true); } catch (_) { }
            if (animationFrameId) cancelAnimationFrame(animationFrameId);
            
            function update() {
                if (audioPlayer && currentSound && isPlaying) {
                    // 直接从 audioPlayer 获取当前时间，确保毫秒级精度
                    const currentTime = audioPlayer.currentTime;
                    playbackProgress = Math.round(currentTime * 1000);
                    
                    // 检查是否播放到选区结束位置（只在播放开始时光标在选区内时才检查）
                    // 如果播放开始时光标在选区后，应该播放到音频结尾，而不是选区结束
                    if (selectionStart !== null && selectionEnd !== null && playbackStartedInSelection) {
                        const selStart = selectionStart / 1000; // 转换为秒
                        const selEnd = selectionEnd / 1000;     // 转换为秒
                        
                        // 只有播放开始时光标在选区内或选区前时，才在选区结束位置停止
                        if (currentTime >= selEnd) {
                            isPlaying = false;
                            lastStoppedAtSelectionEnd = true;  // 标记播放因到达选区结束而停止
                            pausePlayback();
                            // 移除 ended 监听器。handler 定义在下面那个点击回调内部，
                            // update() 访问不到 → 直接引用会抛 ReferenceError（11-02 用户实测：
                            // 拖拽导出时弹「handlePlaybackEnded is not defined」）。
                            // typeof 对未声明的标识符不抛错，用它守卫即可。
                            if (audioPlayer && typeof handlePlaybackEnded === 'function') {
                                audioPlayer.removeEventListener('ended', handlePlaybackEnded);
                            }
                            return;
                        }
                    }
                    // 如果播放开始时光标在选区后，则不检查选区结束位置，播放到音频结尾
                    
                    updatePlaybackUI();
                    drawMainWaveform();
                    updateChannelMeters();
                    animationFrameId = requestAnimationFrame(update);
                }
            }
            animationFrameId = requestAnimationFrame(update);
        }
        
        function stopPlaybackAnimation() {
            try { fishSetPlaying(false); } catch (_) { }
            try { updateChannelMeters(); } catch (_) { }
            if (animationFrameId) {
                cancelAnimationFrame(animationFrameId);
                animationFrameId = null;
            }
        }
        
        // ===== 搜索历史 / 播放历史 / 使用历史 =====
        const HISTORY_LIMIT = { search: 20, play: 60, usage: 80 };









        // ===== 批量选择 / 批量删除 =====
        let lastCheckedIndex = -1;

        function refreshSelectionUI() {
            document.querySelectorAll('#soundList .sound-row, #soundList > div').forEach((row) => {
                const checkbox = row.querySelector('.sound-checkbox');
                if (!checkbox) return;
                const id = checkbox.dataset.soundId || checkbox.getAttribute('data-id');
                const checked = id ? selectedSounds.has(id) : checkbox.checked;
                checkbox.checked = checked;
                row.classList.toggle('selected', checked);
            });
            document.querySelectorAll('#soundList .sound-checkbox').forEach((checkbox) => {
                const id = checkbox.dataset.soundId || checkbox.getAttribute('data-id');
                if (!id) return;
                const checked = selectedSounds.has(id);
                checkbox.checked = checked;
                checkbox.closest('div[class*="border"]')?.classList.toggle('selected', checked);
            });
        }

        // ===== 导入重复处理 =====
        let skipExistingOnImport = false;

        /**
         * 导入前发现重复时的三选一：
         *   'new'    只导入库里没有的文件（同名同大小视为重复）
         *   'all'    全部导入
         *   'cancel' 取消
         * 返回 Promise<string>，键盘 Esc = cancel，回车 = new（默认推荐）。
         */
        function showImportDuplicateChoice(precheck, pct) {
            return new Promise((resolve) => {
                document.getElementById('importDupOverlay')?.remove();
                const overlay = document.createElement('div');
                overlay.id = 'importDupOverlay';
                overlay.className = 'fixed inset-0 flex items-center justify-center';
                overlay.style.cssText = 'z-index:340;background:rgba(0,0,0,0.6)';

                const panel = document.createElement('div');
                panel.className = 'rounded-xl shadow-2xl p-5 w-[460px] flex flex-col gap-3';
                panel.style.cssText = 'background: var(--bg-secondary); border: 1px solid var(--border-color);';

                const total = precheck.total || 0;
                const existing = precheck.existing || 0;
                const fresh = Math.max(total - existing, 0);

                const title = document.createElement('div');
                title.className = 'text-sm font-semibold';
                title.textContent = '这个文件夹之前导入过';
                panel.appendChild(title);

                const desc = document.createElement('div');
                desc.className = 'text-xs leading-5 opacity-70';
                desc.textContent = '共 ' + total + ' 个文件，其中 ' + existing + ' 个（' + pct + '%）已在库里（同名同大小）。';
                panel.appendChild(desc);

                const actions = document.createElement('div');
                actions.className = 'flex flex-col gap-2 mt-1';

                const mk = (label, hint, primary, handler) => {
                    const button = document.createElement('button');
                    button.className = 'w-full text-left px-3 py-2 rounded-lg border';
                    button.style.cssText = 'border-color:' + (primary ? 'var(--accent-color, #6b8afd)' : 'var(--border-color)')
                        + '; background:' + (primary ? 'rgba(107,138,253,0.14)' : 'transparent');
                    button.innerHTML = '<div style="font-size:12px;font-weight:600">' + label + '</div>'
                        + '<div style="font-size:11px;opacity:.55;margin-top:1px">' + hint + '</div>';
                    button.addEventListener('click', handler);
                    actions.appendChild(button);
                };
                mk('只导入新文件（推荐）', '跳过 ' + existing + ' 个重复，导入剩下的 ' + fresh + ' 个', true, () => {
                    overlay.remove(); resolve('new');
                });
                mk('全部导入', '会产生 ' + existing + ' 个重复音效，之后需手动清理', false, () => {
                    overlay.remove(); resolve('all');
                });
                mk('取消', '什么都不做', false, () => {
                    overlay.remove(); resolve('cancel');
                });
                panel.appendChild(actions);

                overlay.appendChild(panel);
                overlay.addEventListener('mousedown', (event) => {
                    if (event.target === overlay) { overlay.remove(); resolve('cancel'); }
                });
                const onKey = (event) => {
                    if (event.key === 'Escape') { event.preventDefault(); cleanup(); resolve('cancel'); }
                    if (event.key === 'Enter') { event.preventDefault(); cleanup(); resolve('new'); }
                };
                const cleanup = () => {
                    document.removeEventListener('keydown', onKey, true);
                    overlay.remove();
                };
                document.addEventListener('keydown', onKey, true);
                document.body.appendChild(overlay);
            });
        }

        // ===== 声音克隆 =====
        const voiceState = { profileId: '', provider: 'volc', profiles: [], speakerId: '', lastOutput: '', samplePath: '', sampleDuration: 0 };





        // ===== 音色库管理 =====


        // ===== 大肥鱼（顶栏宠物）=====
        function fishSetPlaying(playing) {
            const wrap = document.getElementById('navFishWrap');
            if (!wrap) return;
            wrap.classList.toggle('playing', Boolean(playing));
        }

        function fishApplyVisibility() {
            const wrap = document.getElementById('navFishWrap');
            if (!wrap) return;
            const hidden = localStorage.getItem('echomind.fishHidden') === '1';
            wrap.classList.toggle('hidden-fish', hidden);
        }

        // ===== 大肥鱼 AI 助理 =====
        const fishChat = { messages: [], busy: false };








        // ===== 眨眼 / 语音 / 主动提醒 =====
        let mbBlinkTimer = null;

        // 把回复切成适合逐句合成的片段：先按句末标点切，太长的句子再按逗号切，
        // 这样第一句可以先播，后面几句边播边合成（流水线）。
        // 返回 {text, start, end}：start/end 是这段文字在整条回复里的字符偏移，
        // 语音逐段播放时用它来点亮对应句子（B21）。

        let fishSpeechGen = 0;
        let fishSpeechAudio = null;

        // 语音播到哪一句就点亮哪一句，并把气泡滚到可视区中间（B21）
        let fishHighlightGen = -1;


        // 本地 TTS 冷启动要 1 秒多，开机时有语音就预热一次，第一条回复不用多等
        if (fishVoiceEnabled()) {
            setTimeout(() => {
                rendererApi.post('/api/v1/assistant/speak', { text: '嗯' }, { timeoutMs: 30000 }).catch(() => { });
            }, 8000);
        }


        let fishEventState = null;


        // ===== 待归类审阅面板 =====
        const reviewState = { items: [], index: 0, total: 0, folder: '', keyword: '' };



        // ===== 效果器（混响）=====
        const effectState = {
            active: false,
            preset: localStorage.getItem('echomind.effectPreset') || 'room_large',
            wet: Number(localStorage.getItem('echomind.effectWet') || 0.3),
            presets: [],
            cache: new Map(),
        };






        // ===== 倍速 / 倒放 =====
        let playbackRate = Number(localStorage.getItem('echomind.playbackRate') || 1) || 1;
        let reverseMode = localStorage.getItem('echomind.reverseMode') === '1';
        const reverseSourceCache = new Map();






        // 倒放模式下优先用反向临时文件，其余照旧


        // 播放元素的四类事件统一在这里绑，切换音源时对新元素再调一次即可


        // 换音源不碰正在播的元素：新元素先加载好，再把它设成当前播放器，
        // 旧元素立刻停。这样界面上的波形/进度不会重置，也不会先静音再出声。


        // ==================== UTILS ====================
        // 时长显示：HH:MM:SS（精确到秒，不显示毫秒）
        function formatTime(ms) {
            const totalSeconds = Math.floor(Math.round(Number(ms) || 0) / 1000);
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        }

        function formatTimeShort(ms) {
            const totalSeconds = Math.floor(ms / 1000);
            const minutes = Math.floor(totalSeconds / 60);
            const seconds = totalSeconds % 60;
            return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
        
        // ==================== FOLDER TREE ====================
        // 加载用户自定义文件夹

        // 创建用户文件夹

        // 删除用户文件夹

        // 更新导入文件夹的分类

        // 文件夹展开状态缓存（避免重新渲染时丢失）
        const folderExpandedState = new Map();


        // 源目录板块自己的搜索：和顶部「搜索文件夹」互不干扰
        let sourceSearchOpen = false;
        let sourceFolderQuery = '';
        let sourceSearchComposing = false;
        let sourceSearchTimer = null;

        // 停手 200ms 再重建，别每敲一个字都把树拆了
        // 左侧当前高亮的是哪个「非文件夹」视图：all / favorites / null
        let sidebarView = null;


        // 音效库目录里的文件夹多选：Shift 连选 / Ctrl 点选，右键批量删除
        const folderMultiSelection = new Set();
        const folderNodeRegistry = new Map();
        let folderSelectionAnchor = null;




        function renderFolderTree() {
            const container = document.getElementById('folderTree');
            container.innerHTML = '';
            folderNodeRegistry.clear();

            // 两个搜索框各管各的：上面搜「我的文件夹」，下面的搜「音效库目录」
            const userQuery = (document.getElementById('folderSearchInput')?.value || '').trim().toLowerCase();
            const forceExpand = Boolean(sourceFolderQuery.trim());

            // 一个文件夹都没有时给个提示（「全部音效」那一行也一并省掉）
            if (userFolders.length === 0 && importedFolderData.length === 0) {
                const emptyTip = document.createElement('div');
                emptyTip.className = 'text-xs opacity-50 px-4 py-2 i18n-empty-folder';
                emptyTip.setAttribute('data-i18n', 'empty.folder.create');
                emptyTip.textContent = (userQuery || sourceFolderQuery.trim()) ? '没有匹配的文件夹' : '暂无文件夹，点击上方按钮创建';
                container.appendChild(emptyTip);
                return;
            }

            // 渲染用户自定义文件夹（只受顶部搜索框影响）
            const visibleUserFolders = userQuery
                ? userFolders.filter(folder => String(folder.name || '').toLowerCase().includes(userQuery))
                : userFolders;
            visibleUserFolders.forEach(folder => {
                container.appendChild(createUserFolderItem(folder));
            });

            // ===== 源目录板块：全部音效 + 还没归类的库目录 =====
            // 这里的目录来自磁盘，名字不能改；要改名就先拖进「我的文件夹」再改。
            const unclassifiedFolders = importedFolderData.filter(f => !folderMappings[f.fullPath]);
            const dirQuery = sourceFolderQuery.trim().toLowerCase();
            const visibleDirs = filterFolderNodes(unclassifiedFolders, dirQuery);

            const sourceSection = document.createElement('div');
            sourceSection.className = userFolders.length ? 'mt-4' : 'mt-1';

            const sourceHeader = document.createElement('div');
            sourceHeader.className = 'flex items-center gap-1 px-2 py-1';
            const sourceTitle = document.createElement('span');
            sourceTitle.className = 'text-[10px] font-medium uppercase tracking-wider opacity-50 flex-1 truncate';
            sourceTitle.textContent = '音效库目录 · 名称不可改';
            sourceTitle.title = '这些目录直接来自磁盘，名字不能在这里改；需要自定义名字就先归到「我的文件夹」';
            sourceHeader.appendChild(sourceTitle);

            const sourceSyncBtn = document.createElement('button');
            sourceSyncBtn.id = 'syncFoldersBtn';
            sourceSyncBtn.className = 'p-1 rounded hover:bg-white/10 transition-colors';
            sourceSyncBtn.title = '同步目录：磁盘上改了文件夹名/移了位置后，点这里把库里的路径修回来';
            sourceSyncBtn.innerHTML = '<i data-lucide="refresh-cw" class="w-3 h-3 opacity-70"></i>';
            sourceSyncBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                syncLibraryFolders();
            });
            sourceHeader.appendChild(sourceSyncBtn);
            const sourceSearchBtn = document.createElement('button');
            sourceSearchBtn.className = 'p-1 rounded hover:bg-white/10 transition-colors';
            sourceSearchBtn.title = '在本板块里搜索文件夹';
            sourceSearchBtn.innerHTML = '<i data-lucide="search" class="w-3 h-3 opacity-70"></i>';
            sourceSearchBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                sourceSearchOpen = !sourceSearchOpen;
                renderFolderTree();
                const box = document.getElementById('sourceFolderSearchInput');
                if (box) box.focus();
            });
            sourceHeader.appendChild(sourceSearchBtn);

            const sourceRefreshBtn = document.createElement('button');
            sourceRefreshBtn.id = 'sourceRefreshBtn';
            sourceRefreshBtn.className = 'p-1 rounded hover:bg-white/10 transition-colors';
            sourceRefreshBtn.title = '重新读取目录：核对磁盘，把新增的音效补进来（约 20 秒）';
            sourceRefreshBtn.innerHTML = '<i data-lucide="refresh-cw" class="w-3 h-3 opacity-70"></i>';
            sourceRefreshBtn.addEventListener('click', async (event) => {
                event.stopPropagation();
                if (sourceRefreshBtn.dataset.busy === '1') return;
                sourceRefreshBtn.dataset.busy = '1';
                sourceRefreshBtn.style.opacity = '0.4';
                try {
                    // 以前这里只重读数据库，磁盘上新增的文件永远不会出现。
                    // 扫一遍磁盘再刷新：没有新文件就只是刷新树（18.7 秒的扫描）。
                    if (typeof rescanLibraryInto === 'function') {
                        await rescanLibraryInto(() => {});
                    }
                    await loadUserFolders();
                    await loadFolderStats(true);
                    if (typeof loadFilesFromDatabase === 'function') {
                        await loadFilesFromDatabase();
                    }
                    renderFolderTree();
                } catch (error) {
                    showNotification('重新读取目录失败: ' + (error?.message || error), 'error');
                } finally {
                    sourceRefreshBtn.dataset.busy = '';
                    sourceRefreshBtn.style.opacity = '';
                }
            });
            sourceHeader.appendChild(sourceRefreshBtn);
            sourceSection.appendChild(sourceHeader);

            if (sourceSearchOpen) {
                const searchWrap = document.createElement('div');
                searchWrap.className = 'px-2 pb-1';
                const box = document.createElement('input');
                box.id = 'sourceFolderSearchInput';
                box.type = 'text';
                box.placeholder = '搜索这里的文件夹…';
                box.className = 'w-full px-2 py-1 rounded-md border text-xs';
                box.style.cssText = 'background-color: var(--bg-secondary); border-color: var(--border-color); color: var(--text-primary);';
                box.value = sourceFolderQuery;
                // 中文输入法合成期间不能重建 DOM，否则候选词直接没了（中文打不进去）
                box.addEventListener('compositionstart', () => { sourceSearchComposing = true; });
                box.addEventListener('compositionend', () => {
                    sourceSearchComposing = false;
                    scheduleSourceSearch();
                });
                box.addEventListener('input', (event) => {
                    if (sourceSearchComposing || event.isComposing) return;
                    scheduleSourceSearch();
                });
                searchWrap.appendChild(box);
                sourceSection.appendChild(searchWrap);
            }

            // 「全部音效」：任何时候都能一键回到整个库（点了「常用」之后也不例外）
            const allRow = document.createElement('div');
            allRow.id = 'allSoundsRow';
            allRow.className = 'sidebar-item rounded-md cursor-pointer flex items-center gap-2 px-2 py-1.5 text-sm'
                + (sidebarView === 'all' ? ' active' : '');
            allRow.innerHTML = '<i data-lucide="library" class="w-3.5 h-3.5 opacity-70"></i>'
                + '<span class="flex-1 truncate">全部音效</span>'
                + '<span id="allSoundsCount" class="text-[10px] opacity-40">' + (fileListTotal || '') + '</span>';
            allRow.addEventListener('click', () => {
                document.querySelectorAll('#folderTree .sidebar-item').forEach(el => el.classList.remove('active'));
                allRow.classList.add('active');
                showAllSounds();
            });
            sourceSection.appendChild(allRow);

            visibleDirs.forEach(folder => {
                sourceSection.appendChild(createImportedFolderItem(folder, 0, true, forceExpand || Boolean(dirQuery)));
            });
            if (visibleDirs.length === 0 && dirQuery) {
                const noMatch = document.createElement('div');
                noMatch.className = 'text-xs opacity-40 px-3 py-1';
                noMatch.textContent = '没有匹配的文件夹';
                sourceSection.appendChild(noMatch);
            }
            container.appendChild(sourceSection);

            lucide.createIcons();
        }

        // 局部更新文件夹展开状态（不重新渲染整个树）

        // 重命名用户文件夹


        // 当前正在看的「我的文件夹」：只有在这个视图下，右键才提供「移出」
        let activeUserFolder = null;   // { id, name, childFolders, sounds }

        // 统一走「后端按路径取文件」的成熟通道：
        // 映射目录用 /files?folder=，手动加入的用 /folders/{id}/files

        // 从「我的文件夹」里移出成员：只取消归类，不动磁盘文件
        // 显示文件夹右键菜单


        // 显示移动到文件夹菜单

        // 兜底：任何脚本错误都显示出来，而不是整页变黑

        window.addEventListener('error', (event) => {
            reportUiError('脚本错误', event.error || event.message);
        });
        window.addEventListener('unhandledrejection', (event) => {
            reportUiError('未处理的异常', event.reason);
        });

        // ==================== 声音配方 ====================
        const recipeState = {
            recipes: [],
            current: null,
            player: null,
            recording: false,
            startedAt: 0,
            events: [],
            lastSession: null,
            timer: null,
            sample: null,
            variation: 1,
            takes: [],
            enabled: new Set(),
            layerSamples: {},
            ambiencePlaying: false,
            padDragging: false,
        };

        async function openRecipeModal() {
            const modal = document.getElementById('recipeModal');
            if (!modal) return;
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            if (!recipeState.recipes.length) {
                try {
                    const data = await rendererApi.get('/api/v1/recipes');
                    recipeState.recipes = (data && data.recipes) || [];
                } catch (error) {
                    showNotification('读取配方失败: ' + error.message, 'error');
                }
            }
            renderRecipeList();
        }

        function renderRecipeList() {
            const list = document.getElementById('recipeList');
            if (!list) return;
            list.innerHTML = '';
            const groups = {};
            recipeState.recipes.forEach((recipe) => {
                (groups[recipe.category] = groups[recipe.category] || []).push(recipe);
            });
            Object.keys(groups).forEach((category) => {
                const head = document.createElement('div');
                head.className = 'px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider opacity-50';
                head.textContent = category;
                list.appendChild(head);
                groups[category].forEach((recipe) => {
                    const item = document.createElement('button');
                    item.className = 'w-full text-left px-2 py-1.5 rounded-md text-sm hover:bg-white/5'
                        + (recipe.usable ? '' : ' opacity-40 cursor-not-allowed');
                    item.textContent = recipe.name;
                    item.disabled = !recipe.usable;
                    item.addEventListener('click', () => selectRecipe(recipe));
                    list.appendChild(item);
                });
            });
        }

        // ===== 环境音：可循环的无缝环境床，拖动时交叉淡化换气 =====
        let ambiencePlayer = null;
        let ambienceTimer = null;
        let ambiencePending = false;
        let ambienceLastAt = 0;







        // ===== 环境音：4 条音轨常驻循环，拖动只改音量（结构上不可能断层）=====
        let stemsState = null;
        let stemsTicker = null;
        let stemsCtx = null;

        // x = 远近（0 远 / 1 近），y = 强度（0 轻 / 1 重）
        // 每条音轨在混音里的"角色权重"：底噪刻意压低，细节层才是主导
        const STEM_ROLE = {
            base: 0.16, mid: 0.30, drops: 0.60, accent: 0.38,
            gust: 0.45, strong: 0.62, surge: 0.50, foam: 0.40, air: 0.32,
        };
        const STEM_HIGH = new Set(['drops', 'accent', 'foam', 'air']);













        // 试听共用一条音频通道：新的播放会先停掉旧的，避免两条叠在一起
        let recipeAudio = null;
        let recipeAudioOwner = null;









        // ==================== 文件夹右键管理 ====================



        // 批量删除音效库目录里的多个文件夹（Shift 多选后右键进来）

        // 删除文件夹：先弹窗让用户明确选择「只删库内记录」还是「连源文件一起删」


        // ==================== CATEGORY TREE ====================
