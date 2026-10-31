/* main-waveform.js —— MAIN WAVEFORM
 * 从 index.html 原样搬出的顶层声明（函数 / 箭头函数）。
 */
function drawMainWaveform() {
    const canvas = document.getElementById('mainWaveform');
    const waveContainer = document.getElementById('waveformContainer');
    
    // 没有音频时显示提示
    if (!currentSound) {
        rendererWaveform.setStatus('empty', '', { translate: key => i18n.t(key) });
        return;
    }

    if (currentSound.waveformLoading && !getSoundWaveform(currentSound)) {
        rendererWaveform.setStatus('loading', '', { translate: key => i18n.t(key) });
        return;
    }

    const waveformData = getSoundWaveform(currentSound);
    if (!waveformData) {
        rendererWaveform.setStatus('error', currentSound.waveformError || i18n.t('waveform.error'), { translate: key => i18n.t(key) });
        return;
    }
    
    // 有音频时显示 Canvas 波形
    if (canvas && waveContainer) {
        rendererWaveform.setStatus('ready', '', { translate: key => i18n.t(key) });
        const bgColor = getComputedStyle(document.documentElement).getPropertyValue('--bg-secondary').trim() || '#141414';
        const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#e5e5e5';
        const secondaryColor = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim() || '#a3a3a3';
        const progress = displayProgressRatio();
        rendererWaveform.renderMain(canvas, {
            fallbackWidth: waveContainer.offsetWidth || 1200,
            fallbackHeight: waveContainer.offsetHeight || 120,
            waveformData,
            backgroundColor: bgColor,
            activeColor: textColor,
            inactiveColor: secondaryColor,
            progress,
            zoomLevel: waveformZoomLevel,
            scrollOffset: waveformScrollOffset,
            selectionStart,
            selectionEnd,
            duration: currentSound.duration
        });
    }
    
    // 更新拖拽手柄位置（确保在缩放和滚动时严格跟随选区）
    if (selectionStart !== null && selectionEnd !== null && currentSound) {
        updateDragHandlePosition();
    }
}

function updateDragHandlePosition() {
    const dragHandle = document.getElementById('dragHandle');
    const waveContainer = document.getElementById('waveformContainer');
    
    if (!dragHandle || !waveContainer || !currentSound) return;
    
    const start = selectionStart;
    const end = selectionEnd;
    
    if (start === null || end === null || start >= end) {
        dragHandle.classList.add('hidden');
        dragHandle.setAttribute('draggable', 'false');
        return;
    }
    
    const containerWidth = waveContainer.offsetWidth;
    const actualWidth = containerWidth * waveformZoomLevel;
    const selStartX = (start / currentSound.duration) * actualWidth;
    const selEndX = (end / currentSound.duration) * actualWidth;
    
    // 可见区域边界 - 精确计算，严格绑定选区
    let visibleLeft = selStartX - waveformScrollOffset;
    let visibleRight = selEndX - waveformScrollOffset;
    
    // 边界裁剪 - 确保拖拽区域严格跟随选区
    visibleLeft = Math.max(0, Math.min(containerWidth, visibleLeft));
    visibleRight = Math.max(0, Math.min(containerWidth, visibleRight));
    
    // 确保选区边界顺序正确
    if (visibleLeft > visibleRight) {
        [visibleLeft, visibleRight] = [visibleRight, visibleLeft];
    }
    
    const handleWidth = Math.max(1, visibleRight - visibleLeft); // 最小1px，允许单线选区
    
    // 选区太小（小于5px）时直接隐藏拖拽手柄
    if (handleWidth < 5) {
        dragHandle.classList.add('hidden');
        dragHandle.setAttribute('draggable', 'false');
    } else {
        dragHandle.classList.remove('hidden');
        dragHandle.setAttribute('draggable', 'true');
        dragHandle.style.left = visibleLeft + 'px';
        dragHandle.style.width = handleWidth + 'px';
        dragHandle.style.right = 'auto';
        
        // 选区太窄时隐藏文字
        const dragHandleText = document.getElementById('dragHandleText');
        if (dragHandleText) {
            dragHandleText.style.display = handleWidth < 40 ? 'none' : 'inline';
        }
    }
}

