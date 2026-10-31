/* source-tree.js —— 源目录板块（全部音效 + 库目录树）
 * 从 index.html 原样搬出的完整顶层函数，全局语义不变。
 */
function toggleFolderExpand(folderId, element) {
    const currentState = folderExpandedState.get(folderId) !== false;
    const newState = !currentState;
    folderExpandedState.set(folderId, newState);

    console.log('[FOLDER] 切换展开状态:', folderId, currentState, '->', newState);

    // 只更新这个文件夹的UI
    const toggleIcon = element.querySelector('.folder-toggle');
    const childrenContainer = element.querySelector('.folder-children');

    if (toggleIcon) {
        // 旋转图标
        const svg = toggleIcon.querySelector('svg');
        if (svg) {
            if (newState) {
                svg.classList.add('rotate-90');
            } else {
                svg.classList.remove('rotate-90');
            }
        }
    }

    if (childrenContainer) {
        childrenContainer.style.display = newState ? 'block' : 'none';
        console.log('[FOLDER] 子容器显示状态:', childrenContainer.style.display);
    } else {
        console.warn('[FOLDER] 未找到子容器:', folderId);
    }
}

async function renameUserFolder(folderId, newName) {
    try {
        const result = await rendererProjects.updateFolder(currentProject.id, folderId, { name: newName });
        showNotification(result.message, 'success');
        await loadUserFolders();
        renderFolderTree();
        lucide.createIcons();
    } catch (error) {
        console.error('[FOLDER] 重命名文件夹失败:', error);
        showNotification('重命名文件夹失败: ' + error.message, 'error');
    }
}

function createUserFolderItem(folder) {
    const div = document.createElement('div');
    div.className = 'sidebar-item rounded-md cursor-pointer mb-1';
    div.dataset.id = folder.id;
    div.dataset.userFolderId = folder.id;
    div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showFolderContextMenu(e, folder, 'user');
    });
    // 接收从左侧目录树拖过来的文件夹
    div.addEventListener('dragover', (e) => {
        const types = Array.from(e.dataTransfer?.types || []);
        if (!types.includes('application/x-echomind-folder')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        div.style.outline = '2px solid #3b82f6';
        div.style.outlineOffset = '-2px';
    });
    div.addEventListener('dragleave', () => { div.style.outline = ''; });
    div.addEventListener('drop', async (e) => {
        const srcPath = e.dataTransfer?.getData('application/x-echomind-folder');
        div.style.outline = '';
        if (!srcPath) return;
        e.preventDefault();
        e.stopPropagation();
        const leaf = srcPath.split('\\').filter(Boolean).pop() || srcPath;
        if (!confirm(`把「${leaf}」及其子目录移动到「${folder.name}」？`)) return;
        await updateFolderMapping(srcPath, folder.id);
    });

    // 获取该文件夹下的导入文件夹
    const childFolders = importedFolderData.filter(f => folderMappings[f.fullPath] === folder.id);
    const hasChildren = childFolders.length > 0;
    // 从缓存获取展开状态，默认展开
    const expanded = folderExpandedState.get(folder.id) !== false;

    const folderColor = folder.color || '#3b82f6';

    // 所有用户文件夹都显示展开按钮（即使没有子项，也可以展开后显示空状态）
    div.innerHTML = `
        <div class="flex items-center gap-2 py-2 px-2 rounded-md hover:bg-white/5 group folder-header">
            <span class="folder-toggle w-4 h-4 flex items-center justify-center cursor-pointer hover:bg-white/10 rounded transition-transform duration-200">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="transition-transform duration-200 ${expanded ? 'rotate-90' : ''}"><polyline points="9 18 15 12 9 6"></polyline></svg>
            </span>
            <i data-lucide="folder" class="w-4 h-4 opacity-70" style="color: ${folderColor};"></i>
            <span class="text-sm flex-1 truncate">${escapeHtml(folder.name)}</span>
            <span class="text-xs opacity-50" data-folder-count="${folder.id}">${folder.total_file_count || 0}</span>
        </div>
    `;

    // 手动加入的文件也算进数量
    (async () => {
        try {
            const data = await rendererApi.get(
                `/api/v1/projects/${encodeURIComponent(currentProject?.id || 'default')}`
                + `/folders/${encodeURIComponent(folder.id)}/files`
            );
            const extra = ((data && data.files) || []).length;
            const badge = div.querySelector('[data-folder-count]');
            if (badge) badge.textContent = String((Number(folder.total_file_count) || 0) + extra);
        } catch (_) { }
    })();

    // 展开/折叠
    const toggleBtn = div.querySelector('.folder-toggle');
    toggleBtn.style.cursor = 'pointer';
    toggleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        console.log('[FOLDER] 点击展开按钮:', folder.id);
        toggleFolderExpand(folder.id, div);
    });

    // 点击文件夹筛选
    div.querySelector('.folder-header').addEventListener('click', async (e) => {
        // 如果点击的是展开按钮，不执行筛选
        if (e.target.closest('.folder-toggle')) return;

        document.querySelectorAll('#folderTree .sidebar-item').forEach(item => item.classList.remove('active'));
        div.classList.add('active');
        await openUserFolder(folder, childFolders);
    });

    // 右键菜单
    div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showFolderContextMenu(e, folder, 'user', { childFolders });
    });

    // 渲染子文件夹和音频文件（始终创建容器，但控制显示/隐藏）
    const childrenContainer = document.createElement('div');
    childrenContainer.className = 'folder-children';
    childrenContainer.style.marginLeft = '0px';
    childrenContainer.style.display = expanded ? 'block' : 'none';

    // 渲染子文件夹
    if (hasChildren) {
        childFolders.forEach(child => {
            childrenContainer.appendChild(createImportedFolderItem(child, 1, false));
        });
    }

    div.appendChild(childrenContainer);

    return div;
}

async function openUserFolder(folder, childFolders, options = {}) {
    const projectId = currentProject?.id || 'default';
    const seen = new Set();
    const list = [];
    const pushAll = (files) => {
        (files || []).forEach((file, index) => {
            try {
                const mappedSound = mapDbFileToSound(
                    Object.assign({}, file, { path: file.path || file.file_path }),
                    index
                );
                if (!mappedSound.filePath || seen.has(mappedSound.filePath)) return;
                seen.add(mappedSound.filePath);
                list.push(mappedSound);
            } catch (error) {
                console.warn('[Folder] 成员映射失败:', error);
            }
        });
    };

    for (const child of (childFolders || [])) {
        try {
            const page = await rendererApi.get(
                '/api/v1/files?project_id=' + encodeURIComponent(projectId)
                + '&limit=300&folder=' + encodeURIComponent(child.path)
            );
            pushAll(page && page.files);
        } catch (error) {
            console.warn('[Folder] 读取映射目录失败:', error);
        }
    }
    try {
        const data = await rendererApi.get(
            '/api/v1/projects/' + encodeURIComponent(projectId)
            + '/folders/' + encodeURIComponent(folder.id) + '/files'
        );
        pushAll(data && data.files);
    } catch (error) {
        console.warn('[Folder] 读取文件夹成员失败:', error);
    }

    allSearchResults = list;
    setSidebarView(null);
    activeUserFolder = {
        id: folder.id,
        name: folder.name,
        childFolders: childFolders || [],
        sounds: list
    };
    renderSoundList('', list);
    if (options.notify !== false) {
        showNotification('「' + folder.name + '」共 ' + list.length + ' 个音效', list.length ? 'success' : 'info');
    }
    return list;
}

