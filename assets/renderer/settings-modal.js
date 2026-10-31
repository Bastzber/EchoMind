/* settings-modal.js —— SETTINGS MODAL
 * 从 index.html 原样搬出的完整顶层函数。
 */
function openSettingsModal() {
    const modal = document.getElementById('settingsModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    loadAiConfig();
    // loadWindowPrefs 定义在「设置」初始化作用域里，这里通过全局钩子调用，
    // 直接引用该标识符会抛 ReferenceError（它在别的作用域里）
    try { window.__loadWindowPrefs?.(); } catch (error) { console.warn('[Settings] 读取窗口设置失败:', error); }
}

function closeSettingsModal() {
    const modal = document.getElementById('settingsModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

async function loadAiConfig() {
    try {
        const data = window.electronAPI?.aiConfig
            ? await window.electronAPI.aiConfig.get()
            : await rendererApi.get('/api/v1/ai/config');

        if (data.success) {
            // 设置 LLM 配置
            const llmProvider = data.llm.provider;
            document.querySelectorAll('input[name="llmProvider"]').forEach(radio => {
                radio.checked = radio.value === llmProvider;
            });
            updateLlmConfigDisplay(llmProvider);

            // 加载所有 LLM provider 配置
            const llmConfig = data.llm.config || {};

            // LM Studio
            const lmStudioCfg = llmConfig.lm_studio || {};
            document.getElementById('lmStudioUrl').value = lmStudioCfg.base_url || 'http://localhost:1234/v1';
            document.getElementById('lmStudioModel').value = lmStudioCfg.model || '';

            // Ollama
            const ollamaCfg = llmConfig.ollama || {};
            document.getElementById('ollamaUrl').value = ollamaCfg.base_url || 'http://localhost:11434/v1';
            document.getElementById('ollamaModel').value = ollamaCfg.model || '';

            // OpenAI
            const openaiCfg = llmConfig.openai || {};
            document.getElementById('openaiUrl').value = openaiCfg.base_url || 'https://api.openai.com/v1';
            setSecretInputState('openaiApiKey', openaiCfg);
            document.getElementById('openaiModel').value = openaiCfg.model || 'gpt-4o-mini';

            // Azure
            const azureCfg = llmConfig.azure || {};
            document.getElementById('azureUrl').value = azureCfg.base_url || 'https://YOUR_RESOURCE.openai.azure.com';
            setSecretInputState('azureApiKey', azureCfg);
            document.getElementById('azureModel').value = azureCfg.model || '';
            document.getElementById('azureApiVersion').value = azureCfg.api_version || '2024-02-01';

            // Gemini
            const geminiCfg = llmConfig.gemini || {};
            document.getElementById('geminiUrl').value = geminiCfg.base_url || 'https://generativelanguage.googleapis.com';
            setSecretInputState('geminiApiKey', geminiCfg);
            document.getElementById('geminiModel').value = geminiCfg.model || 'gemini-2.0-flash';

            // Kimi
            const kimiCfg = llmConfig.kimi || {};
            document.getElementById('kimiUrl').value = kimiCfg.base_url || 'https://api.moonshot.cn/v1';
            setSecretInputState('kimiApiKey', kimiCfg);
            document.getElementById('kimiModel').value = kimiCfg.model || 'moonshot-v1-8k';

            // Kimi Coding
            const kimiCodingCfg = llmConfig.kimi_coding || {};
            document.getElementById('kimiCodingUrl').value = kimiCodingCfg.base_url || 'https://api.kimi.com/coding';
            setSecretInputState('kimiCodingApiKey', kimiCodingCfg);
            document.getElementById('kimiCodingModel').value = kimiCodingCfg.model || 'k2p5';
            const kimiCodingHeaders = kimiCodingCfg.headers || {};
            document.getElementById('kimiCodingClawId').value = kimiCodingHeaders['X-Kimi-Claw-ID'] || '';

            // Anthropic
            const anthropicCfg = llmConfig.anthropic || {};
            document.getElementById('anthropicUrl').value = anthropicCfg.base_url || 'https://api.anthropic.com/v1';
            setSecretInputState('anthropicApiKey', anthropicCfg);
            document.getElementById('anthropicModel').value = anthropicCfg.model || 'claude-3-haiku-20240307';

            // DeepSeek
            const deepseekCfg = llmConfig.deepseek || {};
            document.getElementById('deepseekUrl').value = deepseekCfg.base_url || 'https://api.deepseek.com/v1';
            setSecretInputState('deepseekApiKey', deepseekCfg);
            document.getElementById('deepseekModel').value = deepseekCfg.model || 'deepseek-chat';

            // SiliconFlow
            const siliconflowCfg = llmConfig.siliconflow || {};
            document.getElementById('siliconflowUrl').value = siliconflowCfg.base_url || 'https://api.siliconflow.cn/v1';
            setSecretInputState('siliconflowApiKey', siliconflowCfg);
            document.getElementById('siliconflowModel').value = siliconflowCfg.model || 'Qwen/Qwen2.5-7B-Instruct';

            // Custom
            const customCfg = llmConfig.custom || {};
            document.getElementById('customApiUrl').value = customCfg.base_url || 'https://your-api.com/v1';
            setSecretInputState('customApiKey', customCfg);
            document.getElementById('customApiModel').value = customCfg.model || '';

            // 旧的外部 API
            const extConfig = llmConfig.external || {};
            document.getElementById('externalApiUrl').value = extConfig.base_url || '';
            setSecretInputState('externalApiKey', extConfig);
            document.getElementById('externalApiModel').value = extConfig.model || '';

            // 设置 Embedding 配置
            const embProvider = data.embedding.provider;
            document.querySelectorAll('input[name="embeddingProvider"]').forEach(radio => {
                radio.checked = radio.value === embProvider;
            });
            updateEmbeddingConfigDisplay(embProvider);

            const embConfig = data.embedding.config || {};
            const localEmbConfig = embConfig.local || {};
            if (localEmbConfig.type) {
                document.getElementById('localEmbeddingType').value = localEmbConfig.type;
            }
            document.getElementById('localEmbeddingUrl').value = localEmbConfig.base_url || 'http://localhost:1234/v1';
            document.getElementById('localEmbeddingModel').value = localEmbConfig.model || '';

            const extEmbConfig = embConfig.external || {};
            document.getElementById('externalEmbeddingUrl').value = extEmbConfig.base_url || '';
            setSecretInputState('externalEmbeddingKey', extEmbConfig);
            document.getElementById('externalEmbeddingModel').value = extEmbConfig.model || '';
        }
        return true;
    } catch (error) {
        console.error('加载 AI 配置失败:', error);
        // 不显示错误通知，因为后端可能还未启动
        return false;
    }
}

function updateLlmConfigDisplay(provider) {
    // 隐藏所有配置面板
    document.getElementById('lmStudioConfig').classList.add('hidden');
    document.getElementById('ollamaConfig').classList.add('hidden');
    document.getElementById('openaiConfig').classList.add('hidden');
    document.getElementById('azureConfig').classList.add('hidden');
    document.getElementById('geminiConfig').classList.add('hidden');
    document.getElementById('kimiConfig').classList.add('hidden');
    document.getElementById('kimiCodingConfig').classList.add('hidden');
    document.getElementById('anthropicConfig').classList.add('hidden');
    document.getElementById('deepseekConfig').classList.add('hidden');
    document.getElementById('siliconflowConfig').classList.add('hidden');
    document.getElementById('customApiConfig').classList.add('hidden');
    document.getElementById('externalApiConfig').classList.add('hidden');

    const unavailableNotice = document.getElementById('unsupportedLlmProviderNotice');
    if (UNSUPPORTED_LLM_PROVIDERS.has(provider)) {
        if (unavailableNotice) {
            unavailableNotice.textContent = i18n.t('settings.ai.provider.unavailable', { provider });
            unavailableNotice.classList.remove('hidden');
        }
        return;
    }
    unavailableNotice?.classList.add('hidden');

    // 显示对应的配置面板
    const panelMap = {
        'lm_studio': 'lmStudioConfig',
        'ollama': 'ollamaConfig',
        'openai': 'openaiConfig',
        'azure': 'azureConfig',
        'gemini': 'geminiConfig',
        'kimi': 'kimiConfig',
        'kimi_coding': 'kimiCodingConfig',
        'anthropic': 'anthropicConfig',
        'deepseek': 'deepseekConfig',
        'siliconflow': 'siliconflowConfig',
        'custom': 'customApiConfig',
        'external': 'externalApiConfig',
    };

    const panelId = panelMap[provider];
    if (panelId) {
        const panel = document.getElementById(panelId);
        if (panel) {
            panel.classList.remove('hidden');
        }
    }
}

function updateEmbeddingConfigDisplay(provider) {
    document.getElementById('localEmbeddingConfig').classList.add('hidden');
    document.getElementById('externalEmbeddingConfig').classList.add('hidden');

    if (provider === 'local') {
        document.getElementById('localEmbeddingConfig').classList.remove('hidden');
    } else if (provider === 'external') {
        document.getElementById('externalEmbeddingConfig').classList.remove('hidden');
    }
}

async function testAiConnection() {
    const testBtn = document.getElementById('testConnectionBtn');
    testBtn.disabled = true;
    testBtn.innerHTML = '<i data-lucide="loader" class="w-4 h-4 inline mr-1 animate-spin"></i>测试中...';
    lucide.createIcons();

    const llmProvider = document.querySelector('input[name="llmProvider"]:checked')?.value || 'lm_studio';
    const embProvider = document.querySelector('input[name="embeddingProvider"]:checked')?.value || 'default';

    let llmConfig = {};

    // 根据不同 provider 获取配置
    switch (llmProvider) {
        case 'lm_studio':
            llmConfig = {
                base_url: document.getElementById('lmStudioUrl').value,
                model: document.getElementById('lmStudioModel').value
            };
            break;
        case 'ollama':
            llmConfig = {
                base_url: document.getElementById('ollamaUrl').value,
                model: document.getElementById('ollamaModel').value
            };
            break;
        case 'openai':
            llmConfig = {
                base_url: document.getElementById('openaiUrl').value,
                api_key: getApiKeyForRequest('openaiApiKey'),
                model: document.getElementById('openaiModel').value
            };
            break;
        case 'azure':
            llmConfig = {
                base_url: document.getElementById('azureUrl').value,
                api_key: getApiKeyForRequest('azureApiKey'),
                model: document.getElementById('azureModel').value,
                api_version: document.getElementById('azureApiVersion').value
            };
            break;
        case 'gemini':
            llmConfig = {
                base_url: document.getElementById('geminiUrl').value,
                api_key: getApiKeyForRequest('geminiApiKey'),
                model: document.getElementById('geminiModel').value
            };
            break;
        case 'kimi':
            llmConfig = {
                base_url: document.getElementById('kimiUrl').value,
                api_key: getApiKeyForRequest('kimiApiKey'),
                model: document.getElementById('kimiModel').value
            };
            break;
        case 'kimi_coding':
            const kimiCodingHeaders = {
                'User-Agent': 'Kimi Claw Plugin'
            };
            const clawId = document.getElementById('kimiCodingClawId').value;
            if (clawId) {
                kimiCodingHeaders['X-Kimi-Claw-ID'] = clawId;
            }
            llmConfig = {
                base_url: document.getElementById('kimiCodingUrl').value,
                api_key: getApiKeyForRequest('kimiCodingApiKey'),
                model: document.getElementById('kimiCodingModel').value,
                headers: kimiCodingHeaders
            };
            break;
        case 'anthropic':
            llmConfig = {
                base_url: document.getElementById('anthropicUrl').value,
                api_key: getApiKeyForRequest('anthropicApiKey'),
                model: document.getElementById('anthropicModel').value
            };
            break;
        case 'deepseek':
            llmConfig = {
                base_url: document.getElementById('deepseekUrl').value,
                api_key: getApiKeyForRequest('deepseekApiKey'),
                model: document.getElementById('deepseekModel').value
            };
            break;
        case 'siliconflow':
            llmConfig = {
                base_url: document.getElementById('siliconflowUrl').value,
                api_key: getApiKeyForRequest('siliconflowApiKey'),
                model: document.getElementById('siliconflowModel').value
            };
            break;
        case 'custom':
            llmConfig = {
                base_url: document.getElementById('customApiUrl').value,
                api_key: getApiKeyForRequest('customApiKey'),
                model: document.getElementById('customApiModel').value
            };
            break;
        default:
            llmConfig = {
                base_url: document.getElementById('externalApiUrl').value,
                api_key: getApiKeyForRequest('externalApiKey'),
                model: document.getElementById('externalApiModel').value
            };
    }

    let embConfig = {};
    if (embProvider === 'local') {
        embConfig = {
            type: document.getElementById('localEmbeddingType').value,
            base_url: document.getElementById('localEmbeddingUrl').value,
            model: document.getElementById('localEmbeddingModel').value
        };
    } else if (embProvider === 'external') {
        embConfig = {
            base_url: document.getElementById('externalEmbeddingUrl').value,
            api_key: getApiKeyForRequest('externalEmbeddingKey'),
            model: document.getElementById('externalEmbeddingModel').value
        };
    }

    try {
        if (!window.electronAPI?.aiConfig) {
            throw new Error('系统安全存储仅在回声桌面应用中可用');
        }
        const data = await window.electronAPI.aiConfig.test({
            llm_provider: llmProvider,
            llm_config: llmConfig,
            embedding_provider: embProvider,
            embedding_config: embConfig,
            ...getAiSecretUpdates(llmProvider, embProvider)
        });

        if (data.success) {
            showNotification('连接测试成功！', 'success');
        } else {
            let errorMsg = '连接测试失败';
            if (!data.llm?.success) {
                errorMsg += `\nLLM: ${data.llm?.message || '未知错误'}`;
            }
            if (!data.embedding?.success) {
                errorMsg += `\nEmbedding: ${data.embedding?.message || '未知错误'}`;
            }
            showNotification(errorMsg, 'error');
        }
    } catch (error) {
        showNotification('测试请求失败: ' + error.message, 'error');
    } finally {
        testBtn.disabled = false;
        testBtn.innerHTML = '<i data-lucide="wifi" class="w-4 h-4 inline mr-1"></i>测试连接';
        lucide.createIcons();
    }
}

async function saveAiConfig() {
    const saveBtn = document.getElementById('saveSettingsBtn');
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';

    const llmProvider = document.querySelector('input[name="llmProvider"]:checked')?.value || 'lm_studio';
    const embProvider = document.querySelector('input[name="embeddingProvider"]:checked')?.value || 'default';

    let llmConfig = {};

    // 根据不同 provider 获取配置
    switch (llmProvider) {
        case 'lm_studio':
            llmConfig = {
                base_url: document.getElementById('lmStudioUrl').value,
                model: document.getElementById('lmStudioModel').value
            };
            break;
        case 'ollama':
            llmConfig = {
                base_url: document.getElementById('ollamaUrl').value,
                model: document.getElementById('ollamaModel').value
            };
            break;
        case 'openai':
            llmConfig = {
                base_url: document.getElementById('openaiUrl').value,
                api_key: getApiKeyForRequest('openaiApiKey'),
                model: document.getElementById('openaiModel').value
            };
            break;
        case 'azure':
            llmConfig = {
                base_url: document.getElementById('azureUrl').value,
                api_key: getApiKeyForRequest('azureApiKey'),
                model: document.getElementById('azureModel').value,
                api_version: document.getElementById('azureApiVersion').value
            };
            break;
        case 'gemini':
            llmConfig = {
                base_url: document.getElementById('geminiUrl').value,
                api_key: getApiKeyForRequest('geminiApiKey'),
                model: document.getElementById('geminiModel').value
            };
            break;
        case 'kimi':
            llmConfig = {
                base_url: document.getElementById('kimiUrl').value,
                api_key: getApiKeyForRequest('kimiApiKey'),
                model: document.getElementById('kimiModel').value
            };
            break;
        case 'kimi_coding':
            const kimiCodingHeaders = {
                'User-Agent': 'Kimi Claw Plugin'
            };
            const clawId = document.getElementById('kimiCodingClawId').value;
            if (clawId) {
                kimiCodingHeaders['X-Kimi-Claw-ID'] = clawId;
            }
            llmConfig = {
                base_url: document.getElementById('kimiCodingUrl').value,
                api_key: getApiKeyForRequest('kimiCodingApiKey'),
                model: document.getElementById('kimiCodingModel').value,
                headers: kimiCodingHeaders
            };
            break;
        case 'anthropic':
            llmConfig = {
                base_url: document.getElementById('anthropicUrl').value,
                api_key: getApiKeyForRequest('anthropicApiKey'),
                model: document.getElementById('anthropicModel').value
            };
            break;
        case 'deepseek':
            llmConfig = {
                base_url: document.getElementById('deepseekUrl').value,
                api_key: getApiKeyForRequest('deepseekApiKey'),
                model: document.getElementById('deepseekModel').value
            };
            break;
        case 'siliconflow':
            llmConfig = {
                base_url: document.getElementById('siliconflowUrl').value,
                api_key: getApiKeyForRequest('siliconflowApiKey'),
                model: document.getElementById('siliconflowModel').value
            };
            break;
        case 'custom':
            llmConfig = {
                base_url: document.getElementById('customApiUrl').value,
                api_key: getApiKeyForRequest('customApiKey'),
                model: document.getElementById('customApiModel').value
            };
            break;
        default:
            llmConfig = {
                base_url: document.getElementById('externalApiUrl').value,
                api_key: getApiKeyForRequest('externalApiKey'),
                model: document.getElementById('externalApiModel').value
            };
    }

    let embConfig = {};
    if (embProvider === 'local') {
        embConfig = {
            type: document.getElementById('localEmbeddingType').value,
            base_url: document.getElementById('localEmbeddingUrl').value,
            model: document.getElementById('localEmbeddingModel').value
        };
    } else if (embProvider === 'external') {
        embConfig = {
            base_url: document.getElementById('externalEmbeddingUrl').value,
            api_key: getApiKeyForRequest('externalEmbeddingKey'),
            model: document.getElementById('externalEmbeddingModel').value
        };
    }

    try {
        if (!window.electronAPI?.aiConfig) {
            throw new Error('系统安全存储仅在回声桌面应用中可用');
        }
        // 保存请求可能因为后端在重建索引而长时间无响应；
        // 加超时，避免按钮永远停在「保存中...」。
        const savePromise = window.electronAPI.aiConfig.save({
            llm_provider: llmProvider,
            llm_config: llmConfig,
            embedding_provider: embProvider,
            embedding_config: embConfig,
            ...getAiSecretUpdates(llmProvider, embProvider)
        });
        const data = await Promise.race([
            savePromise,
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('保存超时（后端可能正在重建索引），请稍后重试')),
                25000
            ))
        ]);

        if (data.success) {
            showNotification('配置已保存', 'success');
            closeSettingsModal();
        } else {
            showNotification('保存失败: ' + (data.error || '未知错误'), 'error');
        }
    } catch (error) {
        showNotification('保存请求失败: ' + error.message, 'error');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = '保存配置';
    }
}

