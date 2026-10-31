/* ai-chat.js —— AI CHAT
 * 从 index.html 原样搬出的完整顶层函数。
 */
function addChatMessage(html, isUser = false) {
    const container = document.getElementById('chatMessages');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'chat-message';

    if (isUser) {
        // 用户消息靠右
        messageDiv.innerHTML = `
            <div class="flex items-start gap-2 justify-end">
                <div class="flex-1 text-right">
                    <div class="rounded-2xl rounded-tr-sm px-3 py-2 text-xs inline-block" style="background-color: #3b82f6; color: white;">
                        ${escapeHtml(html)}
                    </div>
                </div>
                <div class="w-6 h-6 rounded-full border flex items-center justify-center shrink-0" style="border-color: var(--border-color);">
                    <i data-lucide="user" class="w-3.5 h-3.5"></i>
                </div>
            </div>
        `;
    } else {
        // AI 消息靠左
        messageDiv.innerHTML = `
            <div class="flex items-start gap-2">
                <div class="w-6 h-6 rounded-full border flex items-center justify-center shrink-0" style="border-color: var(--border-color);">
                    <i data-lucide="bot" class="w-3.5 h-3.5"></i>
                </div>
                <div class="flex-1">
                    <div class="rounded-2xl rounded-tl-sm px-3 py-2 text-xs" style="background-color: var(--bg-tertiary);">
                        ${escapeHtml(html)}
                    </div>
                </div>
            </div>
        `;
    }

    container.appendChild(messageDiv);
    container.scrollTop = container.scrollHeight;
    lucide.createIcons();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function addLoadingMessage() {
    const container = document.getElementById('chatMessages');
    const messageDiv = document.createElement('div');
    messageDiv.id = 'aiLoadingMessage';
    messageDiv.className = 'chat-message';
    messageDiv.innerHTML = `
        <div class="flex items-start gap-2">
            <div class="w-6 h-6 rounded-full border flex items-center justify-center shrink-0" style="border-color: var(--border-color);">
                <i data-lucide="bot" class="w-3.5 h-3.5"></i>
            </div>
            <div class="flex-1">
                <div class="rounded-2xl rounded-tl-sm px-3 py-2 text-xs" style="background-color: var(--bg-tertiary);">
                    <div class="flex items-center gap-2">
                        <div class="w-3.5 h-3.5 rounded-full border-2 border-t-transparent animate-spin" style="border-color: var(--text-secondary); border-top-color: transparent;"></div>
                        <span id="aiLoadingText" data-i18n="ai.search.loading">正在思考...</span>
                    </div>
                </div>
            </div>
        </div>
    `;
    container.appendChild(messageDiv);
    container.scrollTop = container.scrollHeight;
    lucide.createIcons();
}

function updateLoadingMessage(text) {
    const loadingText = document.getElementById('aiLoadingText');
    if (loadingText) {
        loadingText.textContent = text;
    }
}

function removeLoadingMessage() {
    const loadingMessage = document.getElementById('aiLoadingMessage');
    if (loadingMessage) {
        loadingMessage.remove();
    }
}

async function handleChatMessage(text) {
    if (isAiResponding) return;

    // 添加用户消息
    addChatMessage(text, true);
    chatHistory.push({ role: 'user', content: text });

    // 显示加载状态
    addLoadingMessage();
    isAiResponding = true;

    try {
        const response = await rendererApi.fetch('/api/v1/ai/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(rendererSearch.buildChatPayload({
                message: text,
                projectId: currentProject?.id,
                history: chatHistory,
                topK: 50000,
                threshold: 0.15
            }))
        });

        if (!response.ok) {
            throw new Error('请求失败');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';
        let sseBuffer = '';

        removeLoadingMessage();

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                sseBuffer += decoder.decode();
            } else {
                sseBuffer += decoder.decode(value, { stream: true });
            }
            const lines = sseBuffer.split('\n');
            sseBuffer = done ? '' : (lines.pop() || '');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]' || data === '{"type": "done"}') continue;

                    try {
                        const event = JSON.parse(data);
                        if (event.type === 'chat' && event.content) {
                            fullContent += event.content;
                        } else if (event.type === 'results' && event.summary) {
                            fullContent += event.summary;
                        }
                        await processAiEvent(event);
                    } catch (e) {
                        // 忽略解析错误
                    }
                }
            }
            if (done) break;
        }

        // 添加 AI 回复到历史
        if (fullContent) {
            chatHistory.push({ role: 'assistant', content: fullContent });
        }

    } catch (error) {
        console.error('AI Chat 错误:', error);
        removeLoadingMessage();
        
        // 提供更友好的错误信息
        let errorMsg = '抱歉，AI 服务暂时不可用。';
        if (error.message && error.message.includes('fetch')) {
            errorMsg += '请检查后端服务是否已启动（端口 8000）。';
        } else if (error.message) {
            errorMsg += `错误信息：${error.message}`;
        } else {
            errorMsg += '请检查 AI 服务配置是否正确。';
        }
        
        addChatMessage(errorMsg);
    } finally {
        isAiResponding = false;
    }
}

async function processAiEvent(event) {
    switch (event.type) {
        case 'thinking':
            updateLoadingMessage(event.content);
            break;

        case 'analyzing':
            updateLoadingMessage(event.content || '分析中...');
            break;

        case 'searching':
            updateLoadingMessage(event.content || '搜索中...');
            break;

        case 'chat':
            // 对话模式 - 直接显示回复
            removeLoadingMessage();
            addChatMessage(event.content);
            break;

        case 'results':
            // 显示摘要
            if (event.summary) {
                addChatMessage(event.summary);
            }

            // 更新主音效列表
            if (event.results && event.results.length > 0) {
                displayAiSearchResults(event.results);
            } else {
                addChatMessage('没有找到匹配的音效。试试其他描述？');
            }
            break;

        case 'error':
            addChatMessage(`错误: ${event.content}`);
            break;
    }
}

async function hydrateResultMeta(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const ids = [...new Set(list.map((row) => row && row.fileId).filter(Boolean))];
    if (!ids.length) return false;
    try {
        const res = await rendererApi.post('/api/v1/files/meta', { ids }, { timeoutMs: 60000 });
        const items = res?.items || [];
        if (!items.length) return false;
        const byId = new Map(items.map((item) => [String(item.id), item]));
        let changed = false;
        list.forEach((row) => {
            const meta = byId.get(String(row.fileId));
            if (!meta) return;
            if (meta.ai_description && meta.ai_description !== row.aiDescription) {
                row.aiDescription = meta.ai_description;
                changed = true;
            }
            if (Array.isArray(meta.tags) && meta.tags.length) {
                row.tags = meta.tags;
                changed = true;
            }
        });
        return changed;
    } catch (error) {
        console.warn('[Search] 补描述/标签失败:', error);
        return false;
    }
}

function displayAiSearchResults(results) {
    // 将 AI 搜索结果转换为 soundData 格式并显示
    const container = document.getElementById('soundList');
    
    // 清空现有内容
    container.innerHTML = '';
    
    // 进入 AI 结果模式：保存全部结果，分批渲染（滚动追加）
    aiResultMode = true;
    aiRenderedCount = 0;
    allSearchResults = results.map((r, index) => ({
        id: r.file_id || r.id || r.metadata?.file_id || `ai-result-${index}`,
        fileId: r.file_id || r.id || r.metadata?.file_id || null,
        name: r.filename,
        filePath: r.file_path || r.path,
        duration: r.duration,
        format: r.format,
        similarity: r.similarity,
        aiDescription: r.ai_description || r.metadata?.ai_description || '',
        // 后端已经补了 tags 就直接用；老后端没有就用占位符，稍后再补一次
        tags: (Array.isArray(r.tags) && r.tags.length) ? r.tags : ['AI搜索']
    }));
    // 搜索接口只回文件名和分数，描述和标签要再按 id 批量补一次
    void hydrateResultMeta(allSearchResults).then((changed) => {
        if (changed) renderSoundList('', allSearchResults);
    });

    // 更新结果计数
    const headerText = document.querySelector('main .h-10 .flex-1');
    if (headerText) {
        headerText.textContent = `AI 搜索结果 (${results.length})`;
    }

    // 首批渲染 60 条，滚动到底自动追加
    appendAiResults(0, Math.min(60, allSearchResults.length));
    lucide.createIcons();

    // 滚动到列表顶部
    container.scrollTop = 0;

    // 显示通知
    showNotification(`AI 搜索完成，找到 ${results.length} 个相关音效`, 'success');
}