async function removeSoundsFromUserFolder(folder, sounds) {
    const projectId = currentProject?.id || 'default';
    const targets = (sounds || []).filter((sound) => sound && sound.id);
    if (!targets.length) return;

    let removed = 0;
    let failed = 0;
    for (const sound of targets) {
        try {
            await rendererApi.delete(
                '/api/v1/projects/' + encodeURIComponent(projectId)
                + '/folders/' + encodeURIComponent(folder.id)
                + '/files/' + encodeURIComponent(sound.id)
            );
            removed += 1;
        } catch (error) {
            failed += 1;
        }
    }

    // 刷新这个文件夹的列表；顺带看看有没有「移不掉」的（来自目录映射，不是手动加入的）
    let stillThere = 0;
    if (activeUserFolder && activeUserFolder.id === folder.id) {
        const list = await openUserFolder(folder, activeUserFolder.childFolders, { notify: false });
        const kept = new Set((list || []).map((sound) => String(sound.id)));
        stillThere = targets.filter((sound) => kept.has(String(sound.id))).length;
    }
    await loadUserFolders();
    renderFolderTree();

    let message = '已从「' + folder.name + '」移出 ' + removed + ' 个';
    if (failed) message += '，' + failed + ' 个失败';
    if (stillThere) message += '；还有 ' + stillThere + ' 个来自目录映射，需先在文件夹右键里解除映射';
    showNotification(message, failed ? 'error' : (stillThere ? 'info' : 'success'));
}

function showFolderContextMenu(event, folder, type, extra = {}) {
    // 关闭已存在的菜单
    const existingMenu = document.getElementById('folderContextMenu');
    if (existingMenu) {
        existingMenu.remove();
    }

    const menu = document.createElement('div');
    menu.id = 'folderContextMenu';
    menu.className = 'fixed z-[200] rounded-lg shadow-xl py-1 w-48';
    menu.style.backgroundColor = 'var(--bg-secondary)';
    menu.style.border = '1px solid var(--border-color)';
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;

    const menuItems = [];

    if (type === 'user') {
        // 用户文件夹菜单
        menuItems.push(
            { label: '批量重命名此文件夹…', icon: 'files', action: () => renameSoundsInUserFolder(folder, extra.childFolders) },
            { label: i18n.t('folder.new.sibling'), icon: 'folder-plus', action: () => showInputModal(i18n.t('folder.new.title'), i18n.t('folder.new.placeholder'), (name) => { if (name) createUserFolder(name); }) },
            { label: i18n.t('folder.rename'), icon: 'edit-3', action: () => showInputModal(i18n.t('folder.rename.title'), i18n.t('folder.rename.placeholder'), (name) => { if (name) renameUserFolder(folder.id, name); }, folder.name) },
            { label: i18n.t('delete'), icon: 'trash-2', action: () => { if (confirm(i18n.t('confirm.delete.folder', { name: folder.name }))) deleteUserFolder(folder.id); }, danger: true }
        );
    } else if (type === 'imported') {
        // 导入文件夹菜单
        menuItems.push(
            { label: '批量重命名此文件夹…', icon: 'files', action: () => renameSoundsInFolder(folder.fullPath) },
            { label: i18n.t('folder.move.to'), icon: 'folder-input', action: () => showMoveToFolderMenu(event, folder) }
        );
        const selectedPaths = [...folderMultiSelection];
        const inSelection = selectedPaths.includes(folder.fullPath);
        if (inSelection && selectedPaths.length > 1) {
            const targets = selectedPaths
                .map(path => folderNodeRegistry.get(path) || { fullPath: path, path, name: String(path).split(/[\\/]/).pop() });
            menuItems.push({
                label: '批量删除这 ' + selectedPaths.length + ' 个文件夹…',
                icon: 'trash-2',
                danger: true,
                action: () => openFolderBatchDeleteModal(targets)
            });
        } else {
            menuItems.push({
                label: '删除文件夹…',
                icon: 'trash-2',
                danger: true,
                action: () => openFolderDeleteModal(folder)
            });
        }
    }

    menu.innerHTML = menuItems.map(item => `
        <button class="w-full px-3 py-2 text-sm text-left hover:bg-white/5 flex items-center gap-2 transition-colors ${item.danger ? 'text-red-400 hover:text-red-300' : ''}">
            <i data-lucide="${item.icon}" class="w-4 h-4"></i>
            <span>${item.label}</span>
        </button>
    `).join('');

    // 绑定点击事件
    const buttons = menu.querySelectorAll('button');
    buttons.forEach((btn, index) => {
        btn.addEventListener('click', () => {
            menuItems[index].action();
            menu.remove();
        });
    });

    // 点击其他地方关闭菜单
    const closeMenu = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener('click', closeMenu);
        }
    };

    document.body.appendChild(menu);
    lucide.createIcons();

    setTimeout(() => {
        document.addEventListener('click', closeMenu);
    }, 100);
}

