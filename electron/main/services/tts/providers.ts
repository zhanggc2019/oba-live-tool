import type { SpeechAudio, TtsProviderId, TtsSettings, TtsVoice } from '../../../../shared/voice'
import { validateCloneAudio } from '../../../../shared/voiceClone'

const MAX_AUDIO_BYTES = 16 * 1024 * 1024

export interface TtsProvider {
  synthesize(
    text: string,
    settings: TtsSettings,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<SpeechAudio>
}

/** 验证厂商地址与必填字段，禁止将密钥发往明文远程地址。 */
export function validateTtsSettings(settings: TtsSettings, requireVoice = true): URL {
  if (!settings || !['mimo', 'lanyun', 'qwen', 'openai-compatible'].includes(settings.provider)) {
    throw new Error('请选择有效的 TTS 厂商')
  }
  let url: URL
  try {
    url = new URL(settings.baseURL)
  } catch {
    throw new Error('请填写完整的 TTS API 地址')
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('TTS API 地址需使用 HTTPS（本机服务可使用 HTTP），且不包含凭据、查询或锚点')
  }
  if (settings.provider === 'mimo' && url.origin !== 'https://api.xiaomimimo.com') {
    throw new Error('MiMo 预设仅连接官方 API 地址')
  }
  if (
    settings.provider === 'qwen' &&
    (url.protocol !== 'https:' ||
      url.port ||
      !/^[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(url.hostname) ||
      !/^\/api\/v1\/*$/.test(url.pathname))
  ) {
    throw new Error(
      '请填写包含业务空间 ID 的阿里官方地址：https://业务空间ID.cn-beijing.maas.aliyuncs.com/api/v1（新加坡使用 ap-southeast-1）',
    )
  }
  if (
    typeof settings.model !== 'string' ||
    typeof settings.voice !== 'string' ||
    typeof settings.instructions !== 'string'
  )
    throw new Error('TTS 配置格式不正确')
  if (requireVoice && !settings.voice.trim()) throw new Error('请先选择或填写音色 ID')
  if (settings.provider !== 'lanyun' && !settings.model.trim()) throw new Error('请填写模型')
  if (
    settings.model.length > 200 ||
    settings.voice.length > 200 ||
    settings.instructions.length > 2000
  ) {
    throw new Error('模型、音色或风格描述过长')
  }
  if (settings.provider === 'lanyun') {
    if (!['voice_id', 'external_voice_id'].includes(settings.voiceIdType ?? 'voice_id')) {
      throw new Error('请选择有效的蓝云音色 ID 类型')
    }
    const voiceLimit = settings.voiceIdType === 'external_voice_id' ? 128 : 64
    if (requireVoice && settings.voice.trim().length > voiceLimit) {
      throw new Error(`蓝云音色 ID 最多 ${voiceLimit} 个字符`)
    }
    if (
      settings.userId !== undefined &&
      (typeof settings.userId !== 'string' ||
        settings.userId.length > 256 ||
        /[^\x20-\x7e]/.test(settings.userId))
    )
      throw new Error('蓝云用户 ID 请使用不超过 256 位的英文字母、数字或可打印符号')
    if (!['ZH', 'EN', 'JA', 'ES', 'AR'].includes(settings.language ?? 'ZH')) {
      throw new Error('请选择蓝云支持的语言')
    }
    const rate = settings.speechRate ?? 1
    const silence = settings.intervalSilence ?? 120
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0.5 || rate > 2) {
      throw new Error('蓝云语速需在 0.5 到 2 倍之间')
    }
    if (!Number.isInteger(silence) || silence < 0 || silence > 1000) {
      throw new Error('蓝云段间停顿需为 0 到 1000 毫秒的整数')
    }
  }
  return url
}

/** 读取有限大小的响应，避免异常服务返回过大的音频。 */
async function readLimited(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) throw new Error('TTS 服务返回了空响应')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) throw new Error('TTS 音频过大，请缩短单句话术')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}

/** 调用厂商接口，错误仅显示状态码，不回显请求密钥或厂商原始内容。 */
async function postAudio(
  path: string,
  body: unknown,
  settings: TtsSettings,
  apiKey: string,
  signal: AbortSignal,
) {
  validateTtsSettings(settings)
  const response = await fetch(`${settings.baseURL.replace(/\/+$/, '')}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
    redirect: 'error',
  })
  if (!response.ok) {
    await response.body?.cancel()
    const tips =
      response.status === 401
        ? '，请检查 API Key'
        : response.status === 429
          ? '，请检查额度或降低请求频率'
          : ''
    throw new Error(`TTS 合成失败（HTTP ${response.status}）${tips}`)
  }
  return response
}

/** 校验 WAV 文件标识，避免将错误 JSON 或裸 PCM 当作可播放音频。 */
function assertWav(data: Uint8Array): void {
  const bytes = Buffer.from(data)
  if (
    bytes.length < 44 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('TTS 服务未返回有效的 WAV 音频')
  }
}

export class MimoTtsProvider implements TtsProvider {
  /** MiMo V2.5 的朗读文本必须在 assistant 消息中，风格指令放在 user 中。 */
  async synthesize(
    text: string,
    settings: TtsSettings,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<SpeechAudio> {
    const response = await postAudio(
      'chat/completions',
      {
        model: settings.model,
        messages: [
          ...(settings.instructions.trim()
            ? [{ role: 'user', content: settings.instructions }]
            : []),
          { role: 'assistant', content: text },
        ],
        audio: { format: 'wav', voice: settings.voice },
        stream: false,
      },
      settings,
      apiKey,
      signal,
    )
    const bytes = await readLimited(response, MAX_AUDIO_BYTES * 1.5)
    const data = JSON.parse(Buffer.from(bytes).toString('utf8'))
    const base64 = data?.choices?.[0]?.message?.audio?.data
    if (typeof base64 !== 'string' || !base64 || !/^[A-Za-z0-9+/=\s]+$/.test(base64)) {
      throw new Error('MiMo 未返回音频，请检查模型、音色和账户权限')
    }
    const audio = Buffer.from(base64, 'base64')
    if (audio.length > MAX_AUDIO_BYTES) throw new Error('TTS 音频过大')
    assertWav(audio)
    return { base64: audio.toString('base64'), mimeType: 'audio/wav' }
  }
}

export class OpenAICompatibleTtsProvider implements TtsProvider {
  /** 兼容提供 POST /audio/speech 并返回 WAV 文件的语音厂商。 */
  async synthesize(
    text: string,
    settings: TtsSettings,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<SpeechAudio> {
    const response = await postAudio(
      'audio/speech',
      {
        model: settings.model,
        input: text,
        voice: settings.voice,
        response_format: 'wav',
        ...(settings.instructions.trim() ? { instructions: settings.instructions } : {}),
      },
      settings,
      apiKey,
      signal,
    )
    const audio = await readLimited(response, MAX_AUDIO_BYTES)
    assertWav(audio)
    return { base64: Buffer.from(audio).toString('base64'), mimeType: 'audio/wav' }
  }
}

export class QwenTtsProvider implements TtsProvider {
  /** 使用阿里原生 HTTP 协议合成 WAV，下载签名音频时不携带 API Key。 */
  async synthesize(
    text: string,
    settings: TtsSettings,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<SpeechAudio> {
    signal.throwIfAborted()
    const response = await postAudio(
      'services/audio/tts/SpeechSynthesizer',
      {
        model: settings.model,
        input: {
          text,
          voice: settings.voice.trim(),
          format: 'wav',
          sample_rate: 24000,
          ...(settings.instructions.trim() ? { instruction: settings.instructions.trim() } : {}),
        },
      },
      settings,
      apiKey,
      signal,
    )
    const bytes = await readLimited(response, 1024 * 1024)
    let data: { code?: unknown; output?: { audio?: { url?: unknown } } } | null
    try {
      data = JSON.parse(Buffer.from(bytes).toString('utf8'))
    } catch {
      throw new Error('阿里 TTS 返回了无效的 JSON 响应')
    }
    if (data?.code) throw new Error('阿里 TTS 合成失败，请检查模型、音色、地域及账户权限')
    let audioURL: URL
    try {
      if (typeof data?.output?.audio?.url !== 'string') throw new Error()
      audioURL = new URL(data.output.audio.url)
    } catch {
      throw new Error('阿里 TTS 未返回有效的音频下载地址')
    }
    if (
      !['http:', 'https:'].includes(audioURL.protocol) ||
      audioURL.port ||
      audioURL.username ||
      audioURL.password ||
      audioURL.hash ||
      !/^[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(audioURL.hostname)
    ) {
      throw new Error('阿里 TTS 音频下载地址必须为官方 OSS 地址且不含凭据或锚点')
    }
    // 官方示例可能返回 HTTP 签名链接，统一通过 HTTPS 下载并保留签名参数。
    audioURL.protocol = 'https:'
    signal.throwIfAborted()
    let download: Response
    try {
      download = await fetch(audioURL, { signal, redirect: 'error' })
    } catch {
      signal.throwIfAborted()
      throw new Error('阿里 TTS 音频下载失败，请稍后重试')
    }
    if (!download.ok) {
      await download.body?.cancel().catch(() => {})
      throw new Error(`阿里 TTS 音频下载失败（HTTP ${download.status}），请重新合成`)
    }
    const audio = await readLimited(download, MAX_AUDIO_BYTES)
    signal.throwIfAborted()
    assertWav(audio)
    return { base64: Buffer.from(audio).toString('base64'), mimeType: 'audio/wav' }
  }
}

/** 构造蓝云原生鉴权头；私人音色查询、合成和下载共享相同身份。 */
function lanyunHeaders(settings: TtsSettings, apiKey: string): Headers {
  try {
    const headers = new Headers({ 'X-API-Key': apiKey })
    if (settings.userId?.trim()) headers.set('X-User-ID', settings.userId.trim())
    return headers
  } catch {
    throw new Error('蓝云 API Key 或用户 ID 格式不正确')
  }
}

/** 使用状态码说明蓝云错误，不回显可能包含敏感信息的服务响应。 */
async function checkLanyunResponse(response: Response): Promise<void> {
  if (response.ok) return
  await response.body?.cancel().catch(() => {})
  const tips: Record<number, string> = {
    401: '请检查 API Key',
    403: '当前应用或用户没有访问权限',
    404: '请检查接口地址、音色 ID 及私人音色的用户 ID',
    408: '服务超时，请稍后重试',
    422: '合成参数无效，请检查音色和参数范围',
    429: '请求过于频繁或并发受限，请稍后重试',
    504: '服务超时，请稍后重试',
  }
  throw new Error(
    `蓝云 TTS 请求失败（HTTP ${response.status}），${tips[response.status] ?? '服务暂不可用，请稍后重试'}`,
  )
}

/** 有界读取蓝云 JSON，避免异常响应和解析错误泄露服务端原文。 */
async function readLanyunJson(response: Response): Promise<Record<string, unknown>> {
  await checkLanyunResponse(response)
  const data = await readLimited(response, 1024 * 1024)
  try {
    const value = JSON.parse(Buffer.from(data).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value
  } catch {
    throw new Error('蓝云 TTS 返回了无效的 JSON 响应')
  }
}

/** 校验 MP3 的首个音频帧，兼容带 ID3 标签及直接以音频帧开头的文件。 */
function isMp3(bytes: Buffer): boolean {
  let offset = 0
  if (bytes.toString('ascii', 0, 3) === 'ID3') {
    if (bytes.length < 10 || ![2, 3, 4].includes(bytes[3])) return false
    if ([...bytes.subarray(6, 10)].some(value => value & 0x80)) return false
    offset = 10 + (bytes[6] << 21) + (bytes[7] << 14) + (bytes[8] << 7) + bytes[9]
    if (bytes[3] === 4 && bytes[5] & 0x10) offset += 10
  }
  if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0)
    return false
  const version = (bytes[offset + 1] >> 3) & 3
  const layer = (bytes[offset + 1] >> 1) & 3
  const bitrateIndex = bytes[offset + 2] >> 4
  const sampleIndex = (bytes[offset + 2] >> 2) & 3
  if (
    version === 1 ||
    layer !== 1 ||
    bitrateIndex === 0 ||
    bitrateIndex === 15 ||
    sampleIndex === 3
  )
    return false
  const rates =
    version === 3
      ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  const sampleRate =
    [44100, 48000, 32000][sampleIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4)
  const frameLength =
    Math.floor(((version === 3 ? 144000 : 72000) * rates[bitrateIndex]) / sampleRate) +
    ((bytes[offset + 2] >> 1) & 1)
  return offset + frameLength <= bytes.length
}

/** 获取当前应用及用户可见的音色目录，保持真实 voice_id，不使用业务包装 ID。 */
export async function listLanyunVoices(
  settings: TtsSettings,
  apiKey: string,
  signal: AbortSignal,
): Promise<TtsVoice[]> {
  if (settings.provider !== 'lanyun') throw new Error('当前厂商不支持获取音色列表')
  validateTtsSettings(settings, false)
  signal.throwIfAborted()
  const response = await fetch(`${settings.baseURL.replace(/\/+$/, '')}/api/v1/voices`, {
    headers: lanyunHeaders(settings, apiKey),
    signal,
    redirect: 'error',
  })
  const data = await readLanyunJson(response)
  if (!Array.isArray(data.voices)) throw new Error('蓝云未返回有效的音色列表')
  const voices = new Map<string, TtsVoice>()
  for (const voice of data.voices) {
    if (
      !voice ||
      typeof voice.voice_id !== 'string' ||
      !voice.voice_id.trim() ||
      voice.voice_id.length > 64 ||
      voice.api_visible === false
    )
      continue
    voices.set(voice.voice_id, {
      id: voice.voice_id,
      name:
        typeof voice.name === 'string' && voice.name.trim()
          ? voice.name.slice(0, 200)
          : voice.voice_id,
      isPrivate: voice.visibility === 'private',
    })
  }
  signal.throwIfAborted()
  return [...voices.values()]
}

/** 上传参考录音并保存为当前蓝云应用与用户可复用的私人音色。 */
export async function uploadLanyunVoice(
  name: string,
  fileName: string,
  audio: Uint8Array,
  settings: TtsSettings,
  apiKey: string,
  signal: AbortSignal,
): Promise<TtsVoice> {
  if (settings.provider !== 'lanyun') throw new Error('当前厂商不支持音色克隆上传')
  validateTtsSettings(settings, false)
  if (!settings.userId?.trim()) throw new Error('请先填写蓝云用户 ID，以保存私人音色')
  if (!name.trim() || name.trim().length > 80) throw new Error('音色名称需为 1 到 80 个字符')
  validateCloneAudio(fileName, audio)
  signal.throwIfAborted()
  const form = new FormData()
  form.set('name', name.trim())
  form.set('audio', new Blob([Uint8Array.from(audio)]), fileName)
  form.set('gender', 'unknown')
  form.set('category', 'custom')
  const response = await fetch(`${settings.baseURL.replace(/\/+$/, '')}/api/v1/user/voices`, {
    method: 'POST',
    headers: lanyunHeaders(settings, apiKey),
    body: form,
    signal,
    redirect: 'error',
  })
  if (response.status === 413 || response.status === 422) {
    await response.body?.cancel().catch(() => {})
    throw new Error(
      response.status === 413
        ? '蓝云拒绝该文件：音频过大，请压缩后重新上传'
        : '蓝云未接受录音格式或参数，请检查音频后重新上传',
    )
  }
  const result = await readLanyunJson(response)
  signal.throwIfAborted()
  if (typeof result.voice_id !== 'string' || !result.voice_id.trim() || result.voice_id.length > 64)
    throw new Error('蓝云未返回有效的私人音色 ID')
  return {
    id: result.voice_id,
    name: typeof result.name === 'string' && result.name.trim() ? result.name : name.trim(),
    isPrivate: true,
  }
}

export class LanyunTtsProvider implements TtsProvider {
  /** 原生接口同步合成后下载录音；下载仅允许同源且禁止重定向，避免泄露鉴权头。 */
  async synthesize(
    text: string,
    settings: TtsSettings,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<SpeechAudio> {
    const baseURL = validateTtsSettings(settings)
    if (!text.trim() || text.length > 5000) throw new Error('蓝云合成文本需为 1 到 5000 个字符')
    signal.throwIfAborted()
    const headers = lanyunHeaders(settings, apiKey)
    headers.set('Content-Type', 'application/json')
    const response = await fetch(`${settings.baseURL.replace(/\/+$/, '')}/api/v1/tts/synthesize`, {
      method: 'POST',
      headers,
      signal,
      redirect: 'error',
      body: JSON.stringify({
        text,
        [settings.voiceIdType ?? 'voice_id']: settings.voice.trim(),
        lang: settings.language ?? 'ZH',
        speech_rate: settings.speechRate ?? 1,
        loudness_rate: 1,
        duration_factor: 1,
        interval_silence: settings.intervalSilence ?? 120,
        use_random: false,
        use_emo_text: Boolean(settings.instructions.trim()),
        ...(settings.instructions.trim()
          ? { emo_text: settings.instructions.trim(), emo_alpha: 1 }
          : {}),
      }),
    })
    const data = await readLanyunJson(response)
    if (typeof data.audio_url !== 'string' || !data.audio_url.trim())
      throw new Error('蓝云未返回合成音频地址')
    let audioURL: URL
    try {
      audioURL = new URL(data.audio_url, `${baseURL.href.replace(/\/+$/, '')}/`)
    } catch {
      throw new Error('蓝云返回的音频地址无效')
    }
    if (
      audioURL.origin !== baseURL.origin ||
      audioURL.username ||
      audioURL.password ||
      audioURL.hash
    ) {
      throw new Error('蓝云音频下载地址必须与 API 同源且不含凭据或锚点')
    }
    signal.throwIfAborted()
    const download = await fetch(audioURL, {
      headers: lanyunHeaders(settings, apiKey),
      signal,
      redirect: 'error',
    })
    await checkLanyunResponse(download)
    const audio = Buffer.from(await readLimited(download, MAX_AUDIO_BYTES))
    signal.throwIfAborted()
    if (audio.toString('ascii', 0, 4) === 'RIFF') {
      assertWav(audio)
      return { base64: audio.toString('base64'), mimeType: 'audio/wav' }
    }
    if (isMp3(audio)) return { base64: audio.toString('base64'), mimeType: 'audio/mpeg' }
    throw new Error('蓝云未返回有效的 WAV 或 MP3 音频')
  }
}

export const ttsProviders: Record<TtsProviderId, TtsProvider> = {
  mimo: new MimoTtsProvider(),
  lanyun: new LanyunTtsProvider(),
  qwen: new QwenTtsProvider(),
  'openai-compatible': new OpenAICompatibleTtsProvider(),
}
