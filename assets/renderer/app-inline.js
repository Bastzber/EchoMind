
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
        function renderCategoryTree() {
            const container = document.getElementById('categoryTree');
            if (!container) return;
            container.innerHTML = '';

            // 只渲染用户自定义标签；"全部/其他"这类默认分类已取消。
            // 计数优先用后端全库统计（soundData 只是分页加载的一部分）
            // ===== 收藏夹 =====
            const favRow = document.createElement('div');
            favRow.id = 'favoriteRow';
            favRow.className = 'sidebar-item rounded-md cursor-pointer flex items-center gap-1.5 px-2 py-1 text-sm'
                + (sidebarView === 'favorites' ? ' active' : '');
            favRow.innerHTML = `<span style="color:#f59e0b;">★</span>
                <span class="flex-1 truncate">收藏</span>
                <span id="favoriteCount" class="text-[10px] opacity-40">0</span>`;
            favRow.addEventListener('click', () => {
                // 再点一次就退出收藏，回到全部音效 —— 之前选了就取消不掉
                if (sidebarView === 'favorites') {
                    showAllSounds();
                    return;
                }
                document.querySelectorAll('#categoryTree .sidebar-item, #folderTree .sidebar-item').forEach((el) => el.classList.remove('active'));
                favRow.classList.add('active');
                setSidebarView('favorites');
                showFavorites();
            });
            container.appendChild(favRow);

            // ===== 我的标签分组 =====
            const tagHeader = document.createElement('div');
            tagHeader.className = 'px-2 pt-3 pb-1 text-[10px] font-medium uppercase tracking-wider opacity-50 flex items-center justify-between';
            tagHeader.innerHTML = `
                <span class="flex items-center"><i data-lucide="tags" class="w-3 h-3 mr-1"></i>我的标签</span><span class="help-dot ml-1" data-help="我的标签&#10;&#10;一个音效可以打多个标签，用来表达类型、场景、声音特性。&#10;右键标签：改名 / 删除 / 合并。&#10;把标签拖到另一个标签上，就是合并。&#10;默认只显示常用的 14 个，点下面的「查看全部」展开。">?</span>
                <span class="flex items-center gap-1">
                    <button id="createTagBtn" class="p-0.5 rounded hover:bg-white/10 transition-colors" title="新建标签">
                        <i data-lucide="plus" class="w-3 h-3"></i>
                    </button>
                    <button id="tagManagerBtn" class="p-0.5 rounded hover:bg-white/10 transition-colors" title="标签管理">
                        <i data-lucide="settings-2" class="w-3 h-3"></i>
                    </button>
                </span>
            `;
            container.appendChild(tagHeader);

            // ===== M4：场景 / 属性双层 =====
            const layered = window.__tagLayers || { scene: [], attr: [] };
            const layeredNames = new Set();
            const renderLayerGroup = (title, items) => {
                if (!items || !items.length) return;
                const head = document.createElement('div');
                head.className = 'px-2 pt-2 pb-0.5 text-[10px] font-medium uppercase tracking-wider opacity-40';
                head.textContent = title;
                container.appendChild(head);
                items.forEach((item) => {
                    layeredNames.add(item.name);
                    const row = document.createElement('div');
                    row.className = 'sidebar-item rounded-md cursor-pointer flex items-center gap-1.5 px-2 py-1 text-sm';
                    attachTagSidebarInteractions(row, item.name);
                    row.innerHTML = `<i data-lucide="${item.layer === 'scene' ? 'clapperboard' : 'tag'}" class="w-3 h-3 opacity-60"></i>
                        <span class="flex-1 truncate">${escapeHtml(item.name)}</span>
                        <span class="text-[10px] opacity-40">${item.count || 0}</span>`;
                    row.addEventListener('click', async () => {
                        activeCategory = 'mytag:' + item.name;
                        activeUserFolder = null; // 换视图了，移出入口不再适用
                        setSidebarView(null);
                        document.querySelectorAll('#categoryTree .sidebar-item').forEach((el) => el.classList.remove('active'));
                        row.classList.add('active');
                        try {
                            const page = await rendererApi.get(
                                '/api/v1/files?limit=500&tag=' + encodeURIComponent(item.name)
                                + '&project_id=' + encodeURIComponent(currentProject?.id || 'default')
                            );
                            const list = (page && page.files) || [];
                            allSearchResults = list.map(mapDbFileToSound);
                            renderSoundList('', allSearchResults);
                            showNotification(`标签「${item.name}」共 ${list.length} 个音效`, 'info');
                        } catch (error) {
                            showNotification('按标签筛选失败: ' + error.message, 'error');
                        }
                    });
                    container.appendChild(row);
                });
            };
            loadFavoriteCount();
            renderLayerGroup('场景', layered.scene);
            renderLayerGroup('属性', layered.attr);
            if (!layered.scene.length && !layered.attr.length) {
                const hint = document.createElement('div');
                hint.className = 'px-2 py-1 text-[10px] opacity-40';
                hint.textContent = '右键标签可设为场景或属性';
                container.appendChild(hint);
            }

            // 左侧标签面板只列「用户自己建的标签」（tags 表）；
            // 每个音效自带的标签（第三方 6 维标注等）在主列表里显示，不在这里刷屏。
            const tagCounts = {};
            const layeredNow = window.__tagLayers || { scene: [], attr: [] };
            [...(layeredNow.scene || []), ...(layeredNow.attr || [])].forEach((item) => {
                const name = item && item.name;
                if (name) tagCounts[name] = Number(item.count) || 0;
            });
            (window.__localTags || []).forEach(name => {
                if (name && !(name in tagCounts)) tagCounts[name] = 0;
            });
            const allTagNames = Object.keys(tagCounts)
                .filter((name) => !layeredNames.has(name))
                .sort((a, b) => (tagCounts[b] - tagCounts[a]) || a.localeCompare(b, 'zh'));
            const tagQuery = (document.getElementById('tagSearchInput')?.value || '').trim().toLowerCase();
            const showLegacyList = allTagNames.length > 0;
            const tagNames = tagQuery
                ? allTagNames.filter(name => name.toLowerCase().includes(tagQuery))
                : allTagNames;

            const hasLayered = (layered.scene && layered.scene.length) || (layered.attr && layered.attr.length);

            // 侧边栏只放常用的十几个标签，全量在「标签管理」里看
            const TAG_SIDEBAR_LIMIT = 14;
            const tagExpanded = window.__tagSidebarExpanded === true;
            const visibleTagNames = tagQuery
                ? tagNames
                : (tagExpanded ? tagNames : tagNames.slice(0, TAG_SIDEBAR_LIMIT));
            if (tagNames.length === 0 && tagQuery) {
                const emptyTag = document.createElement('div');
                emptyTag.className = 'px-2 py-1.5 text-xs opacity-40';
                emptyTag.textContent = '没有匹配的标签';
                container.appendChild(emptyTag);
            }

            visibleTagNames.forEach(tag => {
                const div = document.createElement('div');
                div.className = `sidebar-item rounded-md cursor-pointer ${activeCategory === 'mytag:' + tag ? 'active' : ''}`;
                div.dataset.id = 'mytag:' + tag;
                div.innerHTML = `
                    <div class="flex items-center gap-2 py-1.5 px-2 rounded-md">
                        <i data-lucide="tag" class="w-3.5 h-3.5 opacity-60 shrink-0"></i>
                        <span class="text-sm flex-1 truncate">${escapeHtml(tag)}</span>
                        <span class="text-xs opacity-50">${tagCounts[tag]}</span>
                    </div>
                `;
                div.addEventListener('click', () => {
                    activeCategory = 'mytag:' + tag;
                    activeUserFolder = null; // 换视图了，移出入口不再适用
                    setSidebarView(null);
                    document.querySelectorAll('#categoryTree .sidebar-item').forEach(item => item.classList.remove('active'));
                    div.classList.add('active');
                    filterByCategory('mytag:' + tag);
                });

                attachTagSidebarInteractions(div, tag);
                container.appendChild(div);
            });

            if (!tagQuery && tagNames.length > TAG_SIDEBAR_LIMIT) {
                const moreRow = document.createElement('div');
                moreRow.className = 'sidebar-item rounded-md cursor-pointer px-2 py-1 text-xs opacity-60 hover:opacity-90';
                moreRow.textContent = tagExpanded
                    ? '收起标签（只看常用的）'
                    : '查看全部 ' + tagNames.length + ' 个标签…';
                moreRow.addEventListener('click', () => {
                    window.__tagSidebarExpanded = !tagExpanded;
                    renderCategoryTree();
                });
                container.appendChild(moreRow);
            }

            // 右键：在标签面板上直接新建标签
            container.addEventListener('contextmenu', (event) => {
                if (!event.target.closest('#tagPanelSection') && !event.target.closest('#tagSection')) return;
                event.preventDefault();
                document.getElementById('tagPanelMenu')?.remove();
                const menu = document.createElement('div');
                menu.id = 'tagPanelMenu';
                menu.className = 'fixed rounded-md shadow-xl border py-1 text-xs';
                menu.style.cssText = 'z-index:340;background:var(--bg-secondary);border-color:var(--border-color);min-width:150px';
                const mk = (label, handler) => {
                    const item = document.createElement('button');
                    item.className = 'block w-full text-left px-3 py-1.5 hover:bg-white/10';
                    item.textContent = label;
                    item.addEventListener('click', () => { menu.remove(); handler(); });
                    menu.appendChild(item);
                };
                mk('新建场景标签', () => createNewTag('scene'));
                mk('新建属性标签', () => createNewTag('attr'));
                mk('标签管理…', () => showTagManagerModal());
                menu.style.left = Math.min(event.clientX, window.innerWidth - 170) + 'px';
                menu.style.top = Math.min(event.clientY, window.innerHeight - 130) + 'px';
                document.body.appendChild(menu);
                setTimeout(() => {
                    const close = (e) => {
                        if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', close); }
                    };
                    document.addEventListener('mousedown', close);
                }, 0);
            });

            const createTagBtn = container.querySelector('#createTagBtn');
            if (createTagBtn) {
                createTagBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    createNewTag();
                });
            }

            const tagManagerBtn = container.querySelector('#tagManagerBtn');
            if (tagManagerBtn) {
                tagManagerBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showTagManagerModal();
                });
            }
            lucide.createIcons();
        }

        // 从后端拿全库标签统计（本地 soundData 只有分页加载的一部分）

        // 标签右键：切换场景/属性层、删除

        // ===== 侧边栏标签：右键改名/删除，拖拽合并 =====
        const tagProjectQuery = () => '?project_id=' + encodeURIComponent(currentProject?.id || 'default');







        // 给音效打标签：场景单选、属性多选


        // 新建标签：一个弹窗里同时选层级 + 输名字（不再用原生 confirm，避免焦点丢失）

        
        // 按文件夹筛选

        // ==================== 音效详情面板 ====================
        let detailPanelOpen = false;






        // 保存按钮就地反馈：保存中… → ✓ 已保存（2 秒后复原）/ 保存失败


        // 失败要抛出去，按钮才能显示「保存失败」

        // ---- 标签管理面板 ----
        // 标签管理（批量：改名 / 合并 / 删除 / 套用预设模板）
        // ==================== PLAYBACK ====================
        let playPromise = null; // 跟踪播放 Promise


        
        // 仅更新播放按钮状态，避免重绘整个列表导致波形闪烁
        

        /**
         * 播放进度（0~1）。倒放时时间轴是反的：
         * 反向文件从 0 播到结尾，对应原文件的结尾到开头，
         * 所以进度条要从右往左走。
         */



        // ==================== 缩放显示更新 ====================
        function updateZoomDisplay() {
            const zoomDisplay = document.getElementById('zoomLevelDisplay');
            if (zoomDisplay) {
                const percent = Math.round(waveformZoomLevel * 100);
                zoomDisplay.textContent = `${percent}%`;
            }
        }

        // ==================== MAIN WAVEFORM ====================
        
        // 更新拖拽手柄位置（严格绑定选区）

        // 绘制装饰性波形（空状态）
        // 绘制细腻线条波形（类似专业音频编辑器）
        // ==================== AI CHAT ====================

        let chatHistory = [];  // 对话历史
        let isAiResponding = false;  // AI 是否正在响应








        // 搜索结果只有文件名和分数：按 id 批量补描述和标签，补到了再重画一次


        // AI 搜索：直接从搜索框发起，结果渲染进主列表（不再依赖右侧聊天面板）

        // 追加渲染 AI 搜索结果 [startIdx, endIdx)


        // ==================== SETTINGS MODAL ====================









        // ==================== 关于回声 ====================
        async function showAboutDialog() {
            document.getElementById('aboutDialog')?.remove();
            const overlay = document.createElement('div');
            overlay.id = 'aboutDialog';
            overlay.className = 'fixed inset-0 z-[300] flex items-center justify-center';
            overlay.style.backgroundColor = 'rgba(0,0,0,0.5)';

            let version = '0.3.0-beta.10';
            try { version = await window.electronAPI.updates.version(); } catch (_) { }

            const panel = document.createElement('div');
            panel.className = 'rounded-lg shadow-2xl p-5 w-[380px] max-w-[92vw]';
            panel.style.backgroundColor = 'var(--bg-secondary)';
            panel.style.border = '1px solid var(--border-color)';
            panel.innerHTML = `
                <div class="flex items-center gap-3 mb-4">
                    <div class="w-10 h-10 rounded-xl flex items-center justify-center" style="background:linear-gradient(135deg,#8b5cf6,#22d3ee);">
                        <span class="text-white font-semibold">E</span>
                    </div>
                    <div>
                        <div class="text-base font-semibold">回声 EchoMind</div>
                        <div class="text-xs opacity-50 font-mono">v${escapeHtml(version)}</div>
                    </div>
                </div>
                <p class="text-xs opacity-60 leading-5 mb-4">AI 音效管理器 · 本地索引与语义搜索，不依赖云端。</p>
                <div class="flex items-center gap-2 mb-4">
                    <button id="aboutCheckUpdateBtn" class="px-3 py-1.5 rounded-md text-sm text-white" style="background:#8b5cf6;">检查更新</button>
                    <button id="aboutOpenLogBtn" class="px-3 py-1.5 rounded-md text-sm border" style="border-color: var(--border-color);">日志目录</button>
                </div>
                <label class="flex items-center gap-2 text-[11px] opacity-45 cursor-pointer select-none">
                    <input type="checkbox" id="aboutTelemetryToggle">
                    <span>匿名使用统计（仅计数，不含个人信息）</span>
                </label>
                <div id="aboutTelemetryStatus" class="text-[11px] opacity-35 mt-1"></div>
                <div class="flex justify-end mt-4">
                    <button id="aboutCloseBtn" class="px-3 py-1.5 rounded-md text-sm border" style="border-color: var(--border-color);">关闭</button>
                </div>`;
            overlay.appendChild(panel);
            overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) overlay.remove(); });
            document.body.appendChild(overlay);

            panel.querySelector('#aboutCloseBtn').addEventListener('click', () => overlay.remove());
            panel.querySelector('#aboutCheckUpdateBtn').addEventListener('click', () => {
                overlay.remove();
                checkForUpdatesFromMenu();
            });
            panel.querySelector('#aboutOpenLogBtn')?.addEventListener('click', async () => {
                try { await window.electronAPI.backendAPI?.openLogDirectory?.(); } catch (_) { }
            });

            const toggle = panel.querySelector('#aboutTelemetryToggle');
            const status = panel.querySelector('#aboutTelemetryStatus');
            try {
                const res = await window.electronAPI.telemetry.get();
                toggle.checked = res?.enabled !== false;
                status.textContent = toggle.checked ? '已开启' : '已关闭，不再发送任何统计请求';
            } catch (_) { }
            toggle.addEventListener('change', async () => {
                try {
                    const res = await window.electronAPI.telemetry.set(toggle.checked);
                    status.textContent = res?.enabled ? '已开启' : '已关闭，不再发送任何统计请求';
                } catch (_) {
                    toggle.checked = !toggle.checked;
                    status.textContent = '保存失败，请重试';
                }
            });
        }

        // ==================== 检查更新（下拉菜单入口） ====================



        // 安装本地增量更新包：只替换变化的文件，不碰 %APPDATA% 里的用户数据


        // ==================== SETTINGS ====================
        function toggleSettings() {
            const dropdown = document.getElementById('settingsDropdown');
            dropdown.classList.toggle('hidden');
            dropdown.classList.toggle('visible');
            
            // 打开设置时加载当前临时文件目录
            if (!dropdown.classList.contains('hidden')) {
                loadTempDir();
                fillMenuVersion();
            }
        }
        
        // 加载临时文件目录
        async function loadTempDir() {
            const tempDirText = document.getElementById('tempDirText');
            const permissionHint = document.getElementById('tempDirPermissionHint');
            try {
                if (window.electronAPI && window.electronAPI.backendAPI) {
                    const result = await window.electronAPI.backendAPI.getTempDir();
                    if (result && result.temp_dir) {
                        // 显示路径的最后一部分
                        const displayName = getPathDisplayName(result.temp_dir);
                        tempDirText.textContent = displayName;
                        tempDirText.title = result.temp_dir; // 完整路径作为 tooltip
                        
                        // 检查是否需要权限提示（非应用目录）
                        const appDir = await window.electronAPI.getAppPath();
                        if (appDir && !result.temp_dir.startsWith(appDir)) {
                            permissionHint.classList.remove('hidden');
                            lucide.createIcons();
                        } else {
                            permissionHint.classList.add('hidden');
                        }
                    } else {
                        tempDirText.textContent = '默认目录';
                        permissionHint.classList.add('hidden');
                    }
                } else {
                    tempDirText.textContent = '默认目录';
                    permissionHint.classList.add('hidden');
                }
            } catch (error) {
                console.error('加载临时文件目录失败:', error);
                tempDirText.textContent = '默认目录';
                permissionHint.classList.add('hidden');
            }
        }
        
        // 选择临时文件目录
        async function selectTempDir() {
            try {
                if (window.electronAPI && window.electronAPI.dialogs) {
                    // 如果是 macOS，先检查权限
                    if (window.electronAPI.platform === 'darwin') {
                        const hasPermission = await window.electronAPI.checkFullDiskAccess?.();
                        if (hasPermission === false) {
                            const grant = confirm('选择非应用目录需要完全磁盘访问权限。是否打开系统设置授权？');
                            if (grant) {
                                await window.electronAPI.openPrivacySettings?.();
                            }
                        }
                    }
                    
                    const result = await window.electronAPI.dialogs.showOpenDialog({
                        properties: ['openDirectory'],
                        title: '选择临时文件存放目录',
                        buttonLabel: '选择此文件夹',
                        message: '提示：macOS 系统可能需要授予磁盘访问权限才能写入所选目录'
                    });
                    
                    if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
                        const selectedPath = result.filePaths[0];
                        
                        // 检查是否为应用目录（macOS 权限限制）
                        const appDir = await window.electronAPI.getAppPath?.();
                        const isAppDir = appDir && selectedPath.startsWith(appDir);
                        
                        // 发送到后端保存
                        if (window.electronAPI && window.electronAPI.backendAPI) {
                            const saveResult = await window.electronAPI.backendAPI.setTempDir(selectedPath);
                            if (saveResult && (saveResult.success !== false)) {
                                // 更新显示
                                const displayName = getPathDisplayName(selectedPath);
                                const tempDirText = document.getElementById('tempDirText');
                                const permissionHint = document.getElementById('tempDirPermissionHint');
                                tempDirText.textContent = displayName;
                                tempDirText.title = selectedPath;
                                updateDiskSpaceDisplay();
                                
                                // 显示或隐藏权限提示
                                if (!isAppDir && window.electronAPI.platform === 'darwin') {
                                    permissionHint.classList.remove('hidden');
                                    lucide.createIcons();
                                    showNotification(`临时文件目录已设置。如无法写入，请授予磁盘访问权限`, 'warning');
                                } else {
                                    permissionHint.classList.add('hidden');
                                    showNotification(`临时文件目录已设置为: ${selectedPath}`, 'success');
                                }
                            } else {
                                // 保存失败，可能是权限问题
                                if (!isAppDir && window.electronAPI.platform === 'darwin') {
                                    const retry = confirm('设置失败，可能是 macOS 磁盘访问权限限制。是否打开系统设置授权？');
                                    if (retry) {
                                        await window.electronAPI.openPrivacySettings?.();
                                    }
                                } else {
                                    showNotification('设置临时文件目录失败: ' + (saveResult.detail || saveResult.error || '未知错误'), 'error');
                                }
                            }
                        }
                    }
                } else {
                    showNotification('对话框功能不可用', 'error');
                }
            } catch (error) {
                console.error('选择临时文件目录失败:', error);
                showNotification('选择临时文件目录失败: ' + error.message, 'error');
            }
        }
        
        // 恢复默认临时文件目录
        async function resetTempDirToDefault() {
            try {
                if (window.electronAPI && window.electronAPI.backendAPI) {
                    // 获取默认路径
                    const result = await window.electronAPI.backendAPI.getTempDir();
                    const defaultPath = result.default_dir || '/tmp/soundmind';
                    
                    // 保存默认路径
                    const saveResult = await window.electronAPI.backendAPI.setTempDir(defaultPath);
                    if (saveResult && (saveResult.success !== false)) {
                        // 更新显示
                        const displayName = getPathDisplayName(defaultPath);
                        const tempDirText = document.getElementById('tempDirText');
                        const permissionHint = document.getElementById('tempDirPermissionHint');
                        tempDirText.textContent = displayName;
                        tempDirText.title = defaultPath;
                        permissionHint.classList.add('hidden');
                        updateDiskSpaceDisplay();
                        
                        showNotification(`已恢复默认路径: ${defaultPath}`, 'success');
                    } else {
                        showNotification('恢复默认路径失败: ' + (saveResult.detail || saveResult.error || '未知错误'), 'error');
                    }
                }
            } catch (error) {
                console.error('恢复默认路径失败:', error);
                showNotification('恢复默认路径失败: ' + error.message, 'error');
            }
        }

        // ==================== 工程管理 ====================

        // 初始化工程管理
        function initProjectManagement() {
            // 文件菜单按钮
            const fileMenuBtn = document.getElementById('fileMenuBtn');
            const fileDropdown = document.getElementById('fileDropdown');

            fileMenuBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                fileDropdown.classList.toggle('hidden');
                fileDropdown.classList.toggle('visible');
            });

            // 点击其他地方关闭文件菜单
            document.addEventListener('click', (e) => {
                if (!e.target.closest('#fileDropdown') && !e.target.closest('#fileMenuBtn')) {
                    fileDropdown.classList.add('hidden');
                    fileDropdown.classList.remove('visible');
                }
            });

            // 新建工程按钮
            document.getElementById('newProjectBtn').addEventListener('click', (e) => {
                e.stopPropagation();
                showNewProjectModal();
                fileDropdown.classList.add('hidden');
                fileDropdown.classList.remove('visible');
            });

            // 打开工程按钮
            document.getElementById('openProjectBtn').addEventListener('click', (e) => {
                e.stopPropagation();
                showOpenProjectModal();
                fileDropdown.classList.add('hidden');
                fileDropdown.classList.remove('visible');
            });

            // 最近工程按钮
            document.getElementById('recentProjectsBtn').addEventListener('click', (e) => {
                e.stopPropagation();
                showOpenProjectModal(true); // 显示最近工程
                fileDropdown.classList.add('hidden');
                fileDropdown.classList.remove('visible');
            });

            // 新建工程弹窗事件
            document.getElementById('closeNewProjectModal').addEventListener('click', hideNewProjectModal);
            document.getElementById('cancelNewProjectBtn').addEventListener('click', hideNewProjectModal);
            document.getElementById('confirmNewProjectBtn').addEventListener('click', createNewProject);
            document.getElementById('selectProjectTempDirBtn').addEventListener('click', selectProjectTempDir);

            // 打开工程弹窗事件
            document.getElementById('closeOpenProjectModal').addEventListener('click', hideOpenProjectModal);
            document.getElementById('cancelOpenProjectBtn').addEventListener('click', hideOpenProjectModal);

        }

        // 显示新建工程弹窗
        function showNewProjectModal() {
            const modal = document.getElementById('newProjectModal');
            modal.classList.remove('hidden');
            modal.classList.add('flex');

            // 清空表单
            document.getElementById('newProjectName').value = '';
            document.getElementById('newProjectDesc').value = '';
            document.getElementById('newProjectTempDir').value = '';

            lucide.createIcons();
        }

        // 隐藏新建工程弹窗
        function hideNewProjectModal() {
            const modal = document.getElementById('newProjectModal');
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }

        // ==================== 通用输入弹窗 ====================
        let inputModalCallback = null;




        // 选择工程临时文件目录

        // 创建新工程

        // 显示打开工程弹窗

        // 隐藏打开工程弹窗

        // 加载工程列表

        // 删除工程

        // 切换到指定工程

        // 加载当前工程信息

        // ==================== 首次启动设置弹窗 ====================
        let firstTimeSelectedPath = null;
        
        // 显示首次启动弹窗
        
        // 隐藏首次启动弹窗
        
        // 首次启动选择目录
        
        // 首次启动使用默认路径
        
        // 首次启动确认设置
        
        // 检查是否需要显示首次启动弹窗



        // ==================== WEB SOCKET 管理 ====================

        // 连接到 WebSocket 获取扫描进度

        // WebSocket is a progress enhancement, not the source of truth for a
        // durable import job. Poll the job endpoint when the socket cannot be
        // established so a firewall/CSP issue cannot leave a successful import
        // looking permanently stuck in the UI.

        // 播放器区域右键：和列表面板一致的菜单（添加标签、打开位置等）

        // 处理扫描消息

        // 处理扫描日志 - 在 F12 控制台显示详细日志

        // 处理文件夹结构 - 将后端传来的结构转换为前端格式

        // 将后端 FolderNode 转换为前端 importedFolderData 格式

        // 扫描进度弹窗

        // 「等一下再取消」：弹窗取消了但任务 id 还没回来时用
        let scanCancelRequested = false;



        // 每次把 importRuntime.currentScanTaskId 赋好之后都调一下：如果用户已经点过取消，立刻补发



        let scanCompletionHandled = false;


        // 导入结束后提示重复情况（点「去处理」直接打开重复检测）


        // 从 SQLite 数据库加载文件列表（启动时调用）
        let fileListNextCursor = null;
        let fileListLoading = false;
        let fileListTotal = 0;
        let fileListLoadToken = 0;

        // 从已加载的音频路径反推文件夹树（含每个文件夹的文件数）。
        // 导入时建立的树只存在于内存，重启就没了；这里让文件夹视图可持久化。
        let folderTreeBuiltCount = -1;
        let folderTreeBuiltAt = 0;


        // ==================== 目录同步（磁盘 → 库） ====================
        let lastFolderSyncCheck = 0;
        let folderDriftNotified = false;

        async function checkFolderDrift({ notify = false } = {}) {
            try {
                const health = await rendererApi.get('/api/v1/db/library/folder-health');
                if (!health || health.success === false) return null;
                const drifted = Number(health.missing_count || 0) > 0;
                const btn = document.getElementById('syncFoldersBtn');
                if (btn) {
                    btn.title = drifted
                        ? `${health.missing_count} 个目录在磁盘上不存在（涉及 ${health.missing_files} 个文件），点这里修复`
                        : '目录与磁盘一致';
                    btn.classList.toggle('text-amber-400', drifted);
                }
                if (drifted && notify && !folderDriftNotified) {
                    folderDriftNotified = true;
                    showNotification(`有 ${health.missing_count} 个目录与磁盘不一致，点「同步」按钮可修复`, 'warning');
                }
                return health;
            } catch (error) {
                console.warn('[FolderSync] 检查失败:', error);
                return null;
            }
        }

        async function syncLibraryFolders() {
            const btn = document.getElementById('syncFoldersBtn');
            if (btn) btn.classList.add('animate-spin');
            try {
                const health = await checkFolderDrift();
                if (!health) { showNotification('无法读取目录状态', 'error'); return; }
                if (!health.missing_count) {
                    showNotification(`目录与磁盘一致（${health.total_dirs} 个目录）`, 'success');
                    return;
                }
                const sample = (health.missing || []).slice(0, 5).map(item => `${item.path}（${item.files} 个文件）`).join('\n');
                const ok = confirm(
                    `检测到 ${health.missing_count} 个目录在磁盘上不存在，涉及 ${health.missing_files} 个文件。\n\n` +
                    sample + (health.missing_count > 5 ? '\n…' : '') +
                    '\n\n是否扫描磁盘、按「同名同大小」把路径修回来？\n（只改数据库路径，不动磁盘文件）'
                );
                if (!ok) return;
                const roots = health.root ? [health.root] : [];
                showNotification('正在扫描磁盘并修复路径，大库可能需要几分钟…', 'info');
                const result = await rendererApi.post('/api/v1/db/library/repair-paths', { dry_run: false, roots });
                const fixed = Number(result?.updated || 0);
                const left = Number(result?.not_found || 0) + Number(result?.ambiguous || 0);
                showNotification(`目录同步完成：修复 ${fixed} 个文件${left ? `，${left} 个仍未找到` : ''}`, left ? 'warning' : 'success');
                await loadFilesFromDatabase({ reset: true });
                await loadFolderStats(true);
                folderDriftNotified = false;
            } catch (error) {
                showNotification('目录同步失败：' + (error?.message || error), 'error');
            } finally {
                if (btn) btn.classList.remove('animate-spin');
            }
        }

        // 窗口重新获得焦点时静默检查一次（5 分钟内不重复）
        window.addEventListener('focus', () => {
            const now = Date.now();
            if (now - lastFolderSyncCheck < 5 * 60 * 1000) return;
            lastFolderSyncCheck = now;
            checkFolderDrift({ notify: true });
        });


        // 用后端返回的「全库目录统计」建树：只靠分页加载的 soundData 反推，
        // 得到的目录既不全也不稳定（实测只显示出 7/8/9 三个子目录）。
        // ===== 收藏 =====
        async function loadFavoriteCount() {
            try {
                const data = await rendererApi.get('/api/v1/favorites?limit=2000');
                window.__favoriteCount = (data && data.total) || 0;
                const badge = document.getElementById('favoriteCount');
                if (badge) badge.textContent = String(window.__favoriteCount);
            } catch (_) { }
        }

        // 回到「全部音效」：清掉文件夹 / 标签 / 搜索的过滤，重新拉第一页
        async function showAllSounds() {
            activeUserFolder = null;
            activeCategory = 'tag-all';
            folderFilter.path = '';
            folderFilter.cursor = null;
            aiResultMode = false;
            allSearchResults = [];
            currentSearchQuery = '';
            const searchBox = document.getElementById('searchInput');
            if (searchBox) searchBox.value = '';
            document.querySelectorAll('#folderTree .sidebar-item, #categoryTree .sidebar-item')
                .forEach((el) => el.classList.remove('active'));
            setSidebarView('all');
            await loadFilesFromDatabase({ reset: true });
        }

        async function showFavorites() {
            try {
                activeUserFolder = null;
                const data = await rendererApi.get('/api/v1/favorites?limit=2000');
                const list = ((data && data.files) || []).map(mapDbFileToSound);
                allSearchResults = list;
                renderSoundList('', list);
                showNotification(`收藏夹共 ${list.length} 个音效`, 'info');
            } catch (error) {
                showNotification('读取收藏失败: ' + error.message, 'error');
            }
        }

        // ===== 重复音效检测 =====

        // 选备份目录（用系统选择文件夹对话框）

        // 查看/恢复"已忽略"的重复组（多分类归属的音效）

        // 扫描库目录：把"磁盘上有、库里没有"的音频补录回来（回收站还原 / 手动拷入）
        // 目录改名/移动后修库里的路径（同名同大小匹配）
        const repairLibraryPaths = async (button) => {
            const setBusy = (busy) => { if (button) button.disabled = busy; };
            try {
                setBusy(true);
                showNotification('正在扫描磁盘，找可修复的路径…', 'info');
                const preview = await rendererApi.post('/api/v1/db/library/repair-paths?project_id=' + encodeURIComponent(currentProject?.id || 'default'), { dry_run: true }, { timeoutMs: 600000 });
                if (!preview.fixable) {
                    showNotification('没有可修复的路径（缺失 ' + preview.missing + ' 条，其中 ' + preview.not_found + ' 条在磁盘上找不到）', 'warning');
                    return;
                }
                if (!confirm('库里有 ' + preview.missing + ' 条记录指向不存在的文件，\n其中 ' + preview.fixable + ' 条能按「同名同大小」找到新位置。\n\n现在修正吗？' + (preview.ambiguous ? '\n（另有 ' + preview.ambiguous + ' 条有多个候选，跳过）' : ''))) return;
                const result = await rendererApi.post('/api/v1/db/library/repair-paths?project_id=' + encodeURIComponent(currentProject?.id || 'default'), { dry_run: false }, { timeoutMs: 900000 });
                showNotification('已修正 ' + result.updated + ' 条路径', 'success');
                await loadFilesFromDatabase({ reset: true });
                await loadFolderStats(true);
            } catch (error) {
                showNotification('修复失败: ' + (error?.message || error), 'error');
            } finally {
                setBusy(false);
            }
        };


        // 按备份清单把文件还原回原目录（备份是复制，所以原文件可能还在）

        // 处理重复副本：records=只删记录 / source=移入回收站 / backup=复制到备份目录

        // 重复组里"优先保留哪一份"：默认中文名优先（英文原名当副本删掉）
        let duplicateKeepPreference = 'cjk';

        const nameCjkScore = (filePath) => {
            const name = String(filePath || '').split(/[\\/]/).pop() || '';
            const cjk = (name.match(/[\u4e00-\u9fff]/g) || []).length;
            const latin = (name.match(/[A-Za-z]/g) || []).length;
            if (!cjk) return -latin;          // 纯英文名：越长越靠后
            return cjk * 3 - latin;           // 中文越多分越高，英文越少越靠前
        };

        const preferredKeepIndex = (files) => {
            if (duplicateKeepPreference !== 'cjk' || !Array.isArray(files) || files.length < 2) return 0;
            let best = 0;
            let bestScore = nameCjkScore(files[0].path);
            for (let i = 1; i < files.length; i += 1) {
                const score = nameCjkScore(files[i].path);
                if (score > bestScore) { best = i; bestScore = score; }
            }
            return best;
        };

        const splitGroupByPreference = (group) => {
            const at = preferredKeepIndex(group.files);
            const keep = group.files[at] || group.files[0];
            const dups = group.files.filter((_, i) => i !== at).map(file => file.path);
            return { keep, dups };
        };

        // 用户文件夹里手动加入的单个音效


        // 从目录树里摘掉被删掉的目录（含子目录），删完立刻生效，不用等重新拉取


        // 后端 tags 列是 JSON 字符串，前端统一转成数组（否则 .slice().map 会炸）


        // 点击文件夹：直接从后端按目录前缀拉取文件，而不是过滤本地已加载的
        // 分页数据（本地可能只有几百条，点大目录会是空的）。
        const folderFilter = { path: '', cursor: null, total: 0, loading: false };




        // 数据库忙（比如刚删上千条、索引任务在写）时首屏请求会失败，
        // 以前会直接渲染成空态，看起来像"数据全没了"。这里做几次退避重试。

        let fileListTagFilter = '';

        // ==================== EVENT LISTENERS ====================
        document.addEventListener('DOMContentLoaded', async () => {
            console.log('[Frontend] DOMContentLoaded 开始执行');
            console.log('[Frontend] window.electronAPI:', window.electronAPI);
            console.log('[Frontend] window.electronAPI?.backendAPI:', window.electronAPI?.backendAPI);

            // ========== 独立浮动面板模式（浮窗窗口加载同一页面，仅显示目标面板） ==========
            const FLOAT_ID = (window.electronAPI?.floatPanel?.floatId?.()) || null;
            if (FLOAT_ID) {
                document.body.dataset.floatMode = FLOAT_ID;
                // 隐藏主布局区域（CSS 兜底 + JS 显式）
                ['header', '#mainContent', '#waveformResizer', '#playerFooter'].forEach(sel => {
                    const el = document.querySelector(sel);
                    if (el) el.style.display = 'none';
                });
                // 目标面板移入 host（保持 DOM 与绑定不破坏）
                const host = document.createElement('div');
                host.id = 'floatHost';
                document.body.appendChild(host);
                const section = document.querySelector(`[data-panel="${FLOAT_ID}"]`);
                if (section) host.appendChild(section);
                if (FLOAT_ID === 'waveform') {
                    const footer = document.getElementById('playerFooter');
                    if (footer) host.appendChild(footer);
                }
                // 浮窗标题栏（无边框窗口拖动区 + 停靠/关闭）
                const bar = document.createElement('div');
                bar.className = 'float-win-bar';
                const titleSpan = document.createElement('span');
                const titles = { folder: '文件夹', category: '分类', ai: 'AI 助手', waveform: '波形' };
                titleSpan.textContent = titles[FLOAT_ID] || '回声';
                const btnRow = document.createElement('div');
                btnRow.style.cssText = 'display:flex;gap:6px;';
                const dockBtn = document.createElement('button');
                dockBtn.textContent = '⬇ 停靠';
                dockBtn.addEventListener('click', () => window.electronAPI?.floatPanel?.dock(FLOAT_ID));
                const closeBtn = document.createElement('button');
                closeBtn.textContent = '✕ 关闭';
                closeBtn.addEventListener('click', () => window.electronAPI?.floatPanel?.close(FLOAT_ID));
                btnRow.appendChild(dockBtn); btnRow.appendChild(closeBtn);
                bar.appendChild(titleSpan); bar.appendChild(btnRow);
                document.body.insertBefore(bar, document.body.firstChild);

                // 浮窗：接收主窗口推送的当前音效 → 同步波形与声音
                window.electronAPI?.floatPanel?.onSoundChanged?.((payload) => {
                    const s = payload?.sound;
                    if (!s?.filePath) return;
                    // 波形/选中态同步（主窗口正在播放时跳过预加载，直接走播放路径）
                    selectSound(s, { preload: !payload?.playing });
                    if (payload?.playing) {
                        selectAndPlaySound(s);
                    } else if (audioPlayer) {
                        audioPlayer.pause();
                        isPlaying = false;
                        stopPlaybackAnimation?.();
                        updatePlaybackUI?.();
                        updatePlayButtonState?.();
                    }
                });
            } else {
                // 主窗口：浮窗打开时把当前选中音效推过去
                window.electronAPI?.floatPanel?.onRequestCurrent?.((_id) => {
                    if (currentSound?.filePath) {
                        window.electronAPI.floatPanel.broadcastSound(buildSoundBroadcast(currentSound));
                    }
                });
            }
            
            // 绑定输入弹窗事件
            document.getElementById('inputModalCancel').addEventListener('click', hideInputModal);
            document.getElementById('inputModalConfirm').addEventListener('click', confirmInputModal);
            document.getElementById('inputModalField').addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    confirmInputModal();
                }
            });
            document.getElementById('inputModal').addEventListener('click', (e) => {
                if (e.target.id === 'inputModal') {
                    hideInputModal();
                }
            });

            // 绑定新建文件夹按钮事件
            const addFolderBtn = document.getElementById('addFolderBtn');
            if (addFolderBtn) {
                addFolderBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    showInputModal(i18n.t('folder.new.title'), i18n.t('folder.new.placeholder'), (name) => {
                        if (name && name.trim()) {
                            createUserFolder(name.trim());
                        }
                    });
                });
            }

            document.getElementById('reconcileIndexBtn')?.addEventListener('click', () => {
                runProjectIndexAction('reconcile');
            });
            document.getElementById('rebuildIndexBtn')?.addEventListener('click', () => {
                if (confirm('确定完整重建当前工程的波形、音频向量和文本向量索引吗？')) {
                    runProjectIndexAction('rebuild');
                }
            });

            // 本地登记的标签（没有关联任何音效时也能出现在面板里）
            try {
                window.__localTags = JSON.parse(localStorage.getItem('echomind.localTags') || '[]');
            } catch (_) {
                window.__localTags = [];
            }
            document.getElementById('aiSearchBtn')?.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                runAiSearch();
            });
            document.getElementById('dupCheckBtn')?.addEventListener('click', () => {
                document.getElementById('settingsDropdown').classList.add('hidden');
                showDuplicatesModal();
            });
            document.getElementById('aboutAppBtn')?.addEventListener('click', () => {
                document.getElementById('settingsDropdown').classList.add('hidden');
                document.getElementById('settingsDropdown').classList.remove('visible');
                showAboutDialog();
            });
            document.getElementById('checkUpdateMenuBtn')?.addEventListener('click', () => {
                document.getElementById('settingsDropdown').classList.add('hidden');
                document.getElementById('settingsDropdown').classList.remove('visible');
                checkForUpdatesFromMenu();
            });
            document.getElementById('sortSelect')?.addEventListener('change', () => {
                renderSoundList(document.getElementById('searchInput')?.value || '');
            });
            document.getElementById('recipeMenuBtn')?.addEventListener('click', () => openRecipeModal());
            document.getElementById('recipeCloseBtn')?.addEventListener('click', () => {
                if (recipeState.recording) stopRecipeRecording();
                document.getElementById('recipeModal').classList.add('hidden');
                document.getElementById('recipeModal').classList.remove('flex');
            });
            // 环境音：按住拖动 → 连续合成；拟音：点一下 → 演奏一步
            const padEl = document.getElementById('recipePad');
            padEl?.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                recipeState.padDragging = true;
                const params = recipePadParams(e);
                if (recipeState.current && recipeState.current.mode === 'env') {
                    startStems(params.x, params.y);
                } else {
                    triggerRecipeHit(params);
                }
            });
            padEl?.addEventListener('mousemove', (e) => {
                // 必须按住左键才动，松开后光标位置不再影响声音
                if (!recipeState.padDragging || !recipeState.ambiencePlaying) return;
                const params = recipePadParams(e);
                updateStems(params.x, params.y);
            });
            const endDrag = () => { recipeState.padDragging = false; };
            window.addEventListener('mouseup', endDrag);
            padEl?.addEventListener('mouseleave', endDrag);
            document.getElementById('recipeStopAmbience')?.addEventListener('click', () => stopStems());
            document.getElementById('recipeRecordBtn')?.addEventListener('click', () => {
                if (recipeState.recording) stopRecipeRecording(); else startRecipeRecording();
            });
            document.getElementById('recipePlayBtn')?.addEventListener('click', () => {
                const session = recipeState.lastSession;
                if (!session) return;
                const button = document.getElementById('recipePlayBtn');
                toggleRecipeAudio(session.url, 'session', null);
                button.textContent = (recipeAudioOwner === 'session') ? '暂停试听' : '试听录制';
            });
            document.getElementById('recipeCloseBtn')?.addEventListener('click', () => {
                stopRecipeAudio();
                stopAmbience();
            });
            document.getElementById('recipeSaveBtn')?.addEventListener('click', () => saveRecipeSession());
            document.getElementById('recipeResetLayers')?.addEventListener('click', () => {
                if (recipeState.current) selectRecipe(recipeState.current);
            });
            document.getElementById('recipeVariation')?.addEventListener('change', (e) => {
                recipeState.variation = Number(e.target.value) || 0;
            });
            document.getElementById('viewListBtn')?.addEventListener('click', () => setViewMode('list'));
            document.getElementById('viewCardBtn')?.addEventListener('click', () => setViewMode('card'));
            applyViewMode();
            bindPlaybackRateAndReverse();
            bindChannelBar();
            bindHistoryPanels();
            bindVoiceClone();
            bindNavFish();
            (function bindFishToggle() {
                const btn = document.getElementById('fishToggleBtn');
                const label = document.getElementById('fishToggleLabel');
                const paint = () => {
                    const hidden = localStorage.getItem('echomind.fishHidden') === '1';
                    if (label) label.textContent = hidden ? '叫出回声' : '藏起回声';
                };
                paint();
                btn?.addEventListener('click', () => {
                    const hidden = localStorage.getItem('echomind.fishHidden') === '1';
                    localStorage.setItem('echomind.fishHidden', hidden ? '0' : '1');
                    fishApplyVisibility();
                    paint();
                });
            })();
            loadEffectPresets().then(() => renderEffectPanel(currentSound || null));
            document.getElementById('detailToggleBtn')?.addEventListener('click', () => setDetailPanelOpen(!detailPanelOpen));
            document.getElementById('detailCloseBtn')?.addEventListener('click', () => setDetailPanelOpen(false));
            // 启动时默认展开详情面板（用户点「详情」或 ✕ 可收起）
            setDetailPanelOpen(true);

            initAudioPlayer();
            bindPlayerContextMenu();
            initializeWaveformResizeObserver();
            document.getElementById('waveformRetryBtn').addEventListener('click', () => {
                if (!currentSound) return;
                currentSound.waveform = null;
                currentSound.peaks = null;
                currentSound.waveformError = null;
                loadWaveformForSound(currentSound, { force: true });
            });
            renderFolderTree();
            updateCategoryData();
            renderSoundList();
            drawMainWaveform();

            await initializeRuntimeConfig();
            
            // 异步检查后端状态，不阻塞界面加载
            ensureBackendReady().then(async (isReady) => {
                if (isReady) {
                    const projectLoaded = await loadCurrentProject();
                    if (!projectLoaded) {
                        await loadFilesFromDatabase();
                        await loadUserFolders();
                        renderFolderTree();
                        updateCategoryData();
                        renderSoundList();
                    }
                    // 标签计数用后端全库统计，避免只统计到已加载的分页
                    loadTagStats();
                    await refreshProjectIndexStatus();
                } else {
                    const diskSpaceText = document.getElementById('diskSpaceText');
                    if (diskSpaceText) {
                        diskSpaceText.textContent = '后端未就绪';
                    }
                }
            });

            // 确保所有图标都被正确初始化
            lucide.createIcons();

            // 延迟再次初始化，确保动态生成的图标也能显示
            setTimeout(() => {
                lucide.createIcons();
            }, 100);
            
            // 初始化主题切换按钮状态
            // 当前浅色模式 -> 显示月亮（可切换到深色）
            // 当前深色模式 -> 显示太阳（可切换到浅色）
            const isDark = document.documentElement.classList.contains('dark');
            const sunIcon = document.getElementById('themeIconSun');
            const moonIcon = document.getElementById('themeIconMoon');
            const lightText = document.getElementById('themeTextLight');
            const darkText = document.getElementById('themeTextDark');
            if (sunIcon && moonIcon && lightText && darkText) {
                if (isDark) {
                    // 深色模式：显示太阳（可切换回浅色）
                    moonIcon.classList.add('hidden');
                    sunIcon.classList.remove('hidden');
                    lightText.classList.add('hidden');
                    darkText.classList.remove('hidden');
                } else {
                    // 浅色模式：显示月亮（可切换到深色）
                    sunIcon.classList.add('hidden');
                    moonIcon.classList.remove('hidden');
                    lightText.classList.remove('hidden');
                    darkText.classList.add('hidden');
                }
            }
            
            // 初始化磁盘空间显示
            updateDiskSpaceDisplay();
            // 定期更新磁盘空间（每30秒）
            setInterval(updateDiskSpaceDisplay, 30000);

            // 初始化模型状态检查
            checkModelStatus();
            // 定期更新模型状态（每5秒）
            setInterval(checkModelStatus, 5000);
            // 索引进度自适应轮询：有处理中的任务时 2 秒刷新，空闲时 15 秒
            let indexPollTimer = null;
            const scheduleIndexPoll = (delay) => {
                if (indexPollTimer) clearTimeout(indexPollTimer);
                indexPollTimer = setTimeout(async () => {
                    indexPollTimer = null;
                    if (!backendReady) {
                        scheduleIndexPoll(5000);
                        return;
                    }
                    const status = await refreshProjectIndexStatus();
                    const busy = Boolean(
                        status
                        && (Number(status.artifacts?.audio_vector?.pending || 0)
                            + Number(status.artifacts?.audio_vector?.processing || 0)
                            + Number(status.artifacts?.text_vector?.pending || 0)
                            + Number(status.artifacts?.text_vector?.processing || 0)
                            + Number(status.artifacts?.waveform?.pending || 0)) > 0
                    );
                    scheduleIndexPoll(busy ? 2000 : 15000);
                }, delay);
            };
            scheduleIndexPoll(3000);

            // ==================== 阈值调整功能 ====================
            let currentSearchThreshold = 0.15; // 默认阈值
            const modelStatusDisplay = document.getElementById('modelStatusDisplay');
            const thresholdPopup = document.getElementById('thresholdPopup');
            const thresholdSlider = document.getElementById('thresholdSlider');
            const thresholdValue = document.getElementById('thresholdValue');
            
            // 点击模型状态按钮显示/隐藏阈值弹窗
            modelStatusDisplay.addEventListener('click', (e) => {
                e.stopPropagation();
                thresholdPopup.classList.toggle('hidden');
                thresholdPopup.classList.toggle('visible');
            });
            
            // 点击其他地方关闭阈值弹窗
            document.addEventListener('click', (e) => {
                if (!e.target.closest('#thresholdPopup') && !e.target.closest('#modelStatusDisplay')) {
                    thresholdPopup.classList.add('hidden');
                    thresholdPopup.classList.remove('visible');
                }
            });
            
            // 滑块值变化时更新显示
            thresholdSlider.addEventListener('input', (e) => {
                const value = parseInt(e.target.value);
                currentSearchThreshold = value / 100;
                thresholdValue.textContent = currentSearchThreshold.toFixed(2);
                
                // 更新滑块颜色渐变
                const percent = value;
                thresholdSlider.style.setProperty('--threshold-percent', percent + '%');
                
                // 根据阈值改变数值颜色
                if (value < 15) {
                    thresholdValue.style.backgroundColor = '#22c55e'; // 绿色-宽松
                    thresholdValue.style.color = '#fff';
                } else if (value < 40) {
                    thresholdValue.style.backgroundColor = '#3b82f6'; // 蓝色-适中
                    thresholdValue.style.color = '#fff';
                } else if (value < 70) {
                    thresholdValue.style.backgroundColor = '#f59e0b'; // 橙色-严格
                    thresholdValue.style.color = '#fff';
                } else {
                    thresholdValue.style.backgroundColor = '#ef4444'; // 红色-非常严格
                    thresholdValue.style.color = '#fff';
                }
            });
            
            // 滑块释放时触发搜索（如果有搜索词）
            thresholdSlider.addEventListener('change', () => {
                const searchQuery = document.getElementById('searchInput').value.trim();
                if (searchQuery && searchQuery.length >= 2) {
                    // 重新搜索
                    currentSearchQuery = searchQuery;
                    currentSearchPage = 1;
                    allSearchResults = [];
                    hasMoreResults = true;
                    loadSearchResults(searchQuery, 1, true);
                }
                showNotification(`搜索阈值已调整为 ${currentSearchThreshold.toFixed(2)}`, 'success');
            });

            // 窗口调整大小时重新绘制波形和更新拖拽按钮位置
            let resizeTimeout;
            window.addEventListener('resize', () => {
                clearTimeout(resizeTimeout);
                resizeTimeout = setTimeout(() => {
                    drawMainWaveform();
                    if (selectionStart !== null && selectionEnd !== null) {
                        updateDragHandlePosition();
                    }
                }, 100);
            });
            // Settings
            document.getElementById('settingsBtn').addEventListener('click', (e) => {
                e.stopPropagation();
                toggleSettings();
            });
            
            // 导入按钮 - 显示下拉菜单
            document.getElementById('importBtn').addEventListener('click', (e) => {
                e.stopPropagation();
                const dropdown = document.getElementById('importDropdown');
                dropdown.classList.toggle('hidden');
                dropdown.classList.toggle('visible');
                
                // 隐藏设置下拉菜单
                document.getElementById('settingsDropdown').classList.add('hidden');
                document.getElementById('settingsDropdown').classList.remove('visible');
            });
            
            // 点击其他地方关闭下拉菜单
            document.addEventListener('click', (e) => {
                if (!e.target.closest('#settingsDropdown') && !e.target.closest('#settingsBtn')) {
                    document.getElementById('settingsDropdown').classList.add('hidden');
                    document.getElementById('settingsDropdown').classList.remove('visible');
                }
                if (!e.target.closest('#importDropdown') && !e.target.closest('#importBtn')) {
                    document.getElementById('importDropdown').classList.add('hidden');
                    document.getElementById('importDropdown').classList.remove('visible');
                }
            });
            
            document.getElementById('themeToggle')?.addEventListener('click', toggleTheme);
            
            // 临时文件目录按钮
            document.getElementById('tempDirBtn').addEventListener('click', (e) => {
                e.stopPropagation();
                selectTempDir();
            });
            
            // 恢复默认临时文件目录按钮
            document.getElementById('resetTempDirBtn').addEventListener('click', (e) => {
                e.stopPropagation();
                resetTempDirToDefault();
            });
            
            // 清理临时裁切文件按钮
            document.getElementById('clearTempClipsBtn').addEventListener('click', async (e) => {
                e.stopPropagation();
                
                // 显示确认对话框
                const confirmed = confirm(
                    '⚠️ 警告：清理临时裁切文件\n\n' +
                    '请确保当前临时文件已经不再需要，否则会导致：\n' +
                    '• 工程无法检索到相关裁切音频\n' +
                    '• DAW 中已导入的音频链接失效\n' +
                    '• 之前的工作可能丢失\n\n' +
                    '确定要清理所有临时裁切文件吗？'
                );
                
                if (!confirmed) {
                    return;
                }
                
                try {
                    showNotification('正在清理临时文件...', 'info');
                    
                    let result;
                    if (window.electronAPI && window.electronAPI.backendAPI) {
                        result = await window.electronAPI.backendAPI.clearTempClips();
                    } else {
                        const response = await rendererApi.fetch('/api/v1/temp-clips/clear', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' }
                        });
                        result = await response.json();
                    }
                    
                    if (result && result.success) {
                        showNotification(`已清理 ${result.deleted_count || 0} 个临时文件，释放 ${formatFileSize(result.freed_space || 0)}`, 'success');
                        // 清理完成后更新磁盘空间显示
                        updateDiskSpaceDisplay();
                    } else {
                        showNotification('清理失败: ' + (result.error || '未知错误'), 'error');
                    }
                } catch (error) {
                    console.error('清理临时文件失败:', error);
                    showNotification('清理失败: ' + error.message, 'error');
                }
            });
            
            document.querySelectorAll('.setting-option').forEach(btn => {
                btn.addEventListener('click', () => {
                    updateSetting(btn.dataset.type, btn.dataset.value);
                });
            });
            
            // 首次启动设置弹窗事件
            document.getElementById('firstTimeSelectDirBtn').addEventListener('click', firstTimeSelectDir);
            document.getElementById('firstTimeUseDefaultBtn').addEventListener('click', firstTimeUseDefault);
            document.getElementById('firstTimeConfirmBtn').addEventListener('click', firstTimeConfirm);
            
            initProjectManagement();
            checkFirstTimeSetup();
            
            // ==================== 初始化语言设置 ====================
            // 默认中文；启动时静默切换，不弹提示
            let savedLang = localStorage.getItem('soundbot_language');
            if (!savedLang) {
                savedLang = 'zh';
                localStorage.setItem('soundbot_language', 'zh');
            }
            i18n.setLang(savedLang);
            // 更新语言按钮状态
            updateSetting('lang', savedLang, { notify: false });

            // Search - 支持本地和后端语义搜索（带分页加载）
            let searchTimeout = null;
            let currentSearchQuery = '';
            let currentSearchPage = 1;
            let isLoadingMore = false;
            let hasMoreResults = true;
            
            // 搜索不再边打字边出结果：输入框只接收文本，按回车才发起检索。
            // AI 搜索也不自动触发，必须点右侧「AI」按钮。
            const searchInputEl = document.getElementById('searchInput');
            const runKeywordSearch = async () => {
                document.getElementById('searchHistoryMenu')?.classList.add('hidden');
            const query = searchInputEl.value.trim();
                activeUserFolder = null; // 搜索/清空都会换列表，移出入口不再适用
                setSidebarView(null);
                // M4：tag:标签名 → 直接按标签筛选
                if (/^tag[:：]/i.test(query)) {
                    const name = query.replace(/^tag[:：]/i, '').trim();
                    if (!name) return;
                    try {
                        const page = await rendererApi.get(
                            '/api/v1/files?limit=500&tag=' + encodeURIComponent(name)
                            + '&project_id=' + encodeURIComponent(currentProject?.id || 'default')
                        );
                        allSearchResults = ((page && page.files) || []).map(mapDbFileToSound);
                        renderSoundList('', allSearchResults);
                        showNotification(`标签「${name}」共 ${allSearchResults.length} 个音效`, 'info');
                    } catch (error) {
                        showNotification('标签筛选失败: ' + error.message, 'error');
                    }
                    return;
                }
                if (!query) {
                    currentSearchQuery = '';
                    allSearchResults = [];
                    aiResultMode = false;
                    folderFilter.path = '';
                    renderSoundList('');
                    return;
                }
                if (!backendReady) {
                    renderSoundList(query);
                    return;
                }
                currentSearchQuery = query;
                currentSearchPage = 1;
                allSearchResults = [];
                aiResultMode = false;
                folderFilter.path = '';
                hasMoreResults = true;
                isLoadingMore = false;
                rememberSearch(query);
                await loadSearchResults(query, 1, true);
            };

            searchInputEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (searchTimeout) clearTimeout(searchTimeout);
                    runKeywordSearch();
                } else if (e.key === 'Escape') {
                    searchInputEl.value = '';
                    currentSearchQuery = '';
                    allSearchResults = [];
                    aiResultMode = false;
                    folderFilter.path = '';
                    renderSoundList('');
                }
            });

            searchInputEl.addEventListener('input', () => {
                // 清空输入时恢复完整列表；其余情况等回车
                if (!searchInputEl.value.trim()) {
                    currentSearchQuery = '';
                    allSearchResults = [];
                    aiResultMode = false;
                    folderFilter.path = '';
                    renderSoundList('');
                }
            });
            
            // 加载搜索结果（分页）
            // 语义结果后台补充：先用关键词层秒出结果，再等语义层返回后替换。
            // 目的：搜索框不再等 8 秒，语义排序仍然保留。
            window.__searchSeq = window.__searchSeq || 0;

            async function loadSemanticSupplement(query, seq) {
                if (!query || !query.trim()) return;
                try {
                    const payload = rendererSearch.buildPayload({
                        query,
                        topK: 400,
                        // 语义补充用更高的阈值，避免弱相关结果污染关键词结果
                        threshold: Math.max(currentSearchThreshold || 0, 0.3),
                        page: 1,
                        pageSize: 50,
                        projectId: currentProject?.id,
                        fast: false
                    });
                    const result = await rendererApi.post('/api/v1/search', payload);
                    if (window.__searchSeq !== seq) return;   // 期间又搜了别的词，丢弃
                    const items = (result && result.results) || [];
                    if (!items.length) return;

                    const mapped = items.map((r, index) => {
                        const libraryMatch = soundData.find(sound => sound.filePath === r.audio_file.path);
                        const fileId = r.audio_file.id || r.audio_file.file_uuid || libraryMatch?.fileId || null;
                        return {
                            id: fileId || Date.now() + index,
                            fileId,
                            name: r.audio_file.filename,
                            category: '搜索结果',
                            duration: (r.audio_file.duration || 0) * 1000,
                            tags: ['AI搜索'],
                            filePath: r.audio_file.path,
                            size: r.audio_file.size || 0,
                            type: '.' + r.audio_file.format,
                            similarity: r.score,
                            semanticScore: r.metadata?.semantic_score,
                            keywordScore: r.metadata?.keyword_score,
                            keywordOnly: r.metadata?.keyword_only,
                            aiDescription: r.metadata?.ai_description || '',
                            lastModified: new Date()
                        };
                    });
                    if (!mapped.length) return;
                    // 只追加关键词结果里没有的文件，避免把更准的关键词结果挤掉
                    const existing = new Set((allSearchResults || []).map(s => s.filePath));
                    const extra = mapped.filter(s => s.filePath && !existing.has(s.filePath));
                    if (!extra.length) {
                        showNotification('语义检索：没有更多相关结果', 'info');
                        return;
                    }
                    allSearchResults = (allSearchResults || []).concat(extra);
                    renderSoundList('', allSearchResults);
                    void hydrateResultMeta(extra).then((changed) => {
                        if (changed) renderSoundList('', allSearchResults);
                    });
                    showNotification('语义结果已补充 ' + extra.length + ' 条', 'success');
                } catch (error) {
                    // 语义层失败不影响已经显示的关键词结果
                    console.warn('[Search] 语义补充失败:', error);
                }
            }

            async function loadSearchResults(query, page, isNewSearch = false) {
                if (isLoadingMore || !hasMoreResults) return;

                if (isNewSearch) window.__searchSeq = (window.__searchSeq || 0) + 1;
                const searchSeq = window.__searchSeq;

                isLoadingMore = true;

                // 显示搜索框加载动画
                document.getElementById('searchIcon').classList.add('hidden');
                document.getElementById('searchLoadingSpinner').classList.remove('hidden');

                // 清空结果区并显示搜索状态
                const soundListContainer = document.getElementById('soundList');
                if (isNewSearch) {
                    soundListContainer.innerHTML = `
                        <div class="flex flex-col items-center justify-center py-16 opacity-60">
                            <div class="animate-spin w-8 h-8 mb-3" viewBox="0 0 24 24" fill="none">
                                <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="31.4 31.4" opacity="0.25"></circle>
                                <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" stroke-width="3" stroke-linecap="round"></path>
                            </div>
                            <p class="text-sm opacity-70">正在搜索"${query}"...</p>
                        </div>`;
                }

                try {
                    const searchRequest = rendererSearch.buildPayload({
                        query,
                        topK: 400,
                        threshold: currentSearchThreshold,
                        page,
                        pageSize: 50,
                        projectId: currentProject?.id,
                        fast: true
                    });
                    const result = await rendererApi.post('/api/v1/search', searchRequest);

                    // 隐藏加载动画
                    document.getElementById('searchIcon').classList.remove('hidden');
                    document.getElementById('searchLoadingSpinner').classList.add('hidden');

                    if (result && result.results && result.results.length > 0) {
                        // 将后端结果转换为前端格式
                        const newSounds = result.results.map((r, index) => {
                            const libraryMatch = soundData.find(sound => sound.filePath === r.audio_file.path);
                            const fileId = r.audio_file.id || r.audio_file.file_uuid || libraryMatch?.fileId || null;
                            return {
                                id: fileId || Date.now() + index + (page - 1) * 50,
                                fileId,
                                name: r.audio_file.filename,
                                category: '搜索结果',
                                duration: (r.audio_file.duration || 0) * 1000,
                                tags: ['AI搜索'],
                                filePath: r.audio_file.path,
                                size: r.audio_file.size || 0,
                                type: '.' + r.audio_file.format,
                                similarity: r.score,
                                semanticScore: r.metadata?.semantic_score,
                                keywordScore: r.metadata?.keyword_score,
                                keywordOnly: r.metadata?.keyword_only,
                                aiDescription: r.metadata?.ai_description || '',
                                lastModified: new Date()
                            };
                        });
                        
                        if (isNewSearch) {
                            allSearchResults = newSounds;
                        } else {
                            allSearchResults = allSearchResults.concat(newSounds);
                        }
                        
                        // 更新分页状态
                        currentSearchPage = result.page;
                        hasMoreResults = currentSearchPage < result.total_pages;
                        
                        // 渲染结果
                        renderSoundList('', allSearchResults);
                        // 本地搜索同样只有文件名和分数：批量补描述和系统标签
                        void hydrateResultMeta(allSearchResults).then((changed) => {
                            if (changed && currentSearchQuery === query) renderSoundList('', allSearchResults);
                        });

                        if (isNewSearch) {
                            showNotification(`已显示 ${allSearchResults.length} 个结果，正在补充语义结果…`, 'success');
                            loadSemanticSupplement(query, searchSeq);
                        }
                    } else if (isNewSearch) {
                        // 搜索返回空结果
                        allSearchResults = [];
                        renderSoundList('', []);
                    }
                } catch (error) {
                    console.error('搜索失败:', error);
                    showNotification('搜索失败: ' + error.message, 'error');
                    // 隐藏加载动画并降级到本地搜索
                    document.getElementById('searchIcon').classList.remove('hidden');
                    document.getElementById('searchLoadingSpinner').classList.add('hidden');
                    renderSoundList(query);
                } finally {
                    isLoadingMore = false;
                }
            }
            
            // 滚动加载更多
            const soundListContainer = document.getElementById('soundList');
            soundListContainer.addEventListener('scroll', () => {
                queueVisibleWaveformLoad(lastRenderedSounds);
                const { scrollTop, scrollHeight, clientHeight } = soundListContainer;
                const nearBottom = scrollTop + clientHeight >= scrollHeight - 100;
                // AI 搜索结果模式：分批追加渲染，不再触发搜索框/数据库分页（避免结果被覆盖丢失）
                if (aiResultMode && allSearchResults.length > 0) {
                    if (nearBottom && aiRenderedCount < allSearchResults.length) {
                        appendAiResults(aiRenderedCount, Math.min(allSearchResults.length, aiRenderedCount + 60));
                    }
                    return;
                }
                if (folderFilter.path) {
                    if (nearBottom) loadMoreFolderFiles();
                    return;
                }
                if (!currentSearchQuery) {
                    if (nearBottom && fileListNextCursor && !fileListLoading) {
                        loadFilesFromDatabase({ reset: false });
                    }
                    return;
                }
                if (isLoadingMore || !hasMoreResults) return;

                // 当滚动到距离底部 100px 时加载更多
                if (nearBottom) {
                    loadSearchResults(currentSearchQuery, currentSearchPage + 1);
                }
            });
            
            // Select All
            document.getElementById('selectAll').addEventListener('change', (e) => {
                if (e.target.checked) {
                    soundData.forEach(s => selectedSounds.add(s.id));
                } else {
                    selectedSounds.clear();
                }
                renderSoundList(document.getElementById('searchInput').value);
            });
            
            // Playback Controls - 使用 HTML5 Audio 与 Electron 本地安全协议
            document.getElementById('playPauseBtn').addEventListener('click', () => {
                if (!currentSound && soundData.length > 0) {
                    selectSound(soundData[0]);
                }
                if (!currentSound) return;

                if (isPlaying) {
                    pausePlayback();
                } else {
                    // 有选区时智能播放
                    if (selectionStart !== null && selectionEnd !== null && audioPlayer && audioPlayer.src && currentSound) {
                        const currentTime = audioPlayer.currentTime; // 秒
                        const selStart = selectionStart / 1000;     // 毫秒转秒
                        const selEnd = selectionEnd / 1000;         // 毫秒转秒

                        let playStart;
                        let playEnd;

                        // 如果上一次播放因为到达选区结束而停止，重新从选区开始播放
                        // 使用更宽松的范围（selEnd + 0.5秒）来处理浮点数精度问题
                        if (lastStoppedAtSelectionEnd && currentTime >= selStart && currentTime <= selEnd + 0.5) {
                            playStart = selStart;
                            playEnd = selEnd;
                            playbackStartedInSelection = true;
                            lastStoppedAtSelectionEnd = false;  // 重置标记
                        } else {
                            // 智能判断播放范围 - 专业音频软件逻辑
                            if (currentTime >= selStart && currentTime <= selEnd) {
                                // 光标在选区内 -> 从选区开始播放到选区结束（始终从选区开头开始）
                                playStart = selStart;
                                playEnd = selEnd;
                                playbackStartedInSelection = true;
                            } else if (currentTime < selStart) {
                                // 光标在选区前 -> 从光标位置播放到选区结束
                                playStart = currentTime;
                                playEnd = selEnd;
                                playbackStartedInSelection = true;
                                lastStoppedAtSelectionEnd = false;  // 重置标记
                            } else {
                                // 光标在选区后 -> 从光标位置播放到音频结尾
                                playStart = currentTime;
                                playEnd = currentSound.duration / 1000;
                                playbackStartedInSelection = false;
                                lastStoppedAtSelectionEnd = false;  // 重置标记
                            }
                        }
                        
                        playbackStartTime = playStart;  // 记录播放开始时间

                        // 设置播放范围
                        audioPlayer.currentTime = playStart;
                        audioPlayer.removeEventListener('ended', handlePlaybackEnded);
                        audioPlayer.addEventListener('ended', handlePlaybackEnded);

                        audioPlayer.play().then(() => {
                            isPlaying = true;
                            startPlaybackAnimation();
                            updatePlaybackUI();
                        }).catch(err => {
                            console.error('播放失败:', err);
                            startPlayback();
                        });
                    } else {
                        startPlayback();
                    }
                }
            });
            
            document.getElementById('stopBtn').addEventListener('click', stopPlayback);
            
            document.getElementById('loopBtn').addEventListener('click', () => {
                isLooping = !isLooping;
                const btn = document.getElementById('loopBtn');
                btn.classList.toggle('opacity-50', !isLooping);
                btn.style.color = isLooping ? '#8b5cf6' : '';
                if (audioPlayer) audioPlayer.loop = isLooping;
                showNotification(isLooping ? '已开启循环播放' : '已关闭循环播放', 'info');
            });
            
            document.getElementById('prevBtn').addEventListener('click', () => {
                if (!currentSound) return;
                const currentIndex = soundData.findIndex(s => s.id === currentSound.id);
                const prevIndex = currentIndex > 0 ? currentIndex - 1 : soundData.length - 1;
                selectSound(soundData[prevIndex]);
                startPlayback();
            });
            
            document.getElementById('nextBtn').addEventListener('click', () => {
                if (!currentSound) return;
                const currentIndex = soundData.findIndex(s => s.id === currentSound.id);
                const nextIndex = currentIndex < soundData.length - 1 ? currentIndex + 1 : 0;
                selectSound(soundData[nextIndex]);
                startPlayback();
            });
            