function createImportedFolderItem(folder, level, isUnclassified, forceExpand = false) {
    const div = document.createElement('div');
    div.className = 'sidebar-item rounded-md cursor-pointer';
    div.style.paddingLeft = `${level * 8 + 4}px`;
    div.dataset.path = folder.fullPath;
    folderNodeRegistry.set(folder.fullPath, folder);
    // 右键：从库中移除 / 删除源文件
    div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showFolderContextMenu(e, folder, 'imported');
    });
    // 拖动文件夹 → 放到「我的文件夹」上完成归类
    div.draggable = true;
    div.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-echomind-folder', folder.fullPath);
        e.dataTransfer.effectAllowed = 'move';
        div.style.opacity = '0.45';
    });
    div.addEventListener('dragend', () => { div.style.opacity = ''; });

    // 获取该文件夹下的音频文件
    const folderFiles = soundData.filter(s => s.folderPath === folder.path);
    const hasFiles = folderFiles.length > 0;

    // 递归获取所有子文件夹
    function getAllChildren(node) {
        let children = [];
        if (node.children && node.children.length > 0) {
            node.children.forEach(child => {
                children.push(child);
                children = children.concat(getAllChildren(child));
            });
        }
        return children;
    }

    const allChildren = getAllChildren(folder);
    const hasChildren = folder.children && folder.children.length > 0;
    // 从缓存获取展开状态；库很大时默认折叠，避免一次渲染上万个节点
    // 库根默认展开，用户一眼能看到原始的分类目录（CJ音效库 / z秋拾…）
    const defaultExpanded = soundData.length <= 2000 || level === 0;
    const expanded = forceExpand
        ? true
        : (folderExpandedState.has(folder.fullPath)
            ? folderExpandedState.get(folder.fullPath) !== false
            : defaultExpanded);
    const hasContent = hasChildren || hasFiles || allChildren.length > 0;

    div.innerHTML = `
        <div class="flex items-center gap-1 py-0.5 px-1 rounded-md hover:bg-white/5 folder-header">
            ${hasChildren ? `<span class="folder-toggle w-2.5 h-2.5 flex items-center justify-center cursor-pointer hover:bg-white/10 rounded transition-transform duration-200">
                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="transition-transform duration-200 ${expanded ? 'rotate-90' : ''}"><polyline points="9 18 15 12 9 6"></polyline></svg>
            </span>` : '<span class="w-2.5 h-2.5 inline-block shrink-0"></span>'}
            <i data-lucide="folder-open" class="w-3 h-3 opacity-60"></i>
            <span class="text-xs flex-1 truncate">${escapeHtml(folder.name)}</span>
            ${folder.count !== undefined ? `<span class="text-[10px] opacity-40">${folder.count}</span>` : ''}
        </div>
    `;

    // 展开/折叠
    const toggleBtn = div.querySelector('.folder-toggle');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFolderExpand(folder.fullPath, div);
        });
    }

    // 点击筛选
    div.querySelector('.folder-header').addEventListener('click', (e) => {
        // 如果点击的是展开按钮，不执行筛选
        if (e.target.closest('.folder-toggle')) return;

        // Shift 连选 / Ctrl 点选：只做多选，不切筛选
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
            e.preventDefault();
            toggleFolderMultiSelection(folder, e);
            return;
        }

        folderMultiSelection.clear();
        applyFolderMultiSelection();
        folderSelectionAnchor = folder.fullPath;
        document.querySelectorAll('#folderTree .sidebar-item').forEach(item => item.classList.remove('active'));
        div.classList.add('active');

        // 目录内容从后端按路径前缀拉取（本地分页数据不全，直接过滤会空白）
        renderFolderFiles(folder.path);
    });

    // 右键菜单
    div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showFolderContextMenu(e, folder, isUnclassified ? 'imported' : 'imported-child');
    });

    // 渲染子文件夹和音频文件
    const childrenContainer = document.createElement('div');
    childrenContainer.className = 'folder-children';
    childrenContainer.style.marginLeft = '0px';
    childrenContainer.style.display = expanded ? 'block' : 'none';

    // 渲染子文件夹（递归）
    if (hasChildren) {
        folder.children.forEach(child => {
            childrenContainer.appendChild(createImportedFolderItem(child, level + 1, false));
        });
    }

    // 渲染音频文件
    if (hasFiles) {
        folderFiles.forEach(file => {
            const fileDiv = document.createElement('div');
            fileDiv.className = 'sidebar-item rounded-md cursor-pointer';
            fileDiv.style.paddingLeft = `${(level + 1) * 8 + 4}px`;
            fileDiv.innerHTML = `
                <div class="flex items-center gap-1 py-0.5 px-1 rounded-md hover:bg-white/5">
                    <i data-lucide="music" class="w-3 h-3 opacity-40"></i>
                    <span class="text-[10px] flex-1 truncate opacity-70">${escapeHtml(file.filename)}</span>
                </div>
            `;
            fileDiv.addEventListener('click', (e) => {
                e.stopPropagation();
                playSound(file.id);
            });
            childrenContainer.appendChild(fileDiv);
        });
    }

    if (childrenContainer.children.length > 0) {
        div.appendChild(childrenContainer);
    }

    return div;
}

