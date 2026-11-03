/**
 * 内置默认 providers，作为首次启动或离线时的降级方案。
 * 应用启动时会从 GitHub 获取最新 providers 并缓存到本地，
 * 后续启动优先使用缓存。
 */
export const providers: Record<string, ProviderInfo> = {
  deepseek: {
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    apiUrl: 'https://platform.deepseek.com/api_keys',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
  },
  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiUrl: 'https://openrouter.ai/keys',
    models: [
      'nex-agi/deepseek-v3.1-nex-n1',
      'deepseek/deepseek-v3.2-speciale',
      'deepseek/deepseek-v3.2',
      'deepseek/deepseek-v3.2-exp',
      'deepseek/deepseek-v3.1-terminus',
      'deepseek/deepseek-chat-v3.1',
      'tngtech/deepseek-r1t2-chimera',
      'deepseek/deepseek-r1-0528',
      'deepseek/deepseek-chat-v3-0324',
      'deepseek/deepseek-r1-distill-qwen-32b',
      'deepseek/deepseek-r1-distill-llama-70b',
      'deepseek/deepseek-r1',
      'deepseek/deepseek-chat',
    ],
  },
  siliconflow: {
    name: '硅基流动',
    baseURL: 'https://api.siliconflow.cn/v1',
    apiUrl: 'https://cloud.siliconflow.cn/account/ak',
    models: [
      'Qwen/Qwen3-8B',
      'deepseek-ai/DeepSeek-V3.2',
      'Pro/deepseek-ai/DeepSeek-V3.2',
      'deepseek-ai/DeepSeek-V3.1-Terminus',
      'Pro/deepseek-ai/DeepSeek-V3.1-Terminus',
      'deepseek-ai/DeepSeek-R1',
      'Pro/deepseek-ai/DeepSeek-R1',
      'deepseek-ai/DeepSeek-V3',
      'Pro/deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-OCR',
      'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B',
      'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B',
      'deepseek-ai/DeepSeek-R1-Distill-Qwen-14B',
      'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
      'deepseek-ai/DeepSeek-V2.5',
    ],
  },
  volcengine: {
    name: '火山引擎',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3/',
    apiUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    models: [],
  },
  custom: { name: '其他 OpenAI 兼容服务', baseURL: '', apiUrl: '', models: [] },
}

/** 合并在线目录与内置入口，防止旧缓存或远端列表覆盖本地新增的 Qwen 模型。 */
export function mergeProviders(
  data: Record<string, ProviderInfo> = {},
): Record<string, ProviderInfo> {
  const merged = { ...providers, ...data }
  merged.siliconflow = {
    ...providers.siliconflow,
    ...data.siliconflow,
    models: [
      ...new Set(['Qwen/Qwen3-8B', ...(data.siliconflow?.models ?? providers.siliconflow.models)]),
    ],
  }
  merged.custom = providers.custom
  return merged
}

/** 规范化兼容接口地址；允许粘贴完整聊天端点，也兼容本机 HTTP 模型服务。 */
export function normalizeChatBaseURL(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('请填写完整的接口地址，例如 https://api.example.com/v1')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('接口地址仅支持 HTTP/HTTPS，不能包含账号密码、查询参数或片段')
  const pathname = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
  return `${url.origin}${pathname}`
}

/** 为硅基流动 Qwen3-8B 关闭深度思考，减少直播问答等待；其他模型保持标准请求。 */
export function getChatModelOptions(
  provider: string,
  model: string,
): { enable_thinking?: boolean } {
  return provider === 'siliconflow' && model === 'Qwen/Qwen3-8B' ? { enable_thinking: false } : {}
}
