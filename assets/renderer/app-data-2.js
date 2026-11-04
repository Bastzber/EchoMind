/* 从 app-data.js 拆出来的后半段：波形缩放按钮、设置弹窗、AI 描述、描述包快捷、
   窗口与托盘设置、关于与更新、左侧分隔条、标签搜索、拖拽导入。
   原本和前半段共用同一个 DOMContentLoaded 闭包，这里注册第二个监听器，
   按注册顺序照样排在前面那段之后执行。 */
document.addEventListener('DOMContentLoaded', () => {
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
                    // 新版只回 has_api_key 掩码（key 已进 DPAPI），旧版回的 apiKey 兼容保留
                    configured = Boolean(local.has_api_key ?? local.apiKey);
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


    // 原来这些名字和前半段在同一个闭包里，拆开之后闭包外看不见了。
    // 外部真正要用的只有两个（app-core 的播放结束回调、settings-modal 的窗口偏好），
    // 其余都在本闭包内部用，不用往外挂。
    window.handlePlaybackEnded = handlePlaybackEnded;
    window.loadWindowPrefs = loadWindowPrefs;
});