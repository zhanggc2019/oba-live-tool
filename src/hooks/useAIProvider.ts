import cloneDeep from 'lodash-es/cloneDeep'
import { providers } from 'shared/providers'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'

export type AIProvider = string

type APIKeys = {
  [key in AIProvider]: string
}

export interface ProviderConfig {
  provider: AIProvider
  model: string
  modelPreferences: {
    [key in AIProvider]: string
  }
}

export type AIConfigType = 'chat' | 'autoReply'

interface AIConfig {
  config: ProviderConfig
  apiKeys: APIKeys
  customBaseURL: string
}

interface AIProviderStore {
  chat: AIConfig
  autoReply: AIConfig
  setCustomBaseURL: (type: AIConfigType, url: string) => void
  setConfig: (type: AIConfigType, config: Partial<ProviderConfig>) => void
  setApiKey: (type: AIConfigType, provider: AIProvider, key: string) => void
}

/** 创建默认文本配置，并记住每个厂商上次选择的模型。 */
const createDefaultConfig = (): ProviderConfig => {
  const modelPreferences = Object.keys(providers).reduce(
    (acc, provider) => {
      acc[provider] = providers[provider].models[0] || ''
      return acc
    },
    {} as Record<string, string>,
  )

  return {
    provider: 'deepseek',
    model: providers.deepseek.models[0],
    modelPreferences,
  }
}

/** 为内置厂商初始化空密钥，不改变已有持久化配置。 */
const createDefaultApiKeys = (): APIKeys => {
  return Object.keys(providers).reduce(
    (acc, provider) => {
      acc[provider] = ''
      return acc
    },
    {} as Record<string, string>,
  )
}

/** AI 助手和直播回复分别保存模型、密钥与第三方接口地址。 */
const createDefaultAIConfig = (): AIConfig => ({
  config: createDefaultConfig(),
  apiKeys: createDefaultApiKeys(),
  customBaseURL: '',
})

export const useAIProviderStore = create<AIProviderStore>()(
  persist(
    immer(set => {
      return {
        chat: createDefaultAIConfig(),
        autoReply: createDefaultAIConfig(),
        setCustomBaseURL: (type, url) => {
          set(state => {
            state[type].customBaseURL = url
          })
        },
        setConfig: (type, config) => {
          set(state => {
            const currentConfig = state[type].config
            if (config.provider) {
              const newModel =
                config.model ??
                currentConfig.modelPreferences[config.provider] ??
                providers[config.provider]?.models[0] ??
                ''
              state[type].config.provider = config.provider
              state[type].config.model = newModel
              state[type].config.modelPreferences[config.provider] = newModel
            } else if (config.model) {
              state[type].config.model = config.model
              state[type].config.modelPreferences[currentConfig.provider] = config.model
            }
          })
        },
        setApiKey: (type, provider, key) => {
          set(state => {
            state[type].apiKeys[provider] = key
          })
        },
      }
    }),
    {
      name: 'ai-chat-storage',
      partialize: state => ({
        chat: state.chat,
        autoReply: state.autoReply,
      }),
      version: 1,
      migrate: (persistedState: unknown, version: number) => {
        // 从原先 useAIChat 旧版本迁移
        if (version === 0) {
          const oldState = (persistedState as AIConfig) || createDefaultAIConfig()
          const migratedState = {
            chat: cloneDeep(oldState),
            autoReply: cloneDeep(oldState),
          }
          return migratedState
        }
        return persistedState
      },
    },
  ),
)

/** 为指定功能提供独立的大模型设置与更新方法。 */
export function useAIProvider(type: AIConfigType) {
  const store = useAIProviderStore()
  const props = store[type]
  const actions = {
    setConfig: (config: Partial<ProviderConfig>) => {
      store.setConfig(type, config)
    },
    setApiKey: (provider: AIProvider, key: string) => {
      store.setApiKey(type, provider, key)
    },
    setCustomBaseURL: (url: string) => {
      store.setCustomBaseURL(type, url)
    },
  }
  return {
    ...props,
    ...actions,
  }
}