function showMoveToFolderMenu(event, folder) {
    if (userFolders.length === 0) {
        showNotification('请先创建文件夹', 'info');
        return;
    }

    // 创建右键菜单
    const menu = document.createElement('div');
    menu.id = 'contextMenu';
    menu.className = 'fixed z-[200] rounded-lg shadow-xl border py-1 w-48';
    menu.style.backgroundColor = 'var(--bg-secondary)';
    menu.style.borderColor = 'var(--border-color)';
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;

    // 菜单标题
    menu.innerHTML = `
        <div class="px-3 py-2 text-xs font-medium opacity-60 border-b" style="border-color: var(--border-color);">
            移动到文件夹
        </div>
    `;

    // 添加文件夹选项
    userFolders.forEach(f => {
        const item = document.createElement('button');
        item.className = 'w-full px-3 py-2 text-sm text-left hover:bg-white/5 flex items-center gap-2 transition-colors';
        item.innerHTML = `
            <div class="w-3 h-3 rounded-full" style="background-color: ${f.color || '#3b82f6'};"></div>
            <span class="truncate">${escapeHtml(f.name)}</span>
        `;
        item.addEventListener('click', () => {
            updateFolderMapping(folder.fullPath, f.id);
            document.body.removeChild(menu);
        });
        menu.appendChild(item);
    });

    // 点击其他地方关闭菜单
    const closeMenu = (e) => {
        if (!menu.contains(e.target)) {
            if (menu.parentNode) {
                document.body.removeChild(menu);
            }
            document.removeEventListener('click', closeMenu);
        }
    };

    // 延迟绑定点击事件，避免立即触发
    setTimeout(() => {
        document.addEventListener('click', closeMenu);
    }, 100);

    document.body.appendChild(menu);
}

function reportUiError(label, error) {
    const message = (error && (error.stack || error.message)) || String(error);
    console.error('[UI]', label, message);
    try {
        let box = document.getElementById('uiErrorBox');
        if (!box) {
            box = document.createElement('div');
            box.id = 'uiErrorBox';
            box.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:9999;max-width:60vw;'
                + 'background:#7f1d1d;color:#fff;padding:10px 12px;border-radius:8px;font-size:12px;'
                + 'white-space:pre-wrap;opacity:.95;';
            document.body.appendChild(box);
        }
        box.textContent = label + '：' + message.slice(0, 600);
    } catch (_) { }
}

