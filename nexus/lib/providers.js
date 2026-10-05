'use strict';

/**
 * Каталог LLM-провайдеров и их реальные сетевые вызовы.
 *
 * Семейства API:
 *   'openai'    — OpenAI Chat Completions (совместимо: Groq, Together, OpenRouter,
 *                 DeepSeek, Mistral, xAI, LM Studio, vLLM, Cerebras, SambaNova, OpenAI-совместимые прокси)
 *   'anthropic' — Anthropic Messages
 *   'ollama'    — Ollama /api/chat (локально, без ключа)
 *   'gemini'    — Google Gemini generateContent
 *   'yandex'    — Yandex Foundation Models (нативный API, модель вида folder-id/yandexgpt)
 *   'gigachat'  — GigaChat API Сбера (OAuth + OpenAI-совместимый chat/completions)
 *
 * Ключи хранятся зашифрованными (lib/store.js) и расшифровываются только в момент запроса.
 */

const { decrypt, fingerprint } = require('./store');

/* ------------------------------------------------------------------ каталог */

const PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI',
    family: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    keyRequired: true,
    dynamicModels: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    docs: 'https://platform.openai.com/docs',
    models: [
      { id: 'gpt-4o', ctx: 128000, in: 2.5, out: 10 },
      { id: 'gpt-4o-mini', ctx: 128000, in: 0.15, out: 0.6 },
      { id: 'gpt-4.1', ctx: 1047576, in: 2, out: 8 },
      { id: 'gpt-4.1-mini', ctx: 1047576, in: 0.4, out: 1.6 },
      { id: 'o4-mini', ctx: 200000, in: 1.1, out: 4.4 },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    family: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyRequired: true,
    dynamicModels: true,
    keyUrl: 'https://openrouter.ai/keys',
    docs: 'https://openrouter.ai/docs',
    extraHeaders: { 'HTTP-Referer': 'http://localhost:3100', 'X-Title': 'NEXUS' },
    models: [
      { id: 'anthropic/claude-sonnet-4.5', ctx: 200000, in: 3, out: 15 },
      { id: 'anthropic/claude-3.5-haiku', ctx: 200000, in: 0.8, out: 3.2 },
      { id: 'openai/gpt-4o-mini', ctx: 128000, in: 0.15, out: 0.6 },
      { id: 'google/gemini-2.0-flash-001', ctx: 1048576, in: 0.1, out: 0.4 },
      { id: 'meta-llama/llama-3.3-70b-instruct', ctx: 131072, in: 0.12, out: 0.3 },
      { id: 'deepseek/deepseek-chat', ctx: 64000, in: 0.27, out: 1.1 },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    family: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    keyRequired: true,
    dynamicModels: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    docs: 'https://docs.anthropic.com',
    extraHeaders: { 'anthropic-version': '2023-06-01' },
    models: [
      { id: 'claude-sonnet-4-5-20250929', ctx: 200000, in: 3, out: 15 },
      { id: 'claude-haiku-4-5-20251001', ctx: 200000, in: 1, out: 5 },
      { id: 'claude-3-5-haiku-20241022', ctx: 200000, in: 0.8, out: 4 },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama (локально)',
    family: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    keyRequired: false,
    docs: 'https://ollama.com/docs',
    models: [
      { id: 'qwen2.5-coder:14b', ctx: 32768, in: 0, out: 0 },
      { id: 'llama3.1:8b', ctx: 131072, in: 0, out: 0 },
      { id: 'gemma2:9b', ctx: 8192, in: 0, out: 0 },
    ],
    dynamicModels: true,
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    family: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyRequired: true,
    dynamicModels: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    docs: 'https://ai.google.dev/docs',
    models: [
      { id: 'gemini-2.0-flash', ctx: 1048576, in: 0.1, out: 0.4 },
      { id: 'gemini-1.5-pro', ctx: 2097152, in: 1.25, out: 5 },
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    family: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyRequired: true,
    dynamicModels: true,
    keyUrl: 'https://console.groq.com/keys',
    docs: 'https://console.groq.com/docs',
    models: [
      { id: 'llama-3.3-70b-versatile', ctx: 131072, in: 0.59, out: 0.79 },
      { id: 'mixtral-8x7b-32768', ctx: 32768, in: 0.24, out: 0.24 },
    ],
  },
  {
    id: 'together',
    name: 'Together AI',
    family: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    keyRequired: true,
    dynamicModels: true,
    keyUrl: 'https://api.together.ai/settings/api-keys',
    docs: 'https://docs.together.ai',
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', ctx: 131072, in: 0.88, out: 0.88 },
      { id: 'Qwen/Qwen2.5-72B-Instruct-Turbo', ctx: 32768, in: 1.2, out: 1.2 },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    family: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    keyRequired: true,
    dynamicModels: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    docs: 'https://api-docs.deepseek.com',
    models: [
      { id: 'deepseek-chat', ctx: 64000, in: 0.27, out: 1.1 },
      { id: 'deepseek-reasoner', ctx: 64000, in: 0.55, out: 2.19 },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    family: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    keyRequired: true,
    dynamicModels: true,
    keyUrl: 'https://console.mistral.ai/api-keys',
    docs: 'https://docs.mistral.ai',
    models: [
      { id: 'mistral-large-latest', ctx: 128000, in: 2, out: 6 },
      { id: 'mistral-small-latest', ctx: 128000, in: 0.1, out: 0.3 },
    ],
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    family: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    keyRequired: true,
    dynamicModels: true,
    keyUrl: 'https://console.x.ai',
    docs: 'https://docs.x.ai',
    models: [
      { id: 'grok-4', ctx: 256000, in: 3, out: 15 },
      { id: 'grok-3-mini', ctx: 131072, in: 0.3, out: 0.5 },
    ],
  },
  {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    family: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1',
    keyRequired: true,
    dynamicModels: true,
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
    docs: 'https://platform.moonshot.ai/docs',
    models: [
      { id: 'kimi-k2-0711-preview', ctx: 262144, in: 0.6, out: 2.5 },
      { id: 'moonshot-v1-128k', ctx: 131072, in: 1.2, out: 1.2 },
      { id: 'moonshot-v1-32k', ctx: 32768, in: 0.8, out: 0.8 },
    ],
  },
  {
    id: 'zhipu',
    name: 'Zhipu GLM',
    family: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyRequired: true,
    dynamicModels: true,
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    docs: 'https://open.bigmodel.cn/dev/howuse/introduction',
    models: [
      { id: 'glm-4-plus', ctx: 131072, in: 0.7, out: 0.7 },
      { id: 'glm-4', ctx: 131072, in: 1.4, out: 1.4 },
      { id: 'glm-4-flash', ctx: 131072, in: 0.01, out: 0.01 },
    ],
  },
  {
    id: 'qwen',
    name: 'Qwen (Alibaba)',
    family: 'openai',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    keyRequired: true,
    dynamicModels: true,
    keyUrl: 'https://bailian.console.alibabacloud.com/?apiKey=1#/api-key',
    docs: 'https://www.alibabacloud.com/help/en/model-studio/developer-reference/compatibility-of-openai-with-dashscope',
    models: [
      { id: 'qwen-max', ctx: 32768, in: 1.2, out: 4.8 },
      { id: 'qwen-plus', ctx: 131072, in: 0.4, out: 1.2 },
      { id: 'qwen-turbo', ctx: 1000000, in: 0.05, out: 0.2 },
    ],
  },
  {
    id: 'cohere',
    name: 'Cohere',
    family: 'openai',
    baseUrl: 'https://api.cohere.com/compatibility/v1',
    keyRequired: true,
    dynamicModels: true,
    keyUrl: 'https://dashboard.cohere.com/api-keys',
    docs: 'https://docs.cohere.com/docs/compatibility-api',
    models: [
      { id: 'command-r-plus', ctx: 131072, in: 2.5, out: 10 },
      { id: 'command-r', ctx: 131072, in: 0.15, out: 0.6 },
    ],
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    family: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    keyRequired: true,
    dynamicModels: true,
    keyUrl: 'https://fireworks.ai/account/api-keys',
    docs: 'https://fireworks.ai/docs',
    models: [
      { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', ctx: 131072, in: 0.9, out: 0.9 },
      { id: 'accounts/fireworks/models/qwen2p5-72b-instruct', ctx: 32768, in: 0.9, out: 0.9 },
    ],
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    family: 'openai',
    baseUrl: 'https://api.perplexity.ai',
    keyRequired: true,
    dynamicModels: true,
    keyUrl: 'https://www.perplexity.ai/settings/api',
    docs: 'https://docs.perplexity.ai',
    models: [
      { id: 'sonar-pro', ctx: 200000, in: 3, out: 15 },
      { id: 'sonar', ctx: 131072, in: 1, out: 1 },
      { id: 'sonar-reasoning', ctx: 131072, in: 1, out: 5 },
    ],
  },
  {
    id: 'novita',
    name: 'Novita AI',
    family: 'openai',
    baseUrl: 'https://api.novita.ai/v3/openai',
    keyRequired: true,
    dynamicModels: true,
    keyUrl: 'https://novita.ai/settings/key-management',
    docs: 'https://novita.ai/docs',
    models: [
      { id: 'meta-llama/llama-3.3-70b-instruct', ctx: 131072, in: 0.2, out: 0.2 },
      { id: 'deepseek/deepseek-v3-0324', ctx: 163840, in: 0.2, out: 0.8 },
    ],
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    family: 'openai',
    baseUrl: 'https://api.deepinfra.net/v1/openai',
    keyRequired: true,
    dynamicModels: true,
    keyUrl: 'https://deepinfra.com/dash/api_keys',
    docs: 'https://deepinfra.com/docs',
    models: [
      { id: 'meta-llama/Meta-Llama-3.3-70B-Instruct', ctx: 131072, in: 0.23, out: 0.4 },
      { id: 'Qwen/Qwen2.5-72B-Instruct', ctx: 32768, in: 0.12, out: 0.3 },
    ],
  },
  {
    id: 'hyperbolic',
    name: 'Hyperbolic',
    family: 'openai',
    baseUrl: 'https://api.hyperbolic.xyz/v1',
    keyRequired: true,
    dynamicModels: true,
    keyUrl: 'https://app.hyperbolic.xyz/settings',
    docs: 'https://docs.hyperbolic.xyz',
    models: [
      { id: 'meta-llama/Meta-Llama-3.3-70B-Instruct', ctx: 131072, in: 0.2, out: 0.2 },
      { id: 'Qwen/Qwen2.5-72B-Instruct', ctx: 32768, in: 0.2, out: 0.2 },
    ],
  },
  {
    id: 'nebius',
    name: 'Nebius AI',
    family: 'openai',
    baseUrl: 'https://api.studio.nebius.com/v1',
    keyRequired: true,
    dynamicModels: true,
    keyUrl: 'https://studio.nebius.com/settings/api-keys',
    docs: 'https://docs.nebius.com/studio/inference',
    models: [
      { id: 'meta-llama/Meta-Llama-3.3-70B-Instruct', ctx: 131072, in: 0.2, out: 0.6 },
      { id: 'Qwen/Qwen2.5-72B-Instruct', ctx: 32768, in: 0.2, out: 0.6 },
    ],
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (локально)',
    family: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    keyRequired: false,
    docs: 'https://lmstudio.ai/docs',
    models: [{ id: 'local-model', ctx: 32768, in: 0, out: 0 }],
    dynamicModels: true,
  },
  {
    id: 'vllm',
    name: 'vLLM (локально)',
    family: 'openai',
    baseUrl: 'http://127.0.0.1:8000/v1',
    keyRequired: false,
    docs: 'https://docs.vllm.ai',
    models: [{ id: 'local-model', ctx: 32768, in: 0, out: 0 }],
    dynamicModels: true,
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    family: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyRequired: true,
    dynamicModels: true,
    keyUrl: 'https://cloud.cerebras.ai/keys',
    docs: 'https://inference-docs.cerebras.ai',
    models: [
      { id: 'llama-3.3-70b', ctx: 131072, in: 0.85, out: 1.2 },
      { id: 'qwen-3-32b', ctx: 131072, in: 0.4, out: 0.8 },
    ],
  },
  {
    id: 'sambanova',
    name: 'SambaNova',
    family: 'openai',
    baseUrl: 'https://api.sambanova.ai/v1',
    keyRequired: true,
    dynamicModels: true,
    keyUrl: 'https://cloud.sambanova.ai/keys',
    docs: 'https://docs.sambanova.ai',
    models: [
      { id: 'Meta-Llama-3.3-70B-Instruct', ctx: 131072, in: 0.4, out: 0.8 },
      { id: 'DeepSeek-R1-0528', ctx: 163840, in: 5, out: 7 },
    ],
  },
  {
    id: 'yandexgpt',
    name: 'YandexGPT',
    family: 'yandex',
    baseUrl: 'https://llm.api.cloud.yandex.net/foundationModels/v1',
    keyRequired: true,
    dynamicModels: false,
    keyUrl: 'https://yandex.cloud/ru/docs/iam/operations/api-key/create',
    docs: 'https://yandex.cloud/ru/docs/foundation-models/quickstart',
    models: [
      { id: 'b1g00000000000000000/yandexgpt', ctx: 8192, in: 0.6, out: 1.8 },
      { id: 'b1g00000000000000000/yandexgpt-lite', ctx: 8192, in: 0.2, out: 0.6 },
    ],
  },
  {
    id: 'gigachat',
    name: 'GigaChat (Сбер)',
    family: 'gigachat',
    baseUrl: 'https://gigachat.devices.sberbank.ru/api/v1',
    keyRequired: true,
    dynamicModels: false,
    keyUrl: 'https://developers.sber.ru/studio/workspaces',
    docs: 'https://developers.sber.ru/docs/ru/gigachat/api',
    models: [
      { id: 'GigaChat', ctx: 200000, in: 1.4, out: 2.1 },
      { id: 'GigaChat-Pro', ctx: 200000, in: 2.8, out: 4.2 },
      { id: 'GigaChat-Max', ctx: 200000, in: 5.6, out: 8.4 },
    ],
  },
  {
    id: 'custom',
    name: 'Кастомный (OpenAI-совместимый)',
    family: 'openai',
    baseUrl: '',
    keyRequired: false,
    docs: '',
    models: [{ id: 'default', ctx: 32768, in: 0, out: 0 }],
    dynamicModels: true,
  },
];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

function getProvider(id) {
  return BY_ID.get(id) || BY_ID.get('custom');
}

/** Публичное описание каталога (без секретов) для UI. */
function catalog() {
  return PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    family: p.family,
    baseUrl: p.baseUrl,
    keyRequired: p.keyRequired,
    keyUrl: p.keyUrl || '',
    docs: p.docs || '',
    dynamicModels: !!p.dynamicModels,
    models: p.models,
  }));
}

/* --------------------------------------------------------------- утилиты сети */

class ProviderError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.status = status || 502;
    this.detail = detail;
  }
}

