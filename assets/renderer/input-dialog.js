/* input-dialog.js —— 通用输入弹窗
 * 从 index.html 原样搬出的完整顶层函数。
 */
function showInputModal(title, placeholder, callback) {
    const modal = document.getElementById('inputModal');
    const titleEl = document.getElementById('inputModalTitle');
    const inputEl = document.getElementById('inputModalField');

    titleEl.textContent = title;
    inputEl.placeholder = placeholder;
    inputEl.value = '';
    inputModalCallback = callback;

    modal.classList.remove('hidden');
    modal.classList.add('flex');

    // 聚焦输入框
    setTimeout(() => inputEl.focus(), 100);
}

function hideInputModal() {
    const modal = document.getElementById('inputModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    inputModalCallback = null;
}

function confirmInputModal() {
    const inputEl = document.getElementById('inputModalField');
    const value = inputEl.value.trim();
    if (inputModalCallback) {
        inputModalCallback(value);
    }
    hideInputModal();
}

async function selectProjectTempDir() {
    try {
        let selectedPath = null;

        if (window.electronAPI && window.electronAPI.dialogs) {
            const result = await window.electronAPI.dialogs.showOpenDialog({
                properties: ['openDirectory'],
                title: '选择工程临时文件目录'
            });
            if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
                selectedPath = result.filePaths[0];
            }
        } else {
            // 浏览器环境使用 input
            const input = document.createElement('input');
            input.type = 'file';
            input.webkitdirectory = true;
            input.directory = true;
            input.addEventListener('change', (e) => {
                if (e.target.files && e.target.files.length > 0) {
                    const path = e.target.files[0].path || e.target.files[0].webkitRelativePath.split('/')[0];
                    document.getElementById('newProjectTempDir').value = path;
                }
            });
            input.click();
            return;
        }

        if (selectedPath) {
            document.getElementById('newProjectTempDir').value = selectedPath;
        }
    } catch (error) {
        console.error('选择目录失败:', error);
        showNotification('选择目录失败: ' + error.message, 'error');
    }
}

