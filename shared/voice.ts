export type TtsProviderId = 'mimo' | 'lanyun' | 'qwen' | 'openai-compatible'

export type TtsLanguage = 'ZH' | 'EN' | 'JA' | 'ES' | 'AR'

export interface TtsSettings {
  provider: TtsProviderId
  baseURL: string
  model: string
  voice: string
  instructions: string
  userId?: string
  voiceIdType?: 'voice_id' | 'external_voice_id'
  language?: TtsLanguage
  speechRate?: number
  intervalSilence?: number
}

export interface TtsVoice {
  id: string
  name: string
  isPrivate: boolean
}

export interface VoiceListRequest {
  requestId: string
  settings: TtsSettings
}

export interface CloneVoiceRequest {
  requestId: string
  name: string
  fileName: string
  audio: Uint8Array
  settings: TtsSettings
}

export interface SpeechAudio {
  base64: string
  mimeType: 'audio/wav' | 'audio/mpeg'
}

export interface SynthesisRequest {
  requestId: string
  text: string
  settings: TtsSettings
}

export const TTS_PRESETS: Record<TtsProviderId, TtsSettings> = {
  mimo: {
    provider: 'mimo',
    baseURL: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-tts',
    voice: 'mimo_default',
    instructions: '用自然、亲切的中文直播讲解语气朗读，语速适中。',
  },
  lanyun: {
    provider: 'lanyun',
    baseURL: 'https://tts.lanyun.net',
    model: 'IndexTTS-2.5',
    voice: '',
    instructions: '',
    userId: '',
    voiceIdType: 'voice_id',
    language: 'ZH',
    speechRate: 1,
    intervalSilence: 120,
  },
  qwen: {
    provider: 'qwen',
    baseURL: '',
    model: 'qwen-audio-3.1-tts-flash',
    voice: 'longanhuan_v3.1',
    instructions: '用自然、亲切的中文直播讲解语气朗读，语速适中。',
  },
  'openai-compatible': {
    provider: 'openai-compatible',
    baseURL: '',
    model: '',
    voice: '',
    instructions: '',
  },
}

// 四种音色均支持北京和新加坡地域；其他音色可直接填写官方 Voice ID。
export const QWEN_VOICES = [
  { id: 'longanhuan_v3.1', name: '龙安欢 · 女声' },
  { id: 'longanlingxin_v3.1', name: '龙安灵心 · 女声' },
  { id: 'longanfengyue_v3.1', name: '龙安风悦 · 女声' },
  { id: 'xunanchuan_v3.1', name: '许南川 · 男声' },
]

export const MIMO_VOICES = [
  'mimo_default',
  '冰糖',
  '茉莉',
  '苏打',
  '白桦',
  'Mia',
  'Chloe',
  'Milo',
  'Dean',
]

/** 按中英文句末及换行切句；保留小数、标点和引号，限制单次合成长度。 */
export function splitSpeechText(text: string, maxLength = 220): string[] {
  const limit = Math.max(10, Math.floor(maxLength))
  const sentences =
    text
      .replace(/\r\n?/g, '\n')
      .match(/[^。！？!?；;\n]+[。！？!?；;]*[”’」』"]*|[。！？!?；;]+/gu) ?? []
  const result: string[] = []
  for (const sentence of sentences) {
    // 英文句号仅在空白或结尾前分句，避免拆开价格、域名及版本号。
    for (const part of sentence.split(/(?<=\.)\s+(?=[A-Z\u4e00-\u9fff])/u)) {
      const chars = Array.from(part.trim())
      for (let offset = 0; offset < chars.length; offset += limit) {
        const chunk = chars
          .slice(offset, offset + limit)
          .join('')
          .trim()
        if (chunk && /[\p{L}\p{N}]/u.test(chunk)) result.push(chunk)
      }
    }
  }
  return result
}