function joinUrl(base, p) {
  return `${String(base).replace(/\/+$/, '')}/${String(p).replace(/^\/+/, '')}`;
}

async function request(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 120000);
  let res;
  try {
    res = await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') throw new ProviderError(`Таймаут запроса (${options.timeoutMs || 120000} мс)`, 504);
    throw new ProviderError(`Сеть недоступна: ${e.message}`, 502);
  }
  clearTimeout(timeout);
  return res;
}

async function errorFrom(res) {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      detail = (j.error && (j.error.message || JSON.stringify(j.error))) || j.message || text;
    } catch {
      detail = text;
    }
  } catch {}
  return new ProviderError(
    `${res.status} ${res.statusText || ''}`.trim() + (detail ? ` — ${detail.slice(0, 400)}` : ''),
    res.status,
  );
}

/* ------------------------------------------------------- OpenAI-совместимые */

/**
 * Внутренний формат сообщений агента (camelCase) → wire-формат OpenAI.
 * Без этого провайдер получает `toolCallId` вместо `tool_call_id` и отвечает
 * 400 «tool messages must include a non-empty string tool_call_id».
 * Пустые вызовы отсекаются здесь же — отправлять их нельзя.
 */
function toOpenAIMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      const calls = m.toolCalls
        .filter((c) => c && c.id && String(c.id).trim() && c.name && String(c.name).trim())
        .map((c) => ({
          id: String(c.id),
          type: 'function',
          function: {
            name: String(c.name),
            arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args || {}),
          },
        }));
      if (!calls.length) {
        out.push({ role: 'assistant', content: m.content == null ? '' : m.content });
      } else {
        out.push({ role: 'assistant', content: m.content || null, tool_calls: calls });
      }
    } else if (m.role === 'tool') {
      if (!m.toolCallId || !String(m.toolCallId).trim()) continue;
      out.push({ role: 'tool', tool_call_id: String(m.toolCallId), content: String(m.content == null ? '' : m.content) });
    } else if (m.role === 'user' && Array.isArray(m.images) && m.images.length) {
      /* Vision: текст + картинки одним сообщением */
      const parts = [{ type: 'text', text: String(m.content == null ? '' : m.content) }];
      for (const img of m.images.slice(0, 3)) {
        if (img && img.data) parts.push({ type: 'image_url', image_url: { url: `data:${img.mime || 'image/png'};base64,${img.data}` } });
      }
      out.push({ role: 'user', content: parts });
    } else {
      out.push({ role: m.role, content: m.content == null ? '' : m.content });
    }
  }
  return out;
}

