/* 从 index.html 内联脚本拆出来的第 2 段（app-ui.js）—— 纯搬家，逻辑未改动 */
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
        // 两种不一致都要管：整目录没了，或者目录还在但个别文件被移走
        const missingDirs = Number(health.missing_count || 0);
        const missingFiles = Number(health.missing_file_count || 0);
        const drifted = missingDirs > 0 || missingFiles > 0;
        const btn = document.getElementById('syncFoldersBtn');
        if (btn) {
            if (!drifted) {
                btn.title = '目录与磁盘一致';
            } else {
                const bits = [];
                if (missingDirs) bits.push(missingDirs + ' 个目录不存在');
                if (missingFiles) bits.push(missingFiles + ' 个文件不在原位');
                btn.title = bits.join('，') + '，点这里修复';
            }
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
        // 文件级也要算：目录还在但个别文件被移走时 missing_count 是 0（11-04）
        if (!health.missing_count && !health.missing_file_count) {
            showNotification(`目录与磁盘一致（${health.total_dirs} 个目录）`, 'success');
            return;
        }
        const sample = (health.missing || []).slice(0, 5).map(item => `${item.path}（${item.files} 个文件）`).join('\n');
        const ok = confirm(
            `检测到 ${health.missing_count} 个目录在磁盘上不存在，涉及 ${health.missing_files} 个文件。\n\n` +
            sample + (health.missing_count > 5 ? '\n…' : '') +
            '\n\n是否扫描磁盘、按「同名同大小」把路径修回来？（能修回的保留原有向量和标签）\n（只改数据库路径，不动磁盘文件）'
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