async function runAiSearch(rawText) {
    const input = document.getElementById('searchInput');
    const text = String(rawText || input?.value || '').trim();
    if (!text) {
        showNotification('先输入你想找的声音，例如：雨滴打在窗户上的声音', 'info');
        input?.focus();
        return;
    }
    const container = document.getElementById('soundList');
    container.innerHTML = `
        <div class="flex flex-col items-center justify-center py-16 opacity-70">
            <div class="animate-spin w-8 h-8 mb-3" style="border:2px solid var(--border-color); border-top-color:#8b5cf6; border-radius:50%;"></div>
            <p class="text-sm">AI 正在理解「${escapeHtml(text)}」…</p>
        </div>`;
    let gotResults = false;
    try {
        const response = await rendererApi.fetch('/api/v1/ai/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rendererSearch.buildChatPayload({
                message: text,
                projectId: currentProject?.id,
                history: [],
                topK: 300,
                threshold: 0.15
            }))
        });
        if (!response.ok) throw new Error('AI 搜索请求失败: ' + response.status);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';
        while (true) {
            const { done, value } = await reader.read();
            sseBuffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            const lines = sseBuffer.split('\n');
            sseBuffer = done ? '' : (lines.pop() || '');
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const payload = line.slice(6);
                if (payload === '[DONE]') continue;
                let event;
                try { event = JSON.parse(payload); } catch (_) { continue; }
                if (event.type === 'results' && Array.isArray(event.results)) {
                    if (event.results.length) {
                        displayAiSearchResults(event.results);
                        gotResults = true;
                    }
                } else if (event.type === 'error') {
                    showNotification(event.content || 'AI 搜索失败', 'error');
                }
            }
            if (done) break;
        }
        if (!gotResults) {
            container.innerHTML = `
                <div class="flex flex-col items-center justify-center py-16 opacity-60">
                    <i data-lucide="search-x" class="w-8 h-8 mb-3"></i>
                    <p class="text-sm">没有找到匹配的音效，换个描述试试</p>
                </div>`;
            lucide.createIcons();
        }
    } catch (error) {
        console.error('[AI Search] 失败:', error);
        showNotification('AI 搜索失败: ' + error.message, 'error');
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-16 opacity-60">
                <p class="text-sm">AI 搜索失败，请检查 AI 设置中的模型是否可用</p>
            </div>`;
    }
}

function appendAiResults(startIdx, endIdx) {
    if (startIdx >= endIdx) return;
    const container = document.getElementById('soundList');
    for (let index = startIdx; index < endIdx; index++) {
        const sd = allSearchResults[index];
        if (!sd) continue;
        const filePath = sd.filePath;
        const soundItem = document.createElement('div');
        soundItem.className = 'sound-item flex items-center py-2 px-4 border-b cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 transition-colors';
        soundItem.style.borderColor = 'var(--border-color)';
        soundItem.dataset.path = filePath;
        soundItem.dataset.index = index;

        soundItem.innerHTML = `
            <div class="w-10 flex justify-center"><input type="checkbox" class="sound-checkbox w-4 h-4 rounded border-gray-300"></div>
            <div class="w-12 flex justify-center">
                <div class="w-8 h-8 rounded border flex items-center justify-center text-xs" style="border-color: var(--border-color);">
                    ${index + 1}
                </div>
            </div>
            <div class="w-12 flex justify-center">
                <div class="w-8 h-8 rounded border flex items-center justify-center text-xs" style="background-color: var(--bg-tertiary); border-color: var(--border-color);">
                    <i data-lucide="music" class="w-4 h-4"></i>
                </div>
            </div>
            <div class="flex-1 min-w-0 flex items-center gap-2">
                <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium truncate" style="color: var(--text-primary);">${escapeHtml(sd.name)}</div>
                    <div class="text-xs truncate opacity-60" style="color: var(--text-secondary);">${escapeHtml(filePath)}</div>
                    ${sd.aiDescription ? `<div class="text-xs truncate opacity-50 mt-0.5" style="color: var(--text-secondary);">${escapeHtml(sd.aiDescription.replace(/^\[auto\]/,''))}</div>` : ''}
                </div>
            </div>
            <div class="w-24 text-right text-sm font-mono" style="color: var(--text-secondary);">${formatDuration(sd.duration)}</div>
            <div class="w-16 flex justify-center">
                <button class="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 play-btn" data-i18n-title="player.play" data-path="${escapeHtml(filePath)}">
                    <i data-lucide="play" class="w-4 h-4"></i>
                </button>
            </div>
        `;

        soundItem.addEventListener('click', (e) => {
            if (e.target.closest('.play-btn')) {
                e.stopPropagation();
                const path = e.target.closest('.play-btn').dataset.path;
                // Reuse the single async playback path so transcoded
                // formats wait for a fresh backend-owned WAV source.
                const soundObj = {
                    id: sd.id,
                    fileId: sd.fileId,
                    path: path,
                    filename: sd.name,
                    name: sd.name,
                    duration: sd.duration,
                    filePath: path
                };
                selectAndPlaySound(soundObj);
            } else if (e.target.closest('input[type="checkbox"]')) {
                // 复选框点击不触发选择
            } else {
                // 单击直接播放
                const soundObj = {
                    id: sd.id,
                    fileId: sd.fileId,
                    path: filePath,
                    filename: sd.name,
                    name: sd.name,
                    duration: sd.duration,
                    filePath: filePath
                };
                selectAndPlaySound(soundObj);
            }
        });

        // AI 搜索结果同样支持右键菜单（添加标签 / 打开位置 / 重命名等）
        soundItem.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showSoundContextMenu(e, {
                id: sd.id,
                fileId: sd.fileId,
                name: sd.name,
                filename: sd.name,
                path: filePath,
                filePath: filePath,
                duration: sd.duration,
                tags: sd.tags || [],
                aiDescription: sd.aiDescription || ''
            });
        });

        container.appendChild(soundItem);
    }
    aiRenderedCount = endIdx;
    lucide.createIcons();
}

function formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