// Progress Bar
            document.getElementById('progressContainer').addEventListener('click', (e) => {
                if (!currentSound) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const progress = (e.clientX - rect.left) / rect.width;

                if (audioPlayer && audioPlayer.duration) {
                    // 倒放时显示位置是反的，seek 也要反着算
                    const mediaRatio = reverseMode ? (1 - progress) : progress;
                    audioPlayer.currentTime = Math.max(0, Math.min(1, mediaRatio)) * audioPlayer.duration;
                    playbackProgress = Math.round(audioPlayer.currentTime * 1000);
                } else {
                    playbackProgress = Math.round(progress * currentSound.duration);
                }

                updatePlaybackUI();
                drawMainWaveform();
            });

            // 点击波形跳转播放位置
            document.getElementById('mainWaveform').addEventListener('click', (e) => {
                if (!currentSound) return;
                const canvas = document.getElementById('mainWaveform');
                const waveContainer = document.getElementById('waveformContainer');
                const rect = canvas.getBoundingClientRect();

                // 使用 waveContainer.offsetWidth（与绘制函数一致）
                const canvasWidth = waveContainer.offsetWidth;
                
                // 计算考虑缩放和滚动后的实际点击位置
                const clickX = e.clientX - rect.left;
                const totalWidth = canvasWidth * waveformZoomLevel;
                
                // 鼠标点击位置 + 当前滚动偏移 = 在完整波形上的位置
                const adjustedX = clickX + waveformScrollOffset;
                
                // 计算播放进度 (0-1)
                const progress = Math.max(0, Math.min(1, adjustedX / totalWidth));
                
                if (audioPlayer && audioPlayer.duration) {
                    // 倒放时显示位置是反的，seek 也要反着算
                    const mediaRatio = reverseMode ? (1 - progress) : progress;
                    audioPlayer.currentTime = Math.max(0, Math.min(1, mediaRatio)) * audioPlayer.duration;
                    playbackProgress = Math.round(audioPlayer.currentTime * 1000);
                } else {
                    playbackProgress = Math.round(progress * currentSound.duration);
                }
                updatePlaybackUI();
                drawMainWaveform();
            });

            // ==================== 区域选择功能 ====================
            const waveformCanvas = document.getElementById('mainWaveform');

            // 用于区分点击和拖拽
            let mouseDownX = 0;
            let mouseDownTime = 0;
            let wasSelecting = false;  // 标记是否发生过拖拽框选
            let mouseStartedInDragHandle = false;  // 标记鼠标是否在dragHandle区域按下
            const DRAG_THRESHOLD = 10; // 移动超过10像素视为拖拽

            // 左键按下 - 记录位置和时间
            waveformCanvas.addEventListener('mousedown', (e) => {
                if (!currentSound) return;

                if (e.button === 0) {
                    // 检查是否点击在dragHandle区域
                    const dragHandle = document.getElementById('dragHandle');
                    if (dragHandle && !dragHandle.classList.contains('hidden')) {
                        const handleRect = dragHandle.getBoundingClientRect();
                        // 判断点击是否在dragHandle Y轴范围内
                        if (e.clientY >= handleRect.top && e.clientY <= handleRect.bottom) {
                            mouseStartedInDragHandle = true;
                            return;
                        }
                    }
                    mouseStartedInDragHandle = false;

                    mouseDownX = e.clientX;
                    mouseDownTime = Date.now();
                    wasSelecting = false;
                }
            });

            // 鼠标移动 - 拖拽时开始框选
            waveformCanvas.addEventListener('mousemove', (e) => {
                if (!currentSound) return;

                // 检查是否是拖拽（按住左键移动超过阈值）
                if (e.buttons === 1) {  // 左键按住
                    // 根据需求，鼠标移动到dragHandle区域时选区操作不中断
                    // 只有当鼠标确实在dragHandle区域内按下时才不处理选区
                    if (mouseStartedInDragHandle) {
                        // 完全移除对当前鼠标位置的检查，确保选区操作不会被中断
                        return;
                    }

                    const deltaX = Math.abs(e.clientX - mouseDownX);

                    // 如果移动超过阈值，开始框选
                    if (deltaX > DRAG_THRESHOLD) {
                        e.preventDefault();

                        // 只有第一次进入拖拽时才清除之前的选区
                        if (!isSelecting) {
                            isSelecting = true;
                            wasSelecting = true;
                            const rect = waveformCanvas.getBoundingClientRect();
                            selectionStartX = mouseDownX - rect.left + waveformScrollOffset;
                            // 清除之前的选区
                            selectionStart = null;
                            selectionEnd = null;
                            updateSelectionInfo(null, null);
                        }

                        const rect = waveformCanvas.getBoundingClientRect();
                        const currentX = e.clientX - rect.left + waveformScrollOffset;
                        const startX = Math.min(selectionStartX, currentX);
                        const endX = Math.max(selectionStartX, currentX);

                        // 转换为时间
                        const logicalCanvasWidth = waveformCanvas.getBoundingClientRect().width;
                        const startProgress = startX / (logicalCanvasWidth * waveformZoomLevel);
                        const endProgress = endX / (logicalCanvasWidth * waveformZoomLevel);

                        selectionStart = Math.max(0, startProgress * currentSound.duration);
                        selectionEnd = Math.min(currentSound.duration, endProgress * currentSound.duration);

                        // 实时更新显示
                        updateSelectionInfo(selectionStart, selectionEnd);
                        requestAnimationFrame(() => drawMainWaveform());
                    }
                }
            });

            // 鼠标松开 - 判断是点击还是拖拽
            waveformCanvas.addEventListener('mouseup', (e) => {
                if (!currentSound) return;

                // 重置dragHandle标记
                mouseStartedInDragHandle = false;

                if (e.button === 0) {
                    const deltaX = Math.abs(e.clientX - mouseDownX);
                    const deltaTime = Date.now() - mouseDownTime;

                    if (isSelecting) {
                        // 拖拽结束
                        isSelecting = false;

                        // 调试：确认选区数据（选区在波形显示上是以毫秒存储，但显示时/1000转为秒）
                        console.log("选区开始:", selectionStart, "毫秒");
                        console.log("选区结束:", selectionEnd, "毫秒");
                        console.log("选区开始:", selectionStart / 1000, "秒");
                        console.log("选区结束:", selectionEnd / 1000, "秒");

                        // 移除选区最小限制，允许单线选区
                        // 即使选区很小也保持有效选择
                        requestAnimationFrame(() => drawMainWaveform());
                        
                        // 选区完成后预生成临时文件
                        if (selectionStart !== null && selectionEnd !== null) {
                            pregenerateClip();
                        }
                    } else if (deltaX <= DRAG_THRESHOLD && deltaTime < 300) {
                        // 点击（移动少且时间短）- 定位播放头
                        const rect = waveformCanvas.getBoundingClientRect();
                        const clickX = e.clientX - rect.left + waveformScrollOffset;
                        const logicalCanvasWidth = waveformCanvas.getBoundingClientRect().width;
                        const progress = clickX / (logicalCanvasWidth * waveformZoomLevel);
                        // 转换为秒（duration 是毫秒，audioPlayer.currentTime 是秒）
                        const clickTime = Math.max(0, Math.min(currentSound.duration / 1000, progress * (currentSound.duration / 1000)));

                        audioPlayer.currentTime = clickTime;
                        updatePlaybackUI();
                        drawMainWaveform();
                    }
                }
            });

            // 双击清除选区
            waveformCanvas.addEventListener('dblclick', (e) => {
                if (!currentSound) return;

                selectionStart = null;
                selectionEnd = null;
                updateSelectionInfo(null, null);
                requestAnimationFrame(() => drawMainWaveform());
            });

            // 鼠标离开时结束框选
            waveformCanvas.addEventListener('mouseleave', () => {
                if (isSelecting) {
                    isSelecting = false;
                    // 移除选区最小限制，允许单线选区
                    // 即使选区很小也保持有效选择
                    requestAnimationFrame(() => drawMainWaveform());
                }
            });

            // 选区信息更新函数
            const dragHandle = document.getElementById('dragHandle');
            const waveContainer = document.getElementById('waveformContainer');

            function updateSelectionInfo(start, end) {
                const selectionInfoEl = document.getElementById('selectionInfo');
                const selectionStartEl = document.getElementById('selectionStart');
                const selectionEndEl = document.getElementById('selectionEnd');

                if (start !== null && end !== null && start < end) {
                    if (selectionInfoEl) selectionInfoEl.classList.remove('hidden');
                    // 显示为秒（除以1000）
                    if (selectionStartEl) selectionStartEl.textContent = (start / 1000).toFixed(2);
                    if (selectionEndEl) selectionEndEl.textContent = (end / 1000).toFixed(2);

                    // 使用统一的拖拽手柄更新函数（严格绑定选区）
                    updateDragHandlePosition();
                } else {
                    if (selectionInfoEl) selectionInfoEl.classList.add('hidden');

                    // 隐藏拖拽手柄
                    if (dragHandle) {
                        dragHandle.classList.add('hidden');
                        dragHandle.setAttribute('draggable', 'false');
                    }
                }
            }

            // ==================== 拖拽导出功能（原生拖拽到DAW）====================
            let pendingDragPath = null;
            let isGeneratingClip = false;
            let clipGenerationPromise = null;
            let lastSelectionKey = null;  // 用于判断选区是否变化

            // 预生成临时文件函数
            async function pregenerateClip() {
                if (!currentSound || selectionStart === null || selectionEnd === null) {
                    return;
                }
                
                // 如果正在生成中，等待完成
                if (isGeneratingClip && clipGenerationPromise) {
                    console.log('[拖拽] 等待正在进行的生成...');
                    await clipGenerationPromise;
                    return;
                }
                
                const startSec = selectionStart / 1000;
                const endSec = selectionEnd / 1000;
                const filePath = currentSound.path || currentSound.filePath;
                const selectionKey = `${filePath}_${startSec}_${endSec}`;
                
                // 如果选区没变且已有文件，跳过
                if (selectionKey === lastSelectionKey && pendingDragPath) {
                    console.log('[拖拽] 选区未变化，跳过生成');
                    return;
                }
                
                lastSelectionKey = selectionKey;
                const clipDuration = endSec - startSec;
                console.log('[拖拽] 预生成临时文件，时长:', clipDuration.toFixed(2), '秒');
                
                // 显示生成中状态
                const dragHandleText = document.getElementById('dragHandleText');
                if (dragHandleText) {
                    dragHandleText.textContent = '生成中...';
                }
                
                isGeneratingClip = true;
                
                clipGenerationPromise = (async () => {
                    try {
                        let result;
                        if (window.electronAPI && window.electronAPI.backendAPI) {
                            result = await window.electronAPI.backendAPI.exportClip(filePath, startSec, endSec);
                        } else {
                            const response = await rendererApi.fetch('/api/export/clip', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ path: filePath, start: startSec, end: endSec, temp_file: true })
                            });
                            result = await response.json();
                        }

                        if (result && result.success && result.output_path) {
                            pendingDragPath = result.output_path;
                            console.log('[拖拽] 文件已生成:', pendingDragPath);
                            
                            // 恢复拖拽文字
                            if (dragHandleText) {
                                dragHandleText.textContent = i18n.t('player.drag.export');
                            }
                            
                            return true;
                        } else {
                            console.error('[拖拽] 失败:', result?.message || result?.detail || result?.error || '未知错误', result);
                            if (dragHandleText) {
                                dragHandleText.textContent = i18n.t('player.drag.failed');
                            }
                            return false;
                        }
                    } catch (error) {
                        console.error('[拖拽] 异常:', error);
                        if (dragHandleText) {
                            dragHandleText.textContent = i18n.t('player.drag.failed');
                        }
                        return false;
                    } finally {
                        isGeneratingClip = false;
                    }
                })();
                
                await clipGenerationPromise;
            }

            if (dragHandle) {
                // 使用 HTML5 原生拖拽 API
                dragHandle.setAttribute('draggable', 'true');
                
                // dragstart: 在拖拽开始时同步设置数据
                dragHandle.addEventListener('dragstart', (e) => {
                    console.log('[拖拽] dragstart 触发');
                    
                    if (!pendingDragPath) {
                        console.log('[拖拽] 文件尚未生成，取消拖拽');
                        e.preventDefault();
                        return;
                    }
                    
                    // 使用 Electron 的拖拽 API
                    if (window.electronAPI && window.electronAPI.startDrag) {
                        e.preventDefault();
                        window.electronAPI.startDrag(pendingDragPath);
                        console.log('[拖拽] Electron startDrag 调用:', pendingDragPath);
                    } else {
                        // 浏览器环境：设置拖拽数据
                        e.dataTransfer.setData('text/plain', pendingDragPath);
                        e.dataTransfer.setData('text/uri-list', 'file://' + pendingDragPath);
                        e.dataTransfer.effectAllowed = 'copy';
                        console.log('[拖拽] 浏览器拖拽数据已设置');
                    }
                });
                
                // mousedown: 检查文件是否已生成
                dragHandle.addEventListener('mousedown', async (e) => {
                    if (e.button !== 0) return;
                    if (!currentSound || selectionStart === null || selectionEnd === null) {
                        return;
                    }
                    
                    // 如果还没有文件，立即开始生成
                    if (!pendingDragPath && !isGeneratingClip) {
                        await pregenerateClip();
                    }
                });

                // dragend: 拖拽结束清理
                dragHandle.addEventListener('dragend', (e) => {
                    console.log('[拖拽] dragend');
                    pendingDragPath = null;
                    clipGenerationPromise = null;
                    lastSelectionKey = null;
                });
            }

            // ==================== 波形滚轮缩放 ====================
            document.getElementById('waveformContainer').addEventListener('wheel', (e) => {
                if (!currentSound) return;
                e.preventDefault();

                const waveContainer = document.getElementById('waveformContainer');
                const containerRect = waveContainer.getBoundingClientRect();
                
                const canvasWidth = waveContainer.offsetWidth;
                
                // 鼠标在内容中的相对位置 (0-1)，考虑当前滚动
                const mouseX = e.clientX - containerRect.left;
                const oldTotalWidth = canvasWidth * waveformZoomLevel;
                const mouseContentRatio = (mouseX + waveformScrollOffset) / oldTotalWidth;

                // 计算缩放
                const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
                const newZoom = Math.max(WAVEFORM_MIN_ZOOM, Math.min(WAVEFORM_MAX_ZOOM, waveformZoomLevel * zoomFactor));

                // 如果缩放比例变化很小，跳过
                if (Math.abs(newZoom - waveformZoomLevel) < 0.001) return;

                // 计算缩放后波形的总宽度
                const newTotalWidth = canvasWidth * newZoom;
                
                // 缩放后，鼠标应该指向内容的相同位置
                // 新位置 = 新内容宽度 * 鼠标相对位置
                // 滚动偏移 = 新位置 - 鼠标在画布上的位置
                let newScrollOffset = (mouseContentRatio * newTotalWidth) - mouseX;
                
                // 限制滚动范围
                const maxScroll = Math.max(0, newTotalWidth - canvasWidth);
                waveformScrollOffset = Math.max(0, Math.min(maxScroll, newScrollOffset));
                
                // 应用新缩放
                waveformZoomLevel = newZoom;

                // 更新缩放显示
                updateZoomDisplay();

                // 使用 requestAnimationFrame 进行平滑重绘
                requestAnimationFrame(() => {
                    drawMainWaveform();
                });
            }, { passive: false });

            // ==================== 波形拖动/滚动功能 ====================
            let isDraggingWaveform = false;
            let lastDragX = 0;

            document.getElementById('waveformContainer').addEventListener('mousedown', (e) => {
                // Shift+拖动 或 中键拖动 来滚动波形
                if (e.shiftKey || e.button === 1) {
                    e.preventDefault();
                    isDraggingWaveform = true;
                    lastDragX = e.clientX;
                    document.body.style.cursor = 'grabbing';
                }
            });

            document.addEventListener('mousemove', (e) => {
                if (isDraggingWaveform && currentSound) {
                    const deltaX = lastDragX - e.clientX;
                    lastDragX = e.clientX;

                    const canvas = document.getElementById('mainWaveform');
                    const canvasWidth = canvas.getBoundingClientRect().width;
                    const totalWidth = canvasWidth * waveformZoomLevel;
                    const maxScroll = Math.max(0, totalWidth - canvasWidth);

                    waveformScrollOffset = Math.max(0, Math.min(maxScroll, waveformScrollOffset + deltaX));
                    requestAnimationFrame(() => drawMainWaveform());
                }
            });

            document.addEventListener('mouseup', () => {
                if (isDraggingWaveform) {
                    isDraggingWaveform = false;
                    document.body.style.cursor = '';
                }
            });

            // 鼠标离开容器时停止拖动
            document.getElementById('waveformContainer').addEventListener('mouseleave', () => {
                if (isDraggingWaveform) {
                    isDraggingWaveform = false;
                    document.body.style.cursor = '';
                }
            });

            // ==================== 缩放按钮事件 ====================
            document.getElementById('zoomInBtn').addEventListener('click', () => {
                if (!currentSound) return;
                const canvas = document.getElementById('mainWaveform');
                const canvasWidth = canvas.getBoundingClientRect().width;
                const oldZoom = waveformZoomLevel;
                waveformZoomLevel = Math.min(WAVEFORM_MAX_ZOOM, waveformZoomLevel * ZOOM_BUTTON_FACTOR);

                if (waveformZoomLevel !== oldZoom) {
                    // 以波形中心为基准缩放
                    const totalWidth = canvasWidth * waveformZoomLevel;
                    const maxScroll = Math.max(0, totalWidth - canvasWidth);
                    const centerOffset = canvasWidth / 2 + waveformScrollOffset;
                    waveformScrollOffset = (centerOffset * (waveformZoomLevel / oldZoom)) - canvasWidth / 2;
                    waveformScrollOffset = Math.max(0, Math.min(maxScroll, waveformScrollOffset));

                    updateZoomDisplay();
                    requestAnimationFrame(() => drawMainWaveform());
                }
            });

            document.getElementById('zoomOutBtn').addEventListener('click', () => {
                if (!currentSound) return;
                const canvas = document.getElementById('mainWaveform');
                const canvasWidth = canvas.getBoundingClientRect().width;
                const oldZoom = waveformZoomLevel;
                waveformZoomLevel = Math.max(WAVEFORM_MIN_ZOOM, waveformZoomLevel / ZOOM_BUTTON_FACTOR);

                if (waveformZoomLevel !== oldZoom) {
                    const totalWidth = canvasWidth * waveformZoomLevel;
                    const maxScroll = Math.max(0, totalWidth - canvasWidth);
                    const centerOffset = canvasWidth / 2 + waveformScrollOffset;
                    waveformScrollOffset = (centerOffset * (waveformZoomLevel / oldZoom)) - canvasWidth / 2;
                    waveformScrollOffset = Math.max(0, Math.min(maxScroll, waveformScrollOffset));

                    updateZoomDisplay();
                    requestAnimationFrame(() => drawMainWaveform());
                }
            });

            document.getElementById('zoomResetBtn').addEventListener('click', () => {
                if (!currentSound) return;
                waveformZoomLevel = 1.0;
                waveformScrollOffset = 0;
                updateZoomDisplay();
                requestAnimationFrame(() => drawMainWaveform());
            });

            // Volume
            const volumeSlider = document.getElementById('volumeSlider');
            volumeSlider.addEventListener('input', (e) => {
                currentVolume = parseInt(e.target.value);
                document.getElementById('volumeValue').textContent = `${currentVolume}%`;
                document.getElementById('volumeFill').style.width = `${currentVolume}%`;
                
                if (audioPlayer) {
                    audioPlayer.volume = channelState.silent ? 0 : currentVolume / 100;
                }
                
                if (currentVolume > 0 && isMuted) {
                    isMuted = false;
                    document.getElementById('volumeIcon').setAttribute('data-lucide', 'volume-2');
                    lucide.createIcons();
                }
            });
            
            document.getElementById('muteBtn').addEventListener('click', () => {
                isMuted = !isMuted;
                const icon = isMuted ? 'volume-x' : (currentVolume == 0 ? 'volume' : 'volume-2');
                document.getElementById('volumeIcon').setAttribute('data-lucide', icon);
                lucide.createIcons();
            });

            // ==================== SETTINGS MODAL ====================
            // 打开 AI 设置按钮（导航栏）
            document.getElementById('installUpdateBtn')?.addEventListener('click', () => {
                document.getElementById('settingsDropdown')?.classList.add('hidden');
                installLocalUpdate();
            });

            document.getElementById('openSkinBtn')?.addEventListener('click', () => {
                document.getElementById('settingsDropdown')?.classList.add('hidden');
                showSkinModal();
            });

            applySavedSkin();

            document.getElementById('openAISettingsBtn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                // 关闭设置下拉菜单
                document.getElementById('settingsDropdown').classList.add('hidden');
                document.getElementById('settingsDropdown').classList.remove('visible');
                // 打开设置弹窗
                openSettingsModal();
            });

            // 打开 AI 设置按钮（Chat 面板）
            document.getElementById('openAISettingsBtnChat')?.addEventListener('click', () => {
                openSettingsModal();
            });

            // 关闭设置弹窗
            document.getElementById('closeSettingsModal')?.addEventListener('click', closeSettingsModal);
            document.getElementById('cancelSettingsBtn')?.addEventListener('click', closeSettingsModal);

            // Tab 切换
            document.getElementById('llmTabBtn')?.addEventListener('click', () => {
                document.getElementById('llmTabBtn').classList.add('border-blue-500');
                document.getElementById('llmTabBtn').classList.remove('border-transparent');
                document.getElementById('embeddingTabBtn').classList.remove('border-blue-500');
                document.getElementById('embeddingTabBtn').classList.add('border-transparent');
                document.getElementById('sfxConfigTabBtn').classList.remove('border-blue-500');
                document.getElementById('sfxConfigTabBtn').classList.add('border-transparent');
                document.getElementById('descTabBtn').classList.remove('border-blue-500');
                document.getElementById('descTabBtn').classList.add('border-transparent');
                document.getElementById('llmConfigContent').classList.remove('hidden');
                document.getElementById('embeddingConfigContent').classList.add('hidden');
                document.getElementById('sfxConfigContent').classList.add('hidden');
                document.getElementById('descConfigContent').classList.add('hidden');
            });

            document.getElementById('embeddingTabBtn')?.addEventListener('click', () => {
                document.getElementById('embeddingTabBtn').classList.add('border-blue-500');
                document.getElementById('embeddingTabBtn').classList.remove('border-transparent');
                document.getElementById('llmTabBtn').classList.remove('border-blue-500');
                document.getElementById('llmTabBtn').classList.add('border-transparent');
                document.getElementById('sfxConfigTabBtn').classList.remove('border-blue-500');
                document.getElementById('sfxConfigTabBtn').classList.add('border-transparent');
                document.getElementById('descTabBtn').classList.remove('border-blue-500');
                document.getElementById('descTabBtn').classList.add('border-transparent');
                document.getElementById('embeddingConfigContent').classList.remove('hidden');
                document.getElementById('llmConfigContent').classList.add('hidden');
                document.getElementById('sfxConfigContent').classList.add('hidden');
                document.getElementById('descConfigContent').classList.add('hidden');
            });

            document.getElementById('sfxConfigTabBtn')?.addEventListener('click', () => {
                document.getElementById('sfxConfigTabBtn').classList.add('border-blue-500');
                document.getElementById('sfxConfigTabBtn').classList.remove('border-transparent');
                document.getElementById('llmTabBtn').classList.remove('border-blue-500');
                document.getElementById('llmTabBtn').classList.add('border-transparent');
                document.getElementById('embeddingTabBtn').classList.remove('border-blue-500');
                document.getElementById('embeddingTabBtn').classList.add('border-transparent');
                document.getElementById('descTabBtn').classList.remove('border-blue-500');
                document.getElementById('descTabBtn').classList.add('border-transparent');
                document.getElementById('sfxConfigContent').classList.remove('hidden');
                document.getElementById('llmConfigContent').classList.add('hidden');
                document.getElementById('embeddingConfigContent').classList.add('hidden');
                document.getElementById('descConfigContent').classList.add('hidden');
                loadSfxConfigStatus();
            });

            // ========== AI 一句话描述 ==========
            async function loadDescStats() {
                try {
                    const res = await rendererApi.get('/api/v1/descriptions/stats');
                    if (res && res.success) {
                        const el = document.getElementById('descStats');
                        if (el) {
                            const auto = res.auto_count || 0;
                            const pending = res.remaining + auto;
                            el.textContent = pending === 0
                                ? `AI 描述 ${res.completed} 条 · 共 ${res.total} 条，全部完成`
                                : `AI 描述 ${res.completed} 条 · 文件名兜底 ${auto} 条 · 待精修/生成 ${pending} 条`;
                        }
                        return res;
                    }
                } catch (e) {
                    console.error('加载描述统计失败:', e);
                }
                return null;
            }

            let descBatchRunning = false;
            // ===== 描述包快捷入口（顶部按钮 + 导入菜单） =====
            const wireDescPackShortcuts = () => {
                // 顶部这颗按钮现在直接导「知识包」：先找安装目录里的包，
                // 找不到就弹文件选择框让用户挑 zip。
                document.getElementById('descPackMenuBtn')?.addEventListener('click', async () => {
                    // 让用户自己选包（默认定位到安装目录里的那个，新用户直接回车即可）
                    let defaultPath = '';
                    try {
                        const info = await rendererApi.get('/api/v1/knowledge/available');
                        if (info?.available && info.path) defaultPath = info.path;
                    } catch (_) { }
                    try {
                        const picked = await window.electronAPI?.dialogs?.showOpenDialog({
                            title: '选择知识包（EchoMind-知识包.zip）',
                            defaultPath: defaultPath || undefined,
                            filters: [{ name: '知识包', extensions: ['zip'] }],
                            properties: ['openFile'],
                        });
                        const filePath = picked?.filePaths?.[0] || picked?.filePath;
                        if (filePath) {
                            const mod = window.EchoMindKnowledgePack;
                            if (mod && typeof mod.importPack === 'function') {
                                await mod.importPack(filePath);
                            } else {
                                showNotification('知识包导入尚未就绪，请稍后重试', 'error');
                            }
                        }
                    } catch (error) {
                        showNotification('选择知识包失败: ' + (error?.message || error), 'error');
                    }
                });
            };
            wireDescPackShortcuts();



            // 知识包逻辑已抽到 assets/renderer/knowledge-pack.js；这里只注入依赖
            window.EchoMindKnowledgePack?.mount({
                api: rendererApi,
                notify: showNotification,
                getProject: () => currentProject?.id || "default",
                onImported: async () => {
                    await refreshProjectIndexStatus();
                    loadFilesFromDatabase();
                },
            });
            document.getElementById('batchDescBtn')?.addEventListener('click', async () => {
                if (descBatchRunning) return;
                descBatchRunning = true;
                const btn = document.getElementById('batchDescBtn');
                const wrap = document.getElementById('descProgressWrap');
                const bar = document.getElementById('descProgressBar');
                const ptext = document.getElementById('descProgressText');
                const log = document.getElementById('descLog');
                btn.disabled = true;
                btn.textContent = '生成中...';
                wrap.classList.remove('hidden');
                let totalDone = 0;
                try {
                    for (let round = 0; round < 10000; round++) {
                        const res = await rendererApi.post('/api/v1/descriptions/batch', { limit: 100 });
                        if (!res || !res.success) {
                            log.textContent += `\n批次失败: ${res?.detail || '未知错误'}`;
                            break;
                        }
                        totalDone += res.processed;
                        const stats = await loadDescStats();
                        const remaining = res.remaining ?? stats?.remaining ?? 0;
                        const auto = stats?.auto_count || 0;
                        const pending = remaining + auto;
                        const total = stats?.total ?? totalDone + pending;
                        const pct = total > 0 ? Math.round((total - pending) / total * 100) : 100;
                        bar.style.width = pct + '%';
                        ptext.textContent = `已处理 ${totalDone} 条（本批成功 ${res.succeeded}，失败 ${res.failed}），待精修/生成 ${pending} 条`;
                        log.textContent = `本轮完成 ${res.processed} 条，成功 ${res.succeeded} 条，失败 ${res.failed} 条；剩余 ${pending} 条`;
                        if (res.done || remaining === 0 && auto === 0) {
                            log.textContent += '\n✅ 全部完成，正在重建文本索引（几分钟），完成后描述即可被搜索命中。';
                            break;
                        }
                        if (res.succeeded === 0 && res.failed > 0) {
                            log.textContent += '\n连续失败，请检查 LLM 配置后重试（已处理部分已保存，可断点续跑）。';
                            break;
                        }
                    }
                } catch (e) {
                    log.textContent += `\n错误: ${e.message || e}`;
                } finally {
                    descBatchRunning = false;
                    btn.disabled = false;
                    btn.textContent = '继续批量生成';
                    await loadDescStats();
                }
            });

            document.getElementById('descTabBtn')?.addEventListener('click', () => {
                document.getElementById('descTabBtn').classList.add('border-blue-500');
                document.getElementById('descTabBtn').classList.remove('border-transparent');
                document.getElementById('llmTabBtn').classList.remove('border-blue-500');
                document.getElementById('llmTabBtn').classList.add('border-transparent');
                document.getElementById('embeddingTabBtn').classList.remove('border-blue-500');
                document.getElementById('embeddingTabBtn').classList.add('border-transparent');
                document.getElementById('sfxConfigTabBtn').classList.remove('border-blue-500');
                document.getElementById('sfxConfigTabBtn').classList.add('border-transparent');
                document.getElementById('descConfigContent').classList.remove('hidden');
                document.getElementById('llmConfigContent').classList.add('hidden');
                document.getElementById('embeddingConfigContent').classList.add('hidden');
                document.getElementById('sfxConfigContent').classList.add('hidden');
                loadDescStats();
            });

            // LLM 提供者切换
            document.querySelectorAll('input[name="llmProvider"]').forEach(radio => {
                radio.addEventListener('change', (e) => {
                    updateLlmConfigDisplay(e.target.value);
                });
            });

            // Embedding 提供者切换
            document.querySelectorAll('input[name="embeddingProvider"]').forEach(radio => {
                radio.addEventListener('change', (e) => {
                    updateEmbeddingConfigDisplay(e.target.value);
                });
            });

            // 测试连接按钮
            document.getElementById('testConnectionBtn')?.addEventListener('click', testAiConnection);

            // 保存配置按钮
            document.getElementById('saveSettingsBtn')?.addEventListener('click', saveAiConfig);

            // 音频生成（豆包语音）配置
            async function loadSfxConfigStatus() {
                try {
                    // 优先读本地配置文件（不受后端繁忙影响），回退到后端接口
                    let configured = false;
                    let saveDir = '';
                    if (window.electronAPI?.sfxConfig?.get) {
                        const local = await window.electronAPI.sfxConfig.get();
                        if (local?.success) {
                            configured = Boolean(local.apiKey);
                            saveDir = local.saveDir || '';
                        }
                    } else {
                        const remote = await rendererApi.get('/api/v1/sfx/config');
                        configured = Boolean(remote?.configured);
                        saveDir = remote?.save_dir || '';
                    }
                    const statusEl = document.getElementById('sfxConfigStatus');
                    if (statusEl) {
                        statusEl.textContent = configured ? '已配置，可生成音效' : '未配置 API Key';
                    }
                    const dirEl = document.getElementById('sfxSaveDirInput');
                    if (dirEl && !dirEl.value && saveDir) dirEl.value = saveDir;
                } catch (e) {
                    console.error('加载音频生成配置失败:', e);
                }
            }
            // 保存目录改为系统目录选择器（文本框只读，避免手输路径）
            document.getElementById('sfxPickDirBtn')?.addEventListener('click', async () => {
                const input = document.getElementById('sfxSaveDirInput');
                try {
                    if (!window.electronAPI?.dialogs?.showOpenDialog) {
                        showNotification?.('当前环境不支持目录选择，请手动输入', 'error');
                        return;
                    }
                    const result = await window.electronAPI.dialogs.showOpenDialog({
                        title: '选择音效生成保存目录',
                        properties: ['openDirectory', 'createDirectory'],
                        defaultPath: (input?.value || '').trim() || undefined
                    });
                    if (!result || result.canceled || !result.filePaths?.length) return;
                    if (input) input.value = result.filePaths[0];
                } catch (e) {
                    console.error('选择保存目录失败:', e);
                    showNotification?.('选择目录失败: ' + (e.message || e), 'error');
                }
            });

            document.getElementById('saveSfxConfigBtn')?.addEventListener('click', async () => {
                const keyInput = document.getElementById('sfxApiKeyInput');
                const dirInput = document.getElementById('sfxSaveDirInput');
                const statusEl = document.getElementById('sfxConfigStatus');
                const key = (keyInput.value || '').trim();
                const dir = (dirInput.value || '').trim();
                const setStatus = (text, ok) => {
                    if (statusEl) {
                        statusEl.textContent = text;
                        statusEl.style.color = ok ? '#22c55e' : '#ef4444';
                    }
                };
                setStatus('正在保存…', true);
                try {
                    // 优先走本地文件写入（毫秒级，不受后端索引影响）
                    if (window.electronAPI?.sfxConfig?.save) {
                        const result = await window.electronAPI.sfxConfig.save({ apiKey: key, saveDir: dir });
                        if (!result?.success) throw new Error(result?.error || '写入失败');
                        const text = key ? '已保存，API Key 已生效（后台同步中）' : '已保存';
                        setStatus(text, true);
                        showNotification(text, 'success');
                        return;
                    }
                    const data = await rendererApi.post('/api/v1/sfx/config', {
                        api_key: key,
                        save_dir: dir
                    });
                    console.log('[SFX] 保存响应:', data);
                    if (!data || !data.success) throw new Error((data && data.detail) || '后端未确认保存');
                    // 回读一次，确认后端真的识别到了配置（而不是只写文件）
                    let configured = null;
                    try {
                        const status = await rendererApi.get('/api/v1/sfx/config');
                        configured = !!status.configured;
                        console.log('[SFX] 回读状态:', status);
                    } catch (e) {
                        console.warn('[SFX] 回读状态失败:', e);
                    }
                    const okText = configured === true
                        ? '已保存，API Key 已生效'
                        : (configured === false && key
                            ? '已写入配置，但后端未识别到 Key'
                            : '已保存');
                    setStatus(okText, configured !== false || !key);
                    showNotification(okText, configured === false && key ? 'error' : 'success');
                } catch (e) {
                    console.error('保存音频生成配置失败:', e);
                    const message = '保存失败：' + (e.message || e);
                    setStatus(message, false);
                    showNotification(message, 'error');
                }
            });

            // ===== 窗口与托盘设置 =====
            const CLOSE_BEHAVIOR_LABELS = { tray: '最小化到托盘', minimize: '最小化到任务栏', quit: '直接退出程序' };

            window.__loadWindowPrefs = loadWindowPrefs;
            async function loadWindowPrefs() {
                try {
                    if (!window.electronAPI?.windowPrefs) return;
                    const data = await window.electronAPI.windowPrefs.get();
                    const value = data?.closeBehavior || 'tray';
                    document.querySelectorAll('input[name="closeBehavior"]').forEach(r => {
                        r.checked = r.value === value;
                    });
                    const st = document.getElementById('windowPrefsStatus');
                    if (st) st.textContent = '当前：' + (CLOSE_BEHAVIOR_LABELS[value] || value);
                } catch (e) {
                    console.error('读取窗口设置失败:', e);
                }
            }

            document.querySelectorAll('input[name="closeBehavior"]').forEach(radio => {
                radio.addEventListener('change', async () => {
                    if (!radio.checked) return;
                    const statusEl = document.getElementById('windowPrefsStatus');
                    try {
                        const res = await window.electronAPI?.windowPrefs?.set({ closeBehavior: radio.value });
                        const value = res?.closeBehavior || radio.value;
                        if (statusEl) statusEl.textContent = '已保存：' + (CLOSE_BEHAVIOR_LABELS[value] || value);
                        showNotification?.('窗口行为已更新', 'success');
                    } catch (e) {
                        if (statusEl) statusEl.textContent = '保存失败：' + (e.message || e);
                    }
                });
            });

            document.getElementById('windowTabBtn')?.addEventListener('click', loadWindowPrefs);

            // ===== 关于与更新 =====
            let updateInfo = null;

            async function loadTelemetryState() {
                const toggle = document.getElementById('telemetryToggle');
                const status = document.getElementById('telemetryStatus');
                if (!toggle || !window.electronAPI?.telemetry) return;
                try {
                    const res = await window.electronAPI.telemetry.get();
                    toggle.checked = res?.enabled !== false;
                    if (status) {
                        status.textContent = toggle.checked
                            ? '已开启：每次启动上报一次启动计数，不含任何个人信息'
                            : '已关闭：不会再发送任何统计请求';
                    }
                } catch (_) {
                    if (status) status.textContent = '读取统计设置失败（不影响使用）';
                }
            }

            document.getElementById('telemetryToggle')?.addEventListener('change', async (event) => {
                const toggle = event.target;
                const status = document.getElementById('telemetryStatus');
                if (!window.electronAPI?.telemetry) return;
                try {
                    const res = await window.electronAPI.telemetry.set(toggle.checked);
                    if (status) {
                        status.textContent = res?.enabled
                            ? '已开启：每次启动上报一次启动计数，不含任何个人信息'
                            : '已关闭：不会再发送任何统计请求';
                    }
                } catch (_) {
                    toggle.checked = !toggle.checked;
                    if (status) status.textContent = '保存失败，请重试';
                }
            });

            async function fillCurrentVersion() {
                const el = document.getElementById('updateCurrentVersion');
                if (!el || !window.electronAPI?.updates) return;
                try {
                    el.textContent = 'v' + await window.electronAPI.updates.version();
                } catch (_) { }
            }

            async function runUpdateCheck() {
                const btn = document.getElementById('updateCheckBtn');
                const status = document.getElementById('updateStatus');
                const result = document.getElementById('updateResult');
                if (!btn || !status || !result) return;
                if (!window.electronAPI?.updates) {
                    status.textContent = '当前环境不支持检查更新';
                    return;
                }
                btn.disabled = true;
                btn.textContent = '检查中…';
                try {
                    const res = await window.electronAPI.updates.check();
                    await fillCurrentVersion();
                    if (!res || !res.ok) {
                        status.textContent = (res && res.error) || '检查失败';
                        result.classList.add('hidden');
                        return;
                    }
                    if (!res.hasUpdate) {
                        status.textContent = '已是最新版本';
                        result.classList.add('hidden');
                        return;
                    }
                    updateInfo = res.latest;
                    status.textContent = '发现新版本';
                    document.getElementById('updateLatestVersion').textContent =
                        'v' + res.latest.version + (res.latest.releasedAt ? '（' + res.latest.releasedAt + '）' : '');
                    document.getElementById('updateNotes').textContent =
                        (res.latest.notes || []).join('\n') || '这个版本没有写更新说明';
                    document.getElementById('updateCodeHint').textContent =
                        res.latest.code ? ('提取码 ' + res.latest.code) : '';
                    document.getElementById('updateOpenBtn').disabled = !res.latest.url;
                    result.classList.remove('hidden');
                } finally {
                    btn.disabled = false;
                    btn.textContent = '检查更新';
                }
            }

            document.getElementById('updateTabBtn')?.addEventListener('click', () => {
                fillCurrentVersion();
                loadTelemetryState();
            });
            document.getElementById('updateCheckBtn')?.addEventListener('click', runUpdateCheck);
            document.getElementById('updateOpenBtn')?.addEventListener('click', () => {
                if (!updateInfo || !updateInfo.url) return;
                window.electronAPI?.updates?.openExternal(updateInfo.url);
            });
            document.getElementById('updateCopyCodeBtn')?.addEventListener('click', async () => {
                if (!updateInfo || !updateInfo.code) return;
                try {
                    await navigator.clipboard.writeText(updateInfo.code);
                    showNotification('提取码已复制：' + updateInfo.code, 'success');
                } catch (_) {
                    showNotification('提取码：' + updateInfo.code, 'info');
                }
            });

            // 启动后静默查一次（24 小时节流），有新版才提示，失败就当没网
            setTimeout(async () => {
                if (!window.electronAPI?.updates) return;
                let last = 0;
                try { last = Number(localStorage.getItem('echomind.lastUpdateCheck') || 0); } catch (_) { }
                if (Date.now() - last < 24 * 3600 * 1000) return;
                try {
                    const res = await window.electronAPI.updates.check();
                    if (!res || !res.ok) return;
                    try { localStorage.setItem('echomind.lastUpdateCheck', String(Date.now())); } catch (_) { }
                    if (res.hasUpdate) {
                        showNotification('发现新版本 v' + res.latest.version + '，设置 → 关于与更新 可查看', 'info');
                    }
                } catch (_) { }
            }, 6000);

            // ===== 左侧分隔条：文件夹 / 标签 可拖拽 =====
            (function initSideSplitter() {
                const splitter = document.getElementById('sideSplitter');
                const folderPanel = document.getElementById('folderPanelSection');
                const tagPanel = document.getElementById('tagPanelSection');
                if (!splitter || !folderPanel || !tagPanel) return;
                let dragging = false;
                let startY = 0;
                let startHeight = 0;
                splitter.addEventListener('mousedown', (event) => {
                    dragging = true;
                    startY = event.clientY;
                    startHeight = folderPanel.offsetHeight;
                    document.body.style.cursor = 'row-resize';
                    event.preventDefault();
                });
                window.addEventListener('mousemove', (event) => {
                    if (!dragging) return;
                    const total = folderPanel.offsetHeight + tagPanel.offsetHeight;
                    const next = Math.max(80, Math.min(total - 80, startHeight + (event.clientY - startY)));
                    folderPanel.style.height = next + 'px';
                    folderPanel.style.maxHeight = 'none';
                    folderPanel.style.flex = '0 0 auto';
                    tagPanel.style.flex = '1 1 0';
                });
                window.addEventListener('mouseup', () => {
                    if (!dragging) return;
                    dragging = false;
                    document.body.style.cursor = '';
                });
            })();

            // ===== 标签搜索 =====
            document.getElementById('tagSearchInput')?.addEventListener('input', () => renderCategoryTree());
            document.getElementById('folderSearchInput')?.addEventListener('input', () => renderFolderTree());

            // 标签页高亮/内容切换统一收口，避免新增标签后旧逻辑残留
            document.addEventListener('click', (e) => {
                const btn = e.target?.closest?.('.settings-tab');
                if (!btn) return;
                setTimeout(() => {
                    document.querySelectorAll('.settings-tab').forEach(b => {
                        const on = b === btn;
                        b.classList.toggle('border-blue-500', on);
                        b.classList.toggle('border-transparent', !on);
                    });
                    const map = {
                        llmTabBtn: 'llmConfigContent',
                        embeddingTabBtn: 'embeddingConfigContent',
                        sfxConfigTabBtn: 'sfxConfigContent',
                        descTabBtn: 'descConfigContent',
                        windowTabBtn: 'windowConfigContent',
                        updateTabBtn: 'updateConfigContent'
                    };
                    Object.entries(map).forEach(([id, contentId]) => {
                        document.getElementById(contentId)?.classList.toggle('hidden', id !== btn.id);
                    });
                }, 0);
            }, true);

            // 点击遮罩关闭
            document.getElementById('settingsModal')?.addEventListener('click', (e) => {
                if (e.target.id === 'settingsModal') {
                    closeSettingsModal();
                }
            });

            // Chat
            document.getElementById('sendMessage').addEventListener('click', () => {
                const input = document.getElementById('chatInput');
                const text = input.value.trim();
                if (text) {
                    handleChatMessage(text);
                    input.value = '';
                }
            });
            
            document.getElementById('chatInput').addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    document.getElementById('sendMessage').click();
                }
            });

            // 空格键播放/暂停控制
            document.addEventListener('keydown', (e) => {
                // 如果焦点在输入框中，不响应空格键
                const active = document.activeElement;
                // range（倍速滑条）不该挡住空格键；文本框才需要保护
                if (active && (active.tagName === 'TEXTAREA' ||
                    (active.tagName === 'INPUT' && active.type !== 'range'))) {
                    return;
                }

                if (e.code === 'Space') {
                    e.preventDefault();

                    if (isPlaying) {
                        // 正在播放 -> 暂停
                        pausePlayback();
                    } else {
                        // 暂停中 -> 继续播放
                        if (audioPlayer && audioPlayer.src) {
                            // 有选区时智能判断播放范围
                            if (selectionStart !== null && selectionEnd !== null && currentSound) {
                                const currentTime = audioPlayer.currentTime; // 秒
                                const selStart = selectionStart / 1000;     // 转换为秒
                                const selEnd = selectionEnd / 1000;         // 转换为秒

                                let playStart;
                                let playEnd;

                                // 如果上一次播放因为到达选区结束而停止，重新从选区开始播放
                                // 使用更宽松的范围（selEnd + 0.5秒）来处理浮点数精度问题
                                if (lastStoppedAtSelectionEnd && currentTime >= selStart && currentTime <= selEnd + 0.5) {
                                    playStart = selStart;
                                    playEnd = selEnd;
                                    playbackStartedInSelection = true;
                                    lastStoppedAtSelectionEnd = false;  // 重置标记
                                } else {
                                    // 智能判断播放范围 - 专业音频软件逻辑
                                    if (currentTime >= selStart && currentTime <= selEnd) {
                                        // 光标在选区内 -> 从选区开始播放到选区结束（始终从选区开头开始）
                                        playStart = selStart;
                                        playEnd = selEnd;
                                        playbackStartedInSelection = true;
                                    } else if (currentTime < selStart) {
                                        // 光标在选区前 -> 从光标位置播放到选区结束
                                        playStart = currentTime;
                                        playEnd = selEnd;
                                        playbackStartedInSelection = true;
                                        lastStoppedAtSelectionEnd = false;  // 重置标记
                                    } else {
                                        // 光标在选区后 -> 从光标位置播放到音频结尾
                                        playStart = currentTime;
                                        playEnd = currentSound.duration / 1000;
                                        playbackStartedInSelection = false;
                                        lastStoppedAtSelectionEnd = false;  // 重置标记
                                    }
                                }
                                
                                playbackStartTime = playStart;  // 记录播放开始时间

                                // 设置播放范围
                                audioPlayer.currentTime = playStart;

                                // 移除之前的ended监听器
                                audioPlayer.removeEventListener('ended', handlePlaybackEnded);
                                // 添加ended监听器，播放到终点后停止
                                audioPlayer.addEventListener('ended', handlePlaybackEnded);

                                // 开始播放
                                audioPlayer.play().then(() => {
                                    isPlaying = true;
                                    startPlaybackAnimation();
                                    updatePlaybackUI();
                                }).catch(err => {
                                    console.error('播放失败:', err);
                                    startPlayback();
                                });
                            } else {
                                // 无选区，正常播放
                                startPlayback();
                            }
                        } else {
                            // 没有音频源，重新加载
                            if (currentSound) {
                                loadAndPlaySound(currentSound);
                            }
                        }
                    }
                }
            });

            // 播放到结束停止的处理函数
            function handlePlaybackEnded() {
                // 检查是否播放到选区结束位置
                if (selectionStart !== null && selectionEnd !== null && audioPlayer) {
                    const currentTime = audioPlayer.currentTime;
                    const selEnd = selectionEnd / 1000; // 转换为秒
                    
                    // 如果播放到选区结束位置，立即停止播放
                    if (Math.abs(currentTime - selEnd) < 0.1) { // 允许0.1秒的误差
                        isPlaying = false;
                        pausePlayback();
                        // 移除ended监听器
                        if (audioPlayer) {
                            audioPlayer.removeEventListener('ended', handlePlaybackEnded);
                        }
                        return;
                    }
                }
                
                // 正常播放结束处理（选区后区域或其他情况）
                isPlaying = false;
                pausePlayback();
                // 移除ended监听器
                if (audioPlayer) {
                    audioPlayer.removeEventListener('ended', handlePlaybackEnded);
                }
            }
            
            document.querySelectorAll('.example-prompt').forEach(btn => {
                btn.addEventListener('click', () => {
                    const text = btn.textContent.replace(/"/g, '');
                    handleChatMessage(text);
                });
            });
            
            // ==================== 文件导入功能 ====================
            
            // ===== 拖拽导入（文件夹 / 音频文件） =====


            // 导入单个音频文件
            document.getElementById('importFileBtn').addEventListener('click', async () => {
                document.getElementById('importDropdown').classList.add('hidden');
                
                console.log('点击了导入音频文件按钮');
                console.log('window.electronAPI:', window.electronAPI);
                console.log('window.electronAPI.fileImport:', window.electronAPI?.fileImport);
                
                try {
                    if (!window.electronAPI?.fileImport) {
                        console.error('[Import] Electron desktop bridge is unavailable');
                        showNotification(i18n.t('import.electron.required'), 'error');
                        return;
                    }
                    
                    console.log('调用 fileImport.selectAudioFiles...');
                    const importProjectId = currentProject?.id;
                    if (!importProjectId) {
                        throw new Error('当前工程尚未就绪，请稍后重试');
                    }
                    const result = await window.electronAPI.fileImport.selectAudioFiles({
                        title: '选择音频文件'
                    });
                    console.log('选择结果:', result);

                    if (result.success && result.files) {
                        await handleImportedFiles(result.files, importProjectId);
                    } else if (result.canceled) {
                        console.log('用户取消了文件选择');
                    } else {
                        console.error('文件选择失败:', result.error);
                        showNotification('选择文件失败: ' + (result.error || '未知错误'), 'error');
                    }
                } catch (error) {
                    console.error('导入文件时出错:', error);
                    showNotification('导入失败: ' + error.message, 'error');
                }
            });
            
            // 导入文件夹 - 使用新的异步导入 API（带进度）
            document.getElementById('importFolderBtn').addEventListener('click', async () => {
                document.getElementById('importDropdown').classList.add('hidden');
                console.log('[DEBUG] 点击导入文件夹按钮');

                try {
                    // Folder selection is an Electron/main-process capability
                    // and does not depend on backend readiness. Check the
                    // backend only after the user has selected a directory so
                    // a partial service failure can never suppress the native
                    // chooser itself.
                    if (!window.electronAPI?.fileImport) {
                        console.error('[Import] Electron desktop bridge is unavailable');
                        showNotification(i18n.t('import.electron.required'), 'error');
                        return;
                    }

                    scanCancelRequested = false;
                    const folderResult = await window.electronAPI.fileImport.selectFolder({
                        title: '选择音频文件夹'
                    });
                    console.log('[DEBUG] 选择文件夹结果:', folderResult);

                    if (folderResult.success && folderResult.folder) {
                        const folderPath = folderResult.folder;
                        const importProjectId = currentProject?.id;
                        console.log('[DEBUG] 选择的文件夹路径:', folderPath);

                        if (!importProjectId) {
                            throw new Error('当前工程尚未就绪，请稍后重试');
                        }

                        // 导入前先比一遍：这个目录是不是已经导入过了
                        try {
                            const precheck = await rendererApi.post(
                                '/api/v1/db/folder/precheck?project_id=' + encodeURIComponent(importProjectId),
                                { path: folderPath },
                                { timeoutMs: 120000 }
                            );
                            if (precheck && precheck.existing > 0) {
                                const pct = Math.round((precheck.ratio || 0) * 100);
                                const choice = await showImportDuplicateChoice(precheck, pct);
                                if (choice === 'cancel') {
                                    showNotification('已取消导入', 'info');
                                    return;
                                }
                                skipExistingOnImport = (choice === 'new');
                            }
                        } catch (precheckError) {
                            console.warn('[Import] 预检失败，按原流程继续:', precheckError);
                        }

                        if (!window.electronAPI?.backendAPI?.importFolderAsync) {
                            throw new Error(i18n.t('import.backend.unavailable'));
                        }

                        const clientId = `client_${Date.now()}`;
                        console.log('[DEBUG] 生成 clientId:', clientId);

                        // 立即显示进度弹窗（不依赖后端 WebSocket 消息）
                        if (!importRuntime.scanProgressModal) {
                            importRuntime.scanProgressModal = createScanProgressModal();
                            document.body.appendChild(importRuntime.scanProgressModal);
                        }

                        const websocketConnected = await connectScanWebSocket(clientId);

                        try {
                            console.log('[DEBUG] 调用 importFolderAsync API');
                            const result = await window.electronAPI.backendAPI.importFolderAsync(
                                folderPath,
                                true,
                                clientId,
                                importProjectId,
                                skipExistingOnImport
                            );
                            console.log('[DEBUG] importFolderAsync 返回:', result);

                            if (result && result.task_id) {
                                importRuntime.currentScanTaskId = result.task_id;
                                maybeCancelPendingScan();
                                showNotification('正在导入音频文件...', 'info');
                                // 与 WebSocket 并行兜底：WS 丢消息时也能拿到完成事件
                                monitorImportJobWithoutWebSocket(importRuntime.currentScanTaskId);
                            } else {
                                throw new Error('启动导入任务失败：后端未返回任务 ID');
                            }
                        } catch (error) {
                            console.error('[DEBUG] importFolderAsync 异常:', error);
                            showNotification('导入启动失败: ' + error.message, 'error');

                            if (importRuntime.scanProgressModal) {
                                importRuntime.scanProgressModal.remove();
                                importRuntime.scanProgressModal = null;
                            }
                            importRuntime.currentScanTaskId = null;

                            // 关闭 WebSocket
                            if (importRuntime.scanWebSocket) {
                                importRuntime.scanWebSocket.close();
                                importRuntime.scanWebSocket = null;
                            }
                        }
                    } else if (!folderResult.canceled) {
                        console.error('[DEBUG] 选择文件夹失败:', folderResult.error);
                        showNotification('选择文件夹失败', 'error');
                    }
                } catch (error) {
                    console.error('[DEBUG] 导入文件夹时出错:', error);
                    showNotification('导入失败: ' + error.message, 'error');
                }
            });
            
            // 添加文件夹到左侧树形UI
            function addFolderToTree(folderName, folderPath, fileCount) {
                // 查找根文件夹
                const rootFolder = folderData.find(f => f.id === 'root');
                if (rootFolder) {
                    const existingChild = rootFolder.children.find(c => c.name === folderName);
                    if (existingChild) {
                        // 更新已有文件夹
                        existingChild.count = fileCount;
                        existingChild.path = folderPath;
                    } else {
                        // 添加到根文件夹的 children
                        rootFolder.children.push({
                            id: 'folder-' + Date.now(),
                            name: folderName,
                            path: folderPath,
                            count: fileCount
                        });
                    }
                } else {
                    // 如果没有根文件夹，直接添加
                    folderData.push({
                        id: 'folder-' + Date.now(),
                        name: folderName,
                        path: folderPath,
                        count: fileCount,
                        expanded: true
                    });
                }
            }

            // 监听文件选择事件（来自主进程）
            if (window.electronAPI) {
                window.electronAPI.onMenuEvent((event, action) => {
                    if (action === 'menu-import-file') {
                        document.querySelector('button:has(i[data-lucide="upload"])').click();
                    } else if (action === 'menu-import-folder') {
                        document.getElementById('importFolderBtn').click();
                    }
                });
            }

            // 处理导入的文件

        });
