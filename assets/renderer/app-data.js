/* 从 index.html 内联脚本拆出来的第 3 段（app-data.js）—— 纯搬家，逻辑未改动 */
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

});
