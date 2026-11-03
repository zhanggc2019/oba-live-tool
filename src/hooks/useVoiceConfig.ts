import type { SavedLiveScript } from 'shared/liveScript'
import {
  DEFAULT_SPEECH_PACING,
  normalizeSpeechPacing,
  type SpeechPacingSettings,
} from 'shared/speechPacing'
import { TTS_PRESETS, type TtsProviderId, type TtsSettings } from 'shared/voice'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { EVENTS, eventEmitter } from '@/utils/events'

export interface VoiceConfig {
  productIntro: string
  scriptRequirements: string
  generatedScript: string
  scriptDraftTitle: string
  scriptDraftId: string
  savedScripts: SavedLiveScript[]
  selectedScriptId: string
  factsScriptId: string
  openingScript: string
  loopScript: string
  referenceText: string
  loopEnabled: boolean
  gapMs: number
  prebufferSeconds: number
  outputDeviceId: string
  volume: number
  speechPacing: SpeechPacingSettings
  provider: TtsProviderId
  providers: Record<TtsProviderId, TtsSettings>
}

/** 每个账号独立保存话术、声音及输出设备，密钥由主进程加密保管。 */
export function createVoiceConfig(): VoiceConfig {
  return {
    productIntro: '',
    scriptRequirements: '',
    generatedScript: '',
    scriptDraftTitle: '',
    scriptDraftId: '',
    savedScripts: [],
    selectedScriptId: '',
    factsScriptId: '',
    openingScript: '',
    loopScript: '',
    referenceText: '',
    loopEnabled: false,
    gapMs: 150,
    prebufferSeconds: 30,
    outputDeviceId: 'default',
    volume: 0.8,
    speechPacing: { ...DEFAULT_SPEECH_PACING },
    provider: 'mimo',
    providers: {
      mimo: { ...TTS_PRESETS.mimo },
      lanyun: { ...TTS_PRESETS.lanyun },
      qwen: { ...TTS_PRESETS.qwen },
      'openai-compatible': { ...TTS_PRESETS['openai-compatible'] },
    },
  }
}

interface VoiceConfigStore {
  contexts: Record<string, VoiceConfig>
  update: (accountId: string, patch: Partial<VoiceConfig>) => void
  updateProvider: (accountId: string, provider: TtsProviderId, patch: Partial<TtsSettings>) => void
}

export const useVoiceConfigStore = create<VoiceConfigStore>()(
  persist(
    (set, get) => ({
      contexts: {},
      /** 合并当前账号的非敏感配置。 */
      update: (accountId, patch) =>
        set(state => {
          const current = getVoiceConfig(accountId)
          return {
            contexts: {
              ...state.contexts,
              [accountId]: {
                ...current,
                ...patch,
              },
            },
          }
        }),
      /** 切换厂商时保留各自的模型、音色及接口设置。 */
      updateProvider: (accountId, provider, patch) => {
        const config = getVoiceConfig(accountId)
        get().update(accountId, {
          providers: {
            ...config.providers,
            [provider]: { ...config.providers[provider], ...patch, provider },
          },
        })
      },
    }),
    { name: 'voice-config', version: 1 },
  ),
)

/** 获取补齐默认值的账号配置，兼容已有账号。 */
export function getVoiceConfig(accountId: string): VoiceConfig {
  const defaults = createVoiceConfig()
  const stored = useVoiceConfigStore.getState().contexts[accountId]
  return {
    ...defaults,
    ...stored,
    prebufferSeconds: [0, 15, 30, 45].includes(stored?.prebufferSeconds)
      ? stored.prebufferSeconds
      : 30,
    speechPacing: normalizeSpeechPacing(stored?.speechPacing),
    providers: {
      mimo: { ...defaults.providers.mimo, ...stored?.providers?.mimo },
      lanyun: { ...defaults.providers.lanyun, ...stored?.providers?.lanyun },
      qwen: { ...defaults.providers.qwen, ...stored?.providers?.qwen },
      'openai-compatible': {
        ...defaults.providers['openai-compatible'],
        ...stored?.providers?.['openai-compatible'],
      },
    },
  }
}

eventEmitter.on(EVENTS.ACCOUNT_REMOVED, (accountId: string) => {
  useVoiceConfigStore.setState(state => {
    const contexts = { ...state.contexts }
    delete contexts[accountId]
    return { contexts }
  })
})
