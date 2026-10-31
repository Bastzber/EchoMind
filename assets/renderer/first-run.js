/* first-run.js —— 首次启动设置弹窗
 * 从 index.html 原样搬出的完整顶层函数。
 */
async function showFirstTimeSetupModal() {
    const modal = document.getElementById('firstTimeSetupModal');
    const pathDisplay = document.getElementById('firstTimeTempDirPath');
    const confirmBtn = document.getElementById('firstTimeConfirmBtn');
    
    // 重置状态
    firstTimeSelectedPath = null;
    pathDisplay.textContent = '未选择';
    confirmBtn.disabled = true;
    confirmBtn.classList.add('opacity-50', 'cursor-not-allowed');
    
    // 显示弹窗
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    
    // 初始化图标
    lucide.createIcons();
}

function hideFirstTimeSetupModal() {
    const modal = document.getElementById('firstTimeSetupModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

async function firstTimeSelectDir() {
    try {
        if (window.electronAPI && window.electronAPI.dialogs) {
            const result = await window.electronAPI.dialogs.showOpenDialog({
                properties: ['openDirectory'],
                title: '选择临时文件存放目录',
                buttonLabel: '选择此文件夹'
            });
            
            if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
                firstTimeSelectedPath = result.filePaths[0];
                
                // 更新显示
                const pathDisplay = document.getElementById('firstTimeTempDirPath');
                pathDisplay.textContent = firstTimeSelectedPath;
                pathDisplay.title = firstTimeSelectedPath;
                
                // 启用确认按钮
                const confirmBtn = document.getElementById('firstTimeConfirmBtn');
                confirmBtn.disabled = false;
                confirmBtn.classList.remove('opacity-50', 'cursor-not-allowed');
            }
        } else {
            showNotification('对话框功能不可用', 'error');
        }
    } catch (error) {
        console.error('选择目录失败:', error);
        showNotification('选择目录失败: ' + error.message, 'error');
    }
}

async function firstTimeUseDefault() {
    try {
        if (window.electronAPI && window.electronAPI.backendAPI) {
            // 获取默认路径
            const result = await window.electronAPI.backendAPI.getTempDir();
            const defaultPath = result.default_dir || '/tmp/soundmind';
            
            // 保存默认路径
            const saveResult = await window.electronAPI.backendAPI.setTempDir(defaultPath);
            if (saveResult && (saveResult.success !== false)) {
                // 标记设置完成
                localStorage.setItem('soundmind_setup_completed', 'true');
                showNotification(`已使用默认路径: ${defaultPath}`, 'success');
                hideFirstTimeSetupModal();
            } else {
                showNotification('设置默认路径失败', 'error');
            }
        } else {
            hideFirstTimeSetupModal();
        }
    } catch (error) {
        console.error('设置默认路径失败:', error);
        showNotification('设置默认路径失败: ' + error.message, 'error');
    }
}

async function firstTimeConfirm() {
    if (!firstTimeSelectedPath) return;
    
    try {
        if (window.electronAPI && window.electronAPI.backendAPI) {
            const saveResult = await window.electronAPI.backendAPI.setTempDir(firstTimeSelectedPath);
            if (saveResult && (saveResult.success !== false)) {
                // 标记设置完成
                localStorage.setItem('soundmind_setup_completed', 'true');
                showNotification(`临时文件目录已设置为: ${firstTimeSelectedPath}`, 'success');
                hideFirstTimeSetupModal();
            } else {
                showNotification('设置临时文件目录失败: ' + (saveResult.detail || saveResult.error || '未知错误'), 'error');
            }
        } else {
            hideFirstTimeSetupModal();
        }
    } catch (error) {
        console.error('确认设置失败:', error);
        showNotification('确认设置失败: ' + error.message, 'error');
    }
}

async function checkFirstTimeSetup() {
    try {
        // 检查本地存储标记
        const hasCompletedSetup = localStorage.getItem('soundmind_setup_completed');
        if (hasCompletedSetup === 'true') {
            return; // 已完成设置，不显示弹窗
        }
        
        // 检查后端是否已有配置
        if (window.electronAPI && window.electronAPI.backendAPI) {
            const result = await window.electronAPI.backendAPI.getTempDir();
            // 如果当前使用的是默认路径，且配置文件不存在，则认为是首次使用
            const configPath = '~/.soundmind/config.json';
            
            // 简单判断：如果临时目录是默认路径，显示弹窗让用户确认
            if (result.temp_dir === result.default_dir || result.temp_dir === '/tmp/soundmind') {
                // 延迟一点显示，等页面完全加载
                setTimeout(() => {
                    showFirstTimeSetupModal();
                }, 500);
            } else {
                // 已有自定义配置，标记为已完成
                localStorage.setItem('soundmind_setup_completed', 'true');
            }
        }
    } catch (error) {
        console.error('检查首次设置失败:', error);
        // 出错时也显示弹窗
        setTimeout(() => {
            showFirstTimeSetupModal();
        }, 500);
    }
}

function toggleTheme() {
    const isDark = document.documentElement.classList.toggle('dark');
    drawMiniWaveforms();
    drawMainWaveform();
    
    // 更新主题切换按钮的图标和文字
    // 当前浅色模式 -> 显示月亮（可切换到深色）
    // 当前深色模式 -> 显示太阳（可切换到浅色）
    const sunIcon = document.getElementById('themeIconSun');
    const moonIcon = document.getElementById('themeIconMoon');
    const lightText = document.getElementById('themeTextLight');
    const darkText = document.getElementById('themeTextDark');
    
    if (isDark) {
        // 切换到深色模式：显示太阳（可切换回浅色）
        moonIcon.classList.add('hidden');
        sunIcon.classList.remove('hidden');
        lightText.classList.add('hidden');
        darkText.classList.remove('hidden');
    } else {
        // 切换到浅色模式：显示月亮（可切换到深色）
        sunIcon.classList.add('hidden');
        moonIcon.classList.remove('hidden');
        lightText.classList.remove('hidden');
        darkText.classList.add('hidden');
    }
}

function updateSetting(type, value, { notify = true } = {}) {
    document.querySelectorAll(`.setting-option[data-type="${type}"]`).forEach(btn => {
        const isSelected = btn.dataset.value === value;
        btn.classList.toggle('opacity-50', !isSelected);
        btn.querySelector('.check-icon').classList.toggle('hidden', !isSelected);
    });
    
    // 处理语言切换（启动时静默，用户手动切换才提示）
    if (type === 'lang') {
        i18n.setLang(value);
        if (notify) showNotification(value === 'zh' ? '已切换到中文' : 'Switched to English', 'success');
    }
}