/**
 * Внутренний формат → wire-формат Ollama /api/chat.
 * У Ollama tool-сообщения без id: { role: 'tool', content }.
 */
function toOllamaMessages(messages) {
  return (messages || []).map((m) => {
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      const calls = m.toolCalls
        .filter((c) => c && c.name && String(c.name).trim())
        .map((c) => ({ function: { name: String(c.name), arguments: safeParse(c.args) } }));
      if (!calls.length) return { role: 'assistant', content: m.content == null ? '' : m.content };
      return { role: 'assistant', content: m.content || '', tool_calls: calls };
    }
    if (m.role === 'tool') return { role: 'tool', content: String(m.content == null ? '' : m.content) };
    if (m.role === 'user' && Array.isArray(m.images) && m.images.length) {
      /* Ollama multimodal: base64-картинки полем images */
      return {
        role: 'user',
        content: String(m.content == null ? '' : m.content),
        images: m.images.slice(0, 3).filter((img) => img && img.data).map((img) => img.data),
      };
    }
    return { role: m.role, content: m.content == null ? '' : m.content };
  });
}

/**
 * /models у OpenAI-совместимых провайдеров.
 * OpenRouter дополнительно отдаёт context_length и pricing - берём их,
 * чтобы в выборе моделей показывать реальное окно контекста и цену.
 * Цены провайдеров указаны за токен, а интерфейс показывает за 1M токенов,
 * поэтому приводим к $/1M здесь.
 */
