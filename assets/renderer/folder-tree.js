/* folder-tree.js —— FOLDER TREE
 * 从 index.html 原样搬出的完整顶层函数。
 */
async function loadUserFolders() {
    try {
        const [result, mappingResult] = await Promise.all([
            rendererProjects.listFolders(currentProject.id),
            rendererProjects.listFolderMappings(currentProject.id)
        ]);
        userFolders = result?.folders || [];
        folderMappings = {};
        (mappingResult?.mappings || []).forEach(mapping => {
            folderMappings[mapping.folder_path] = mapping.user_folder_id;
        });
        console.log('[FOLDER] 加载用户文件夹:', userFolders);
        console.log('[FOLDER] 加载文件夹映射:', folderMappings);
    } catch (error) {
        console.error('[FOLDER] 加载用户文件夹失败:', error);
    }
}

async function createUserFolder(name, description = '', color = '#3b82f6') {
    try {
        const result = await rendererProjects.createFolder(
            currentProject.id,
            { name, description, color }
        );
        showNotification(result.message, 'success');
        await loadUserFolders();
        renderFolderTree();
        lucide.createIcons();
        return result.folder_id;
    } catch (error) {
        console.error('[FOLDER] 创建文件夹失败:', error);
        showNotification('创建文件夹失败: ' + error.message, 'error');
    }
}

async function deleteUserFolder(folderId) {
    try {
        const result = await rendererProjects.deleteFolder(currentProject.id, folderId);
        showNotification(result.message, 'success');
        await loadUserFolders();
        renderFolderTree();
        lucide.createIcons();
    } catch (error) {
        console.error('[FOLDER] 删除文件夹失败:', error);
        showNotification('删除文件夹失败: ' + error.message, 'error');
    }
}

async function updateFolderMapping(folderPath, userFolderId) {
    try {
        const result = await rendererProjects.updateFolderMapping(
            currentProject.id,
            folderPath,
            userFolderId
        );
        showNotification(result.message, 'success');
        folderMappings[folderPath] = userFolderId;
        await loadUserFolders();
        renderFolderTree();
    } catch (error) {
        console.error('[FOLDER] 更新分类失败:', error);
        showNotification('更新分类失败: ' + error.message, 'error');
    }
}

function filterFolderNodes(nodes, query) {
    if (!query) return nodes;
    const result = [];
    (nodes || []).forEach((node) => {
        const children = filterFolderNodes(node.children || [], query);
        const name = String(node.name || '').toLowerCase();
        if (name.includes(query) || children.length > 0) {
            result.push({ ...node, children });
        }
    });
    return result;
}

function scheduleSourceSearch() {
    if (sourceSearchTimer) clearTimeout(sourceSearchTimer);
    sourceSearchTimer = setTimeout(() => {
        sourceSearchTimer = null;
        const box = document.getElementById('sourceFolderSearchInput');
        if (!box) return;
        const caret = box.selectionStart;
        sourceFolderQuery = box.value;
        renderFolderTree();
        const again = document.getElementById('sourceFolderSearchInput');
        if (again) {
            again.focus();
            try { again.setSelectionRange(caret, caret); } catch (_) { }
        }
    }, 200);
}

function setSidebarView(view) {
    sidebarView = view;
    const fav = document.getElementById('favoriteRow');
    if (fav) fav.classList.toggle('active', view === 'favorites');
    const all = document.getElementById('allSoundsRow');
    if (all) all.classList.toggle('active', view === 'all');
}

function folderTreeNodes() {
    return [...document.querySelectorAll('#folderTree .sidebar-item[data-path]')];
}

function applyFolderMultiSelection() {
    folderTreeNodes().forEach(node => {
        node.classList.toggle('folder-multi-selected', folderMultiSelection.has(node.dataset.path));
    });
}

function toggleFolderMultiSelection(folder, event) {
    const nodes = folderTreeNodes();
    const path = folder.fullPath;
    if (event.shiftKey && folderSelectionAnchor) {
        const from = nodes.findIndex(node => node.dataset.path === folderSelectionAnchor);
        const to = nodes.findIndex(node => node.dataset.path === path);
        if (from >= 0 && to >= 0) {
            const start = Math.min(from, to);
            const end = Math.max(from, to);
            if (!event.ctrlKey && !event.metaKey) folderMultiSelection.clear();
            for (let i = start; i <= end; i += 1) folderMultiSelection.add(nodes[i].dataset.path);
        }
    } else if (event.ctrlKey || event.metaKey) {
        if (folderMultiSelection.has(path)) folderMultiSelection.delete(path);
        else folderMultiSelection.add(path);
        folderSelectionAnchor = path;
    } else {
        folderMultiSelection.clear();
        folderMultiSelection.add(path);
        folderSelectionAnchor = path;
    }
    applyFolderMultiSelection();
    if (folderMultiSelection.size > 1) {
        showNotification('已选中 ' + folderMultiSelection.size + ' 个文件夹，右键可批量删除', 'info');
    }
}