async function createNewProject() {
    const name = document.getElementById('newProjectName').value.trim();
    const description = document.getElementById('newProjectDesc').value.trim();
    const tempDir = document.getElementById('newProjectTempDir').value.trim();

    if (!name) {
        showNotification('请输入工程名称', 'error');
        return;
    }

    try {
        showNotification('正在创建工程...', 'info');

        const result = await rendererProjects.create({
            name,
            description,
            temp_dir: tempDir || null
        });

        if (result && result.success) {
            showNotification(`工程 "${name}" 创建成功`, 'success');
            hideNewProjectModal();

            // 切换到新创建的工程
            await switchProject(result.project_id, name);
        } else {
            showNotification('创建工程失败: ' + (result.detail || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('创建工程失败:', error);
        showNotification('创建工程失败: ' + error.message, 'error');
    }
}

async function showOpenProjectModal(showRecent = false) {
    const modal = document.getElementById('openProjectModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');

    // 加载工程列表
    await loadProjectList(showRecent);

    lucide.createIcons();
}

function hideOpenProjectModal() {
    const modal = document.getElementById('openProjectModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

async function loadProjectList(showRecent = false) {
    const container = document.getElementById('projectList');
    container.innerHTML = '<div class="text-center py-8 opacity-50"><i data-lucide="loader-2" class="w-8 h-8 mx-auto mb-2 animate-spin"></i><p class="text-sm">加载中...</p></div>';
    lucide.createIcons();

    try {
        const result = await rendererProjects.list(showRecent);

        if (result && result.projects && result.projects.length > 0) {
            container.innerHTML = '';
            result.projects.forEach(project => {
                const item = document.createElement('div');
                item.className = 'flex items-center justify-between p-3 rounded-md cursor-pointer transition-colors hover:bg-black/5 dark:hover:bg-white/5';
                if (project.id === currentProject.id) {
                    item.classList.add('bg-black/5', 'dark:bg-white/5');
                }

                const isDefault = project.id === 'default';
                const isCurrent = project.id === currentProject.id;

                item.innerHTML = `
                    <div class="flex items-center gap-3 flex-1">
                        <i data-lucide="folder" class="w-5 h-5 opacity-70"></i>
                        <div class="flex-1 min-w-0">
                            <div class="font-medium text-sm truncate">${escapeHtml(project.name)}</div>
                            <div class="text-xs opacity-60 truncate">${escapeHtml(project.description || '无描述')} · ${project.file_count || 0} 个文件</div>
                        </div>
                    </div>
                    <div class="flex items-center gap-2">
                        ${isCurrent ? '<span class="text-xs px-2 py-1 rounded-full bg-green-500/20 text-green-600 dark:text-green-400">当前</span>' : ''}
                        <button class="delete-project-btn p-1.5 rounded-md hover:bg-red-500/20 hover:text-red-500 transition-colors" data-project-id="${escapeHtml(project.id)}" data-project-name="${escapeHtml(project.name)}" title="删除工程">
                            <i data-lucide="trash-2" class="w-4 h-4"></i>
                        </button>
                    </div>
                `;

                // 点击工程项切换工程
                item.addEventListener('click', (e) => {
                    // 如果点击的是删除按钮，不触发切换
                    if (e.target.closest('.delete-project-btn')) {
                        return;
                    }
                    switchProject(project.id, project.name);
                    hideOpenProjectModal();
                });

                // 删除按钮事件
                const deleteBtn = item.querySelector('.delete-project-btn');
                if (deleteBtn) {
                    deleteBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const pid = deleteBtn.dataset.projectId;
                        const pname = deleteBtn.dataset.projectName;
                        deleteProject(pid, pname);
                    });
                }

                container.appendChild(item);
            });
            lucide.createIcons();
        } else {
            container.innerHTML = `
                <div class="text-center py-8 opacity-50">
                    <i data-lucide="folder-x" class="w-8 h-8 mx-auto mb-2"></i>
                    <p class="text-sm">${showRecent ? '暂无最近工程' : '暂无工程'}</p>
                </div>
            `;
            lucide.createIcons();
        }
    } catch (error) {
        console.error('加载工程列表失败:', error);
        container.innerHTML = `
            <div class="text-center py-8 opacity-50">
                <i data-lucide="alert-circle" class="w-8 h-8 mx-auto mb-2"></i>
                <p class="text-sm">加载失败: ${escapeHtml(error.message)}</p>
            </div>
        `;
        lucide.createIcons();
    }
}

async function deleteProject(projectId, projectName) {
    if (!confirm(`确定要删除工程 "${projectName}" 吗？\n\n此操作将：\n- 删除该工程的所有音频文件记录\n- 删除该工程的向量数据库\n- 此操作不可恢复`)) {
        return;
    }

    try {
        showNotification(`正在删除工程 "${projectName}"...`, 'info');

        const result = await rendererProjects.delete(projectId);
        showNotification(result.message || '工程已删除', 'success');

        // 如果删除的是当前工程，切换到默认工程
        if (projectId === currentProject.id) {
            await switchProject('default', '默认工程');
        }

        // 刷新工程列表
        await loadProjectList();
    } catch (error) {
        console.error('删除工程失败:', error);
        showNotification('删除工程失败: ' + error.message, 'error');
    }
}

async function switchProject(projectId, projectName, options = {}) {
    const { silent = false, persist = true } = options;
    try {
        if (!silent) {
            showNotification(`正在切换到工程 "${projectName}"...`, 'info');
        }

        const result = await rendererProjects.switch(projectId);

        if (result && result.success) {
            const resolvedProjectName = result.project_name || projectName;

            // 更新当前工程信息
            currentProject = appState.set('currentProject', {
                id: projectId,
                name: resolvedProjectName
            });
            rendererAudio.clearPlaybackSourceCache();

            // 更新UI显示
            document.getElementById('currentProjectName').textContent = resolvedProjectName;

            // 清空当前数据
            soundData = [];
            userFolders = [];
            importedFolderData = [];
            folderMappings = {};
            currentSound = null;
            isPlaying = false;
            playbackProgress = 0;
            selectionStart = null;
            selectionEnd = null;
            cancelActiveWaveformRequest();
            waveformLoadRequestId += 1;
            stopPlaybackAnimation();
            if (audioPlayer) {
                audioPlayer.pause();
                audioPlayer.removeAttribute('src');
                audioPlayer.load();
            }

            // 重新加载该工程的文件和文件夹
            await loadFilesFromDatabase();
            await loadUserFolders();

            // 刷新UI
            renderFolderTree();
            updateCategoryData();
            renderSoundList();
            updatePlaybackUI();
            drawMainWaveform();
            await refreshProjectIndexStatus();

            if (!silent) {
                showNotification(`已切换到工程 "${resolvedProjectName}"`, 'success');
            }

            // 保存到本地存储
            if (persist) {
                localStorage.setItem('soundmind_current_project', JSON.stringify(currentProject));
            }

            return true;
        } else {
            if (!silent) {
                showNotification('切换工程失败: ' + (result.detail || '未知错误'), 'error');
            }
            return false;
        }
    } catch (error) {
        console.error('切换工程失败:', error);
        if (!silent) {
            showNotification('切换工程失败: ' + error.message, 'error');
        }
        return false;
    }
}

async function loadCurrentProject() {
    // 尝试从本地存储加载
    const saved = localStorage.getItem('soundmind_current_project');
    if (saved) {
        try {
            const savedProject = JSON.parse(saved);
            // 验证工程是否存在
            const project = await rendererProjects.get(savedProject.id);
            const projectName = project.name || savedProject.name || '默认工程';
            const switched = await switchProject(savedProject.id, projectName, { silent: true });
            if (switched) {
                return true;
            }
        } catch (error) {
            console.error('加载保存的工程失败:', error);
        }
        localStorage.removeItem('soundmind_current_project');
    }

    // 默认使用 default 工程
    currentProject = appState.set('currentProject', { id: 'default', name: '默认工程' });
    document.getElementById('currentProjectName').textContent = currentProject.name;
    return false;
}