async function listModelsOpenAI(cfg) {
  const res = await request(joinUrl(cfg.baseUrl, 'models'), { headers: headersOpenAI(cfg) });
  if (!res.ok) throw await errorFrom(res);
  const data = await res.json();
  return (data.data || []).map((m) => {
    const price = m.pricing || {};
    const pin = price.prompt != null ? price.prompt : price.input;
    const pout = price.completion != null ? price.completion : price.output;
    return {
      id: m.id,
      ctx: m.context_length || m.context_window || m.max_context_length || 0,
      in: perMillion(pin),
      out: perMillion(pout),
    };
  });
}

/** Цена приходит строкой и за токен: "0.0000025" -> 2.5 (USD за 1M токенов). */
function perMillion(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n) || n <= 0) return 0;
  const per1M = n * 1e6;
  /* Округляем до разумной точности, чтобы не показывать 2.5000000000000004 */
  return Math.round(per1M * 1e6) / 1e6;
}

function headersOpenAI(cfg) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, cfg.extraHeaders || {});
  if (cfg.key) h.Authorization = `Bearer ${cfg.key}`;
  return h;
}

/**
 * Стриминговый вызов chat/completions.
 * onEvent: {type:'delta', text} | {type:'tool', calls} | {type:'usage', usage} | {type:'done'}
 */
async function streamOpenAI(cfg, payload, onEvent, signal) {
  const body = Object.assign(
    { stream: true, stream_options: { include_usage: true } },
    payload,
    { messages: toOpenAIMessages(payload.messages) },
  );
  const res = await request(joinUrl(cfg.baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: headersOpenAI(cfg),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await errorFrom(res);
  if (!res.body) throw new ProviderError('Пустой поток ответа', 502);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const toolAcc = new Map();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n');
    buffer = parts.pop() || '';
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const payloadStr = trimmed.slice(5).trim();
      if (payloadStr === '[DONE]') continue;
      let chunk;
      try {
        chunk = JSON.parse(payloadStr);
      } catch {
        continue;
      }
      if (chunk.usage) onEvent({ type: 'usage', usage: normalizeUsage(chunk.usage) });
      if (chunk.error) throw new ProviderError(chunk.error.message || 'Ошибка провайдера', 502);
      const choice = (chunk.choices || [])[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.content) onEvent({ type: 'delta', text: delta.content });
      /* Рассуждения модели (DeepSeek R1 и др. через OpenRouter): показываем
         отдельно от ответа — это «мысли вслух», а не результат. */
      if (delta.reasoning || delta.reasoning_content) {
        onEvent({ type: 'think', text: delta.reasoning || delta.reasoning_content });
      }
      if (delta.tool_calls) {
        for (let _ti = 0; _ti < delta.tool_calls.length; _ti++) {
          const tc = delta.tool_calls[_ti];
          /* Некоторые провайдеры не шлют index — тогда ключом служит порядок в чанке */
          const key = tc.index ?? `noidx_${_ti}`;
          const cur =
            toolAcc.get(key) ||
            toolAcc.set(key, { id: tc.id, name: '', args: '' }).get(key);
          if (tc.id) cur.id = tc.id;
          if (tc.function && tc.function.name) cur.name += tc.function.name;
          if (tc.function && tc.function.arguments) cur.args += tc.function.arguments;
        }
      }
      if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') {
        onEvent({ type: 'tool', calls: [...toolAcc.values()] });
      }
    }
  }
  onEvent({ type: 'done' });
}

