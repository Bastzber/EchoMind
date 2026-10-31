/* data-state.js —— DATA
 * 从 index.html 原样搬出的顶层声明（函数 / 箭头函数）。
 */
function releaseCurrentBlobUrl() {
    if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
        currentBlobUrl = null;
    }
}

function initializeWaveformResizeObserver() {
    const container = document.getElementById('waveformContainer');
    if (!container || waveformResizeObserver) return;
    waveformResizeObserver = rendererWaveform.observeResize(container, () => {
        drawMainWaveform();
        drawMiniWaveforms(lastRenderedSounds, { queueLoad: false });
    });
}

async function initializeRuntimeConfig() {
    try {
        if (!window.electronAPI || !window.electronAPI.runtime) return;
        const config = await window.electronAPI.runtime.getConfig();
        rendererApi.configure(config || {});
    } catch (error) {
        console.warn('[Frontend] 加载运行时配置失败，使用默认地址', error);
    }
}

async function checkBackendHealth() {
    try {
        if (window.electronAPI && window.electronAPI.backendStatus) {
            const result = await window.electronAPI.backendStatus.waitUntilReady(5000);
            return result && result.success;
        }
        const response = await rendererApi.fetch('/api/v1/health');
        return response.ok;
    } catch (error) {
        return false;
    }
}

async function ensureBackendReady() {
    if (backendReady) return true;

    try {
        // 首先尝试直接检查
        const isReady = await checkBackendHealth();
        if (isReady) {
            backendReady = true;
            onBackendReady();
            return true;
        }

        // 如果直接检查失败，开始轮询
        console.log('[Frontend] 后端未就绪，开始轮询检查...');
        
        return new Promise((resolve) => {
            backendCheckRetryCount = 0;
            
            backendStatusCheckInterval = setInterval(async () => {
                backendCheckRetryCount++;
                console.log(`[Frontend] 检查后端状态 (${backendCheckRetryCount}/${BACKEND_CHECK_MAX_RETRIES})...`);
                
                const isReady = await checkBackendHealth();
                
                if (isReady) {
                    clearInterval(backendStatusCheckInterval);
                    backendStatusCheckInterval = null;
                    backendReady = true;
                    console.log('[Frontend] 后端已就绪！');
                    onBackendReady();
                    resolve(true);
                } else if (backendCheckRetryCount >= BACKEND_CHECK_MAX_RETRIES) {
                    clearInterval(backendStatusCheckInterval);
                    backendStatusCheckInterval = null;
                    console.error('[Frontend] 后端启动超时');
                    showNotification('后端启动超时，请重启应用', 'error');
                    resolve(false);
                }
            }, BACKEND_CHECK_INTERVAL);
        });
    } catch (error) {
        console.error('[Frontend] 后端启动失败:', error);
        showNotification('后端启动失败: ' + error.message, 'error');
        return false;
    }
}

function onBackendReady() {
    if (backendReadyHandled) return;
    backendReadyHandled = true;

    console.log('[Frontend] 执行后端就绪回调...');
    
    // 更新磁盘空间显示
    updateDiskSpaceDisplay();
    
    // 显示成功通知
    showNotification('服务已就绪', 'success');
}

function updateCategoryData() {
    const allCount = soundData.length;
    const categories = {};
    
    soundData.forEach(sound => {
        const cat = sound.category || '其他';
        categories[cat] = (categories[cat] || 0) + 1;
    });

    categoryData = [
        { id: 'tag-all', name: '全部', count: allCount }
    ];
    
    Object.keys(categories).forEach(cat => {
        categoryData.push({ 
            id: 'tag-' + cat, 
            name: cat, 
            count: categories[cat] 
        });
    });
    
    renderCategoryTree();
}