function normalizeUsage(u) {
  return {
    promptTokens: u.prompt_tokens ?? u.input_tokens ?? 0,
    completionTokens: u.completion_tokens ?? u.output_tokens ?? 0,
    totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
  };
}

/** Проверка соединения: список моделей + дешёвый тест-вызов. */
async function verifyOpenAI(cfg) {
  const started = Date.now();
  const models = await listModelsOpenAI(cfg);
  return { ok: true, latencyMs: Date.now() - started, models: models.length, detail: `моделей в каталоге: ${models.length}` };
}

/* --------------------------------------------------------------- Anthropic */

function toAnthropicMessages(messages) {
  const sys = [];
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') sys.push({ type: 'text', text: m.content });
    else if (m.role === 'tool') out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }] });
    else if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      const content = [{ type: 'text', text: m.content || '' }];
      for (const c of m.toolCalls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: safeParse(c.args) });
      out.push({ role: 'assistant', content });
    } else if (m.role === 'user' && Array.isArray(m.images) && m.images.length) {
      const content = [{ type: 'text', text: String(m.content == null ? '' : m.content) }];
      for (const img of m.images.slice(0, 3)) {
        if (img && img.data) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime || 'image/png', data: img.data } });
      }
      out.push({ role: 'user', content });
    } else out.push({ role: m.role, content: m.content });
  }
  return { sys, out };
}

function safeParse(s) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

async function listModelsAnthropic(cfg) {
  const res = await request(joinUrl(cfg.baseUrl, 'models'), { headers: headersAnthropic(cfg) });
  if (!res.ok) throw await errorFrom(res);
  const data = await res.json();
  return (data.data || []).map((m) => ({ id: m.id, ctx: 0, in: 0, out: 0 }));
}

function headersAnthropic(cfg) {
  const h = Object.assign({ 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }, cfg.extraHeaders || {});
  if (cfg.key) h['x-api-key'] = cfg.key;
  return h;
}

async function streamAnthropic(cfg, payload, onEvent, signal) {
  const { sys, out } = toAnthropicMessages(payload.messages);
  const body = {
    model: payload.model,
    max_tokens: payload.max_tokens || 4096,
    temperature: payload.temperature,
    stream: true,
    messages: out,
  };
  if (sys.length) body.system = sys.map((s) => s.text).join('\n\n');
  if (payload.tools) {
    body.tools = payload.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }

  const res = await request(joinUrl(cfg.baseUrl, 'messages'), {
    method: 'POST',
    headers: headersAnthropic(cfg),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await errorFrom(res);
  if (!res.body) throw new ProviderError('Пустой поток ответа', 502);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const toolAcc = new Map();
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n');
    buffer = parts.pop() || '';
    for (const line of parts) {
      if (!line.trim().startsWith('data:')) continue;
      let ev;
      try {
        ev = JSON.parse(line.trim().slice(5).trim());
      } catch {
        continue;
      }
      if (ev.type === 'message_start' && ev.message && ev.message.usage) {
        usage.promptTokens = ev.message.usage.input_tokens || 0;
      }
      if (ev.type === 'content_block_delta') {
        const d = ev.delta || {};
        if (d.type === 'text_delta') onEvent({ type: 'delta', text: d.text });
        if (d.type === 'input_json_delta') {
          const cur = toolAcc.get(ev.index) || { id: `call_${ev.index}`, name: '', args: '' };
          cur.args += d.partial_json || '';
          toolAcc.set(ev.index, cur);
        }
      }
      if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') {
        toolAcc.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, args: '' });
      }
      if (ev.type === 'message_delta' && ev.usage) {
        usage.completionTokens = ev.usage.output_tokens || usage.completionTokens;
        onEvent({ type: 'usage', usage: { ...usage, totalTokens: usage.promptTokens + usage.completionTokens } });
      }
      if (ev.type === 'message_stop') {
        if (toolAcc.size) onEvent({ type: 'tool', calls: [...toolAcc.values()] });
        onEvent({ type: 'usage', usage: { ...usage, totalTokens: usage.promptTokens + usage.completionTokens } });
      }
    }
  }
  onEvent({ type: 'done' });
}

async function verifyAnthropic(cfg) {
  const started = Date.now();
  const models = await listModelsAnthropic(cfg);
  return { ok: true, latencyMs: Date.now() - started, models: models.length, detail: `моделей в каталоге: ${models.length}` };
}

/* ------------------------------------------------------------------ Ollama */

async function listModelsOllama(cfg) {
  const res = await request(joinUrl(cfg.baseUrl, '/api/tags'), { headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) throw await errorFrom(res);
  const data = await res.json();
  return (data.models || []).map((m) => ({ id: m.name, ctx: 0, in: 0, out: 0 }));
}

async function streamOllama(cfg, payload, onEvent, signal) {
  const body = {
    model: payload.model,
    messages: toOllamaMessages(payload.messages),
    stream: true,
    options: { temperature: payload.temperature },
  };
  if (payload.tools) body.tools = payload.tools;

  const res = await request(joinUrl(cfg.baseUrl, '/api/chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await errorFrom(res);
  if (!res.body) throw new ProviderError('Пустой поток ответа', 502);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const last = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n');
    buffer = parts.pop() || '';
    for (const line of parts) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = ev.message || {};
      if (msg.content) onEvent({ type: 'delta', text: msg.content });
      if (msg.tool_calls && msg.tool_calls.length) {
        onEvent({
          type: 'tool',
          calls: msg.tool_calls.map((c, i) => ({
            id: `call_${i}_${Date.now()}`,
            name: c.function && c.function.name,
            args: JSON.stringify((c.function && c.function.arguments) || {}),
          })),
        });
      }
      if (ev.done) {
        last.promptTokens = ev.prompt_eval_count || 0;
        last.completionTokens = ev.eval_count || 0;
        last.totalTokens = last.promptTokens + last.completionTokens;
        onEvent({ type: 'usage', usage: last });
      }
    }
  }
  onEvent({ type: 'done' });
}

async function verifyOllama(cfg) {
  const started = Date.now();
  const models = await listModelsOllama(cfg);
  if (!models.length) return { ok: false, latencyMs: Date.now() - started, models: 0, detail: 'Сервер отвечает, но моделей нет — выполните `ollama pull <модель>`' };
  return { ok: true, latencyMs: Date.now() - started, models: models.length, detail: `локальных моделей: ${models.length}` };
}

/* ------------------------------------------------------------------ Gemini */

function headersGemini(cfg) {
  const h = { 'Content-Type': 'application/json' };
  if (cfg.key) h['x-goog-api-key'] = cfg.key;
  return h;
}

async function listModelsGemini(cfg) {
  const res = await request(joinUrl(cfg.baseUrl, 'models'), { headers: headersGemini(cfg) });
  if (!res.ok) throw await errorFrom(res);
  const data = await res.json();
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => ({ id: m.name.replace(/^models\//, ''), ctx: m.inputTokenLimit || 0, in: 0, out: 0 }));
}

async function streamGemini(cfg, payload, onEvent, signal) {
  const sys = [];
  const contents = [];
  for (const m of payload.messages) {
    if (m.role === 'system') sys.push(m.content);
    else if (m.role === 'tool') contents.push({ role: 'user', parts: [{ functionResponse: { name: m.name || 'tool', response: { result: m.content } } }] });
    else if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const c of m.toolCalls) parts.push({ functionCall: { name: c.name, args: safeParse(c.args) } });
      contents.push({ role: 'model', parts });
    } else if (m.role === 'user' && Array.isArray(m.images) && m.images.length) {
      const parts = [{ text: String(m.content == null ? '' : m.content) }];
      for (const img of m.images.slice(0, 3)) {
        if (img && img.data) parts.push({ inlineData: { mimeType: img.mime || 'image/png', data: img.data } });
      }
      contents.push({ role: 'user', parts });
    } else contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
  }
  const body = {
    contents,
    generationConfig: { temperature: payload.temperature, maxOutputTokens: payload.max_tokens || 4096 },
  };
  if (sys.length) body.systemInstruction = { parts: [{ text: sys.join('\n\n') }] };
  if (payload.tools) {
    body.tools = [
      {
        functionDeclarations: payload.tools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parameters: cleanSchema(t.function.parameters),
        })),
      },
    ];
  }

  const url = `${joinUrl(cfg.baseUrl, `models/${encodeURIComponent(payload.model)}:streamGenerateContent?alt=sse`)}`;
  const res = await request(url, { method: 'POST', headers: headersGemini(cfg), body: JSON.stringify(body), signal });
  if (!res.ok) throw await errorFrom(res);
  if (!res.body) throw new ProviderError('Пустой поток ответа', 502);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n');
    buffer = parts.pop() || '';
    for (const line of parts) {
      if (!line.trim().startsWith('data:')) continue;
      let ev;
      try {
        ev = JSON.parse(line.trim().slice(5).trim());
      } catch {
        continue;
      }
      const cand = (ev.candidates || [])[0];
      if (cand && cand.content && cand.content.parts) {
        for (const p of cand.content.parts) {
          if (p.text) onEvent({ type: 'delta', text: p.text });
          if (p.functionCall) {
            onEvent({
              type: 'tool',
              calls: [{ id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, name: p.functionCall.name, args: JSON.stringify(p.functionCall.args || {}) }],
            });
          }
        }
      }
      if (ev.usageMetadata) {
        usage.promptTokens = ev.usageMetadata.promptTokenCount || 0;
        usage.completionTokens = ev.usageMetadata.candidatesTokenCount || 0;
        usage.totalTokens = ev.usageMetadata.totalTokenCount || usage.promptTokens + usage.completionTokens;
        onEvent({ type: 'usage', usage });
      }
    }
  }
  onEvent({ type: 'done' });
}

/** Gemini не принимает additionalProperties/'$schema' — вычищаем. */
function cleanSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  return JSON.parse(JSON.stringify(schema, (k, v) => (k === 'additionalProperties' || k === '$schema' ? undefined : v)));
}

async function verifyGemini(cfg) {
  const started = Date.now();
  const models = await listModelsGemini(cfg);
  return { ok: true, latencyMs: Date.now() - started, models: models.length, detail: `моделей в каталоге: ${models.length}` };
}

/* --------------------------------------------------------------- YandexGPT */

function parseYandexModel(model) {
  const s = String(model || '');
  const i = s.indexOf('/');
  if (i <= 0) {
    throw new ProviderError(
      'YandexGPT: модель укажите как «folder-id/yandexgpt» (или «folder-id/yandexgpt-lite») — folder-id виден в консоли Yandex Cloud рядом с каталогом',
      400,
    );
  }
  return { folder: s.slice(0, i), name: s.slice(i + 1) || 'yandexgpt' };
}

function toYandexMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.role === 'tool') {
      out.push({ role: 'user', text: `Результат инструмента ${m.name || ''}: ${String(m.content == null ? '' : m.content).slice(0, 4000)}` });
    } else if (m.role === 'user' && Array.isArray(m.images) && m.images.length) {
      /* Yandex без vision: честно говорим, что картинки не видно */
      out.push({ role: 'user', text: `${String(m.content == null ? '' : m.content)}\n[К сообщению приложены изображения, но эта модель их не видит. Попроси пользователя описать их словами.]` });
    } else if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      out.push({ role: 'assistant', text: String(m.content || '') });
    } else if (m.role === 'system') {
      out.push({ role: 'system', text: String(m.content == null ? '' : m.content) });
    } else {
      out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', text: String(m.content == null ? '' : m.content) });
    }
  }
  return out;
}

/**
 * Нативный API Yandex Foundation Models (без стрима и без tools:
 * агент отвечает текстом, файлы и данные тянет через RAG-автоконтекст).
 */
async function streamYandex(cfg, payload, onEvent, signal) {
  const { folder, name } = parseYandexModel(payload.model || cfg.model);
  const res = await request('https://llm.api.cloud.yandex.net/foundationModels/v1/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Api-Key ${cfg.key}`, 'x-folder-id': folder },
    body: JSON.stringify({
      modelUri: `gpt://${folder}/${name}/latest`,
      completionOptions: { stream: false, temperature: Number(payload.temperature) || 0.3, maxTokens: String(payload.max_tokens || 2000) },
      messages: toYandexMessages(payload.messages),
    }),
    signal,
    timeoutMs: 120000,
  });
  if (!res.ok) throw await errorFrom(res);
  let j;
  try {
    j = await res.json();
  } catch {
    throw new ProviderError('YandexGPT: некорректный ответ', 502);
  }
  const alt = j.result && j.result.alternatives && j.result.alternatives[0];
  if (!alt || !alt.message || !alt.message.text) throw new ProviderError('YandexGPT: пустой ответ', 502);
  const u = (j.result && j.result.usage) || {};
  onEvent({
    type: 'usage',
    usage: {
      promptTokens: Number(u.inputTextTokens) || 0,
      completionTokens: Number(u.completionTextTokens) || 0,
      totalTokens: Number(u.totalTextTokens) || 0,
    },
  });
  onEvent({ type: 'delta', text: alt.message.text });
  onEvent({ type: 'done' });
}

async function verifyYandex(cfg) {
  const started = Date.now();
  await streamYandex(cfg, { model: cfg.model, messages: [{ role: 'user', content: 'Ответь одним словом: связь.' }], max_tokens: 10 }, () => {}, undefined);
  return { ok: true, latencyMs: Date.now() - started, models: 1, detail: 'связь есть, модель отвечает' };
}

/* ---------------------------------------------------------------- GigaChat */

const gigaTokens = new Map(); // authKey -> { token, exp }

/** OAuth-токен Сбера: Basic-ключ из Studio → access_token (кэшируем с запасом). */
async function gigaToken(authKey) {
  const cached = gigaTokens.get(authKey);
  if (cached && cached.exp - Date.now() > 60000) return cached.token;
  const rqUid = require('crypto').randomUUID();
  const res = await request('https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      RqUID: rqUid,
      Authorization: `Basic ${authKey}`,
    },
    body: 'scope=GIGACHAT_API_PERS',
    timeoutMs: 30000,
  });
  if (!res.ok) throw await errorFrom(res);
  let j;
  try {
    j = await res.json();
  } catch {
    throw new ProviderError('GigaChat: некорректный ответ OAuth', 502);
  }
  if (!j.access_token) throw new ProviderError('GigaChat: не выдан access_token — проверьте ключ из Studio', 401);
  gigaTokens.set(authKey, { token: j.access_token, exp: Number(j.expires_at) || Date.now() + 1500000 });
  return j.access_token;
}

/** GigaChat chat/completions OpenAI-совместим: шлём tools как есть. */
async function streamGigaChat(cfg, payload, onEvent, signal) {
  const token = await gigaToken(cfg.key);
  const body = Object.assign(
    { stream: true },
    payload,
    { messages: toOpenAIMessages(payload.messages) },
  );
  const res = await request(joinUrl(cfg.baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await errorFrom(res);
  if (!res.body) throw new ProviderError('Пустой поток ответа', 502);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const toolAcc = new Map();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n');
    buffer = parts.pop() || '';
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const payloadStr = trimmed.slice(5).trim();
      if (payloadStr === '[DONE]') continue;
      let chunk;
      try {
        chunk = JSON.parse(payloadStr);
      } catch {
        continue;
      }
      if (chunk.usage) onEvent({ type: 'usage', usage: normalizeUsage(chunk.usage) });
      if (chunk.error) throw new ProviderError(chunk.error.message || 'Ошибка провайдера', 502);
      const choice = (chunk.choices || [])[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.content) onEvent({ type: 'delta', text: delta.content });
      if (delta.tool_calls) {
        for (let _ti = 0; _ti < delta.tool_calls.length; _ti++) {
          const tc = delta.tool_calls[_ti];
          const key = tc.index ?? `noidx_${_ti}`;
          const cur = toolAcc.get(key) || toolAcc.set(key, { id: tc.id, name: '', args: '' }).get(key);
          if (tc.id) cur.id = tc.id;
          if (tc.function && tc.function.name) cur.name += tc.function.name;
          if (tc.function && tc.function.arguments) cur.args += tc.function.arguments;
        }
      }
      if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') {
        onEvent({ type: 'tool', calls: [...toolAcc.values()] });
      }
    }
  }
  onEvent({ type: 'done' });
}

async function verifyGigaChat(cfg) {
  const started = Date.now();
  const token = await gigaToken(cfg.key);
  const res = await request(joinUrl(cfg.baseUrl, 'models'), {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    timeoutMs: 30000,
  });
  if (!res.ok) throw await errorFrom(res);
  let count = 0;
  try {
    const j = await res.json();
    count = ((j && j.data) || []).length;
  } catch { count = 0; }
  return { ok: true, latencyMs: Date.now() - started, models: count, detail: `моделей в каталоге: ${count}` };
}

/* ------------------------------------------------------------- диспетчер */

const IMPL = {
  openai: { stream: streamOpenAI, verify: verifyOpenAI },
  anthropic: { stream: streamAnthropic, verify: verifyAnthropic },
  ollama: { stream: streamOllama, verify: verifyOllama },
  gemini: { stream: streamGemini, verify: verifyGemini },
  yandex: { stream: streamYandex, verify: verifyYandex },
  gigachat: { stream: streamGigaChat, verify: verifyGigaChat },
};

/**
 * Собрать конфигурацию провайдера из записи пользователя + расшифрованного ключа.
 * cfg = { providerId, baseUrl, keyCipher, extraHeaders, model }
 */
function buildConfig(entry, model) {
  const base = getProvider(entry.providerId);
  const family = entry.familyOverride || base.family;
  const impl = IMPL[family] || IMPL.openai;
  const baseUrl = (entry.baseUrl || base.baseUrl || '').trim();
  if (!baseUrl) throw new ProviderError(`Не задан base URL для провайдера «${base.name}»`, 400);
  const key = decrypt(entry.keyCipher || '');
  if (base.keyRequired && !key) throw new ProviderError(`Для «${base.name}» требуется API-ключ`, 400);
  return {
    providerId: base.id,
    providerName: base.name,
    family,
    baseUrl,
    key,
    extraHeaders: Object.assign({}, base.extraHeaders || {}, entry.extraHeaders || {}),
    model: model || (base.models[0] && base.models[0].id) || 'default',
  };
}

/** Проверка соединения с провайдером. */
async function verify(entry) {
  const base = getProvider(entry.providerId);
  const impl = IMPL[base.family] || IMPL.openai;
  const started = Date.now();
  const cfg = buildConfig(entry, null);
  if (base.keyRequired && !cfg.key) return { ok: false, latencyMs: Date.now() - started, detail: 'API-ключ не задан' };
  const res = await impl.verify(cfg);
  return Object.assign({ latencyMs: Date.now() - started }, res);
}

/** Стриминговый вызов: возвращает async-генератор событий. */
async function stream(cfg, payload, onEvent, signal) {
  const impl = IMPL[cfg.family] || IMPL.openai;
  await impl.stream(cfg, payload, onEvent, signal);
}

/** Динамический список моделей (для Ollama/LM Studio/vLLM/кастомных). */
/** Каталоговые модели как запасной вариант (никогда не пустой список). */
function catalogModels(entry) {
  const base = getProvider(entry.providerId);
  return base.models.map((m) => ({ id: m.id, ctx: m.ctx || 0, in: m.in || 0, out: m.out || 0, src: 'catalog' }));
}

/**
 * Живой список моделей провайдера с метаданными (окно контекста, цена).
 * Сеть недоступна или ключ без прав на /models - отдаём каталог,
 * чтобы в интерфейсе выбор моделей никогда не был пустым.
 */
async function liveModels(entry) {
  const base = getProvider(entry.providerId);
  if (!base.dynamicModels) return catalogModels(entry);

  /* Метаданные каталога - чтобы подтянуть цену/контекст, если провайдер их не отдал */
  const catMeta = new Map(base.models.map((m) => [m.id, m]));

  let list;
  try {
    const cfg = buildConfig(entry, null);
    list =
      base.family === 'ollama'
        ? await listModelsOllama(cfg)
        : base.family === 'gemini'
          ? await listModelsGemini(cfg)
          : base.family === 'anthropic'
            ? await listModelsAnthropic(cfg)
            : await listModelsOpenAI(cfg);
  } catch {
    return catalogModels(entry);
  }

  const out = [];
  const seen = new Set();
  for (const m of list || []) {
    const id = typeof m === 'string' ? m : m && m.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const meta = catMeta.get(id);
    out.push({
      id,
      ctx: (m && m.ctx) || (meta && meta.ctx) || 0,
      in: (m && m.in) || (meta && meta.in) || 0,
      out: (m && m.out) || (meta && meta.out) || 0,
      src: 'live',
    });
  }

  if (!out.length) return catalogModels(entry);

  /* Каталожные модели, которых не ответил сервер, не теряем - дописываем в конец */
  for (const m of base.models) {
    if (!seen.has(m.id)) out.push({ id: m.id, ctx: m.ctx || 0, in: m.in || 0, out: m.out || 0, src: 'catalog' });
  }
  return out;
}

module.exports = {
  PROVIDERS,
  catalog,
  getProvider,
  buildConfig,
  verify,
  stream,
  liveModels,
    encryptKey: require('./store').encrypt,
    fingerprint,
    ProviderError,
    toOpenAIMessages,
    toOllamaMessages,
  };