import { IPC_CHANNELS } from 'shared/ipcChannels'
import {
  type ContinuationScriptRequest,
  findScriptTopicConflict,
  type LiveScriptResult,
} from 'shared/liveScript'
import { prepareSpeechPacing, type SpeechPacingPlan } from 'shared/speechPacing'
import { type SpeechAudio, splitSpeechText } from 'shared/voice'
import { create } from 'zustand'
import { useAIProviderStore } from '@/hooks/useAIProvider'
import { getVoiceConfig, type VoiceConfig } from '@/hooks/useVoiceConfig'
import { EVENTS, eventEmitter } from '@/utils/events'
import { playbackDuration } from './audioDuration'
import { prepareAudioBuffer } from './audioPrebuffer'
import { ContinuousScriptController, type ContinuousScriptState } from './continuousScript'
import { VoiceQueue, type VoiceQueueState } from './VoiceQueue'

interface VoiceRuntimeState extends VoiceQueueState {
  accountId: string | null
  mode: 'live' | 'local' | 'preview'
  currentRate: number | null
  rateReason: string
  continuation: ContinuousScriptState
  preparing: boolean
  preparedSeconds: number
  preparationTargetSeconds: number
  preparationError: string
  activeScriptId: string | null
  activeScriptTitle: string
}

interface PreparedSpeech extends SpeechAudio, SpeechPacingPlan {
  playbackRate: number
}

export const useVoiceRuntime = create<VoiceRuntimeState>(() => ({
  accountId: null,
  mode: 'preview',
  currentRate: null,
  rateReason: '',
  continuation: { status: 'idle', theme: '', generatedSegments: 0, error: '' },
  preparing: false,
  preparedSeconds: 0,
  preparationTargetSeconds: 30,
  preparationError: '',
  activeScriptId: null,
  activeScriptTitle: '',
  running: false,
  paused: false,
  phase: 'idle',
  currentText: '',
  pending: 0,
  remainingCharacters: 0,
  buffered: 0,
  lastSynthesisMs: 0,
  error: '',
}))

let sessionConfig: VoiceConfig
let sessionId = 0
let preparationController: AbortController | null = null
let stagingSentences: string[] | null = null
let startingQueue = false

/** 将主进程音频交给独立 Audio 元素，输出到指定设备并在停止时释放资源。 */
async function playAudio(data: PreparedSpeech, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const bytes = Uint8Array.from(atob(data.base64), char => char.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: data.mimeType }))
  const audio = new Audio(url)
  audio.volume = Math.min(1, Math.max(0, sessionConfig.volume))
  // 蓝云已经在合成阶段调速；其他厂商只在播放器调速，避免双重倍率。
  audio.preservesPitch = true
  audio.playbackRate = data.playbackRate
  useVoiceRuntime.setState({ currentRate: data.rate, rateReason: data.reason })
  try {
    if (sessionConfig.outputDeviceId !== 'default') {
      if (!audio.setSinkId) throw new Error('当前环境无法选择音频输出设备')
      try {
        await audio.setSinkId(sessionConfig.outputDeviceId)
      } catch {
        throw new Error('输出设备不可用，请重新选择声卡后开始播报')
      }
    }
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      /** 播放完成、失败或取消后统一清理事件和超时。 */
      const finish = (error?: Error) => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
        audio.onended = null
        audio.onerror = null
        audio.pause()
        error ? reject(error) : resolve()
      }
      /** 中止当前音频，不允许停止之后继续播放。 */
      const abort = () => finish(new Error('播放已停止'))
      const timeout = setTimeout(() => finish(new Error('音频播放超时，请检查输出设备')), 180_000)
      signal.addEventListener('abort', abort, { once: true })
      audio.onended = () => finish()
      audio.onerror = () => finish(new Error('无法解码或播放 TTS 音频'))
      audio.play().catch(() => finish(new Error('音频播放失败，请检查输出设备并手动重试')))
    })
  } finally {
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    URL.revokeObjectURL(url)
  }
}

/** 合成请求使用独立 ID，停止会话时同步取消主进程中的网络请求。 */
async function synthesizeSpeech(text: string, signal: AbortSignal): Promise<PreparedSpeech> {
  signal.throwIfAborted()
  const plan = prepareSpeechPacing(
    text,
    sessionConfig.providers[sessionConfig.provider],
    sessionConfig.speechPacing,
    sessionConfig.scriptRequirements,
  )
  const requestId = crypto.randomUUID()
  const cancel = () => {
    void window.ipcRenderer.invoke(IPC_CHANNELS.tts.cancel, requestId).catch(() => {})
  }
  const request = window.ipcRenderer.invoke(IPC_CHANNELS.tts.synthesize, {
    requestId,
    text,
    settings: plan.synthesisSettings,
  })
  signal.addEventListener('abort', cancel, { once: true })
  try {
    return {
      ...(await request),
      rate: plan.rate,
      reason: plan.reason,
      playbackRate: plan.playbackRate,
    }
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

const queue = new VoiceQueue<PreparedSpeech>({
  synthesize: synthesizeSpeech,
  play: playAudio,
  /** 播放状态保存在全局 store，切换页面不会中断播报。 */
  onChange: state => {
    useVoiceRuntime.setState({
      ...state,
      ...(state.phase !== 'playing' ? { currentRate: null, rateReason: '' } : {}),
    })
    if (!startingQueue) continuation.observe(state.running, state.paused, state.remainingCharacters)
  },
})

const continuation = new ContinuousScriptController({
  /** 续稿复用可取消的文本模型请求；停止会话会同步通知主进程。 */
  async generate(
    request: ContinuationScriptRequest,
    signal: AbortSignal,
  ): Promise<LiveScriptResult> {
    signal.throwIfAborted()
    const cancel = () => {
      void window.ipcRenderer
        .invoke(IPC_CHANNELS.liveScript.cancel, request.requestId)
        .catch(() => {})
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      return await window.ipcRenderer.invoke(IPC_CHANNELS.liveScript.generate, request)
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  },
  /** 新文案排在原稿后面，由同一个队列按句预合成并串行播放。 */
  onText: text => {
    const sentences = splitSpeechText(text)
    if (stagingSentences) stagingSentences.push(...sentences)
    else queue.supply(sentences)
  },
  /** 独立展示供稿状态，不覆盖 TTS 合成或播放错误。 */
  onState: state => useVoiceRuntime.setState({ continuation: state }),
})

/** 启动完整话术播报；本地试听无需中控台，直播模式允许等待 AI 回复。 */
export function startVoiceSession(accountId: string, mode: 'live' | 'local' = 'live'): void {
  const active = useVoiceRuntime.getState()
  if ((active.running || active.preparing) && active.accountId !== accountId)
    throw new Error('另一个账号正在播报，请先停止它的语音会话')
  const config = getVoiceConfig(accountId)
  const opening = splitSpeechText(config.openingScript)
  const selectedScript = config.savedScripts.find(script => script.id === config.selectedScriptId)
  if (!selectedScript) throw new Error('请先选择一份已保存话术')
  const conflict = findScriptTopicConflict(selectedScript, config.savedScripts)
  if (conflict)
    throw new Error(
      `《${selectedScript.title}》的正文仍是《${conflict.title}》相关内容，请先在编辑区修改并保存`,
    )
  const seedScript = selectedScript.content
  const seed = splitSpeechText(seedScript)
  if (!seed.length) throw new Error('所选话术正文为空，请先在编辑区保存正文')
  const ai = useAIProviderStore.getState().chat
  const apiKey = ai.apiKeys[ai.config.provider]
  if (!apiKey?.trim() || !ai.config.model?.trim())
    throw new Error('持续供稿需要先配置 AI 助手的文本模型与 API Key')
  preparationController?.abort()
  preparationController = new AbortController()
  const signal = preparationController.signal
  continuation.stop()
  sessionId++
  const currentSession = sessionId
  sessionConfig = { ...config, scriptRequirements: selectedScript.scriptRequirements ?? '' }
  queue.stop()
  stagingSentences = []
  useVoiceRuntime.setState({
    accountId,
    mode,
    preparing: config.prebufferSeconds > 0,
    preparedSeconds: 0,
    preparationTargetSeconds: config.prebufferSeconds,
    preparationError: '',
    activeScriptId: selectedScript.id,
    activeScriptTitle: selectedScript.title,
  })
  continuation.start({
    accountId,
    seedScript,
    productIntro: selectedScript.productIntro ?? '',
    referenceText: selectedScript.referenceText ?? '',
    requirements: selectedScript.scriptRequirements ?? '',
    provider: ai.config.provider,
    model: ai.config.model,
    apiKey,
    customBaseURL: ai.customBaseURL,
  })
  /** 准备足够可播放音频后再启动队列，迟到的结果不得复活已停止的会话。 */
  const begin = async () => {
    try {
      const prepared = await prepareAudioBuffer(
        [...opening, ...seed],
        config.prebufferSeconds,
        {
          synthesize: synthesizeSpeech,
          duration: audio => playbackDuration(audio, signal),
          /** 底稿很短时继续生成文案，直到可播放的音频覆盖预备时长。 */
          async requestMore() {
            await continuation.prepareNext()
            const more = stagingSentences ?? []
            stagingSentences = []
            return more
          },
          onProgress: seconds => {
            if (currentSession === sessionId) useVoiceRuntime.setState({ preparedSeconds: seconds })
          },
        },
        signal,
      )
      if (signal.aborted || currentSession !== sessionId) return
      stagingSentences = null
      startingQueue = true
      try {
        queue.start(prepared.sentences, [], config.gapMs, prepared.audio)
      } finally {
        startingQueue = false
      }
      preparationController = null
      useVoiceRuntime.setState({ preparing: false })
      const state = queue.getState()
      continuation.observe(state.running, state.paused, state.remainingCharacters)
    } catch (error) {
      if (signal.aborted || currentSession !== sessionId) return
      stagingSentences = null
      preparationController = null
      continuation.stop()
      useVoiceRuntime.setState({
        preparing: false,
        preparationError: error instanceof Error ? error.message : '语音准备失败',
      })
    }
  }
  void begin()
}

/** 停止指定账号或全部语音，并使尚未完成的 AI 回复失效。 */
export function stopVoiceSession(accountId?: string): void {
  if (accountId && useVoiceRuntime.getState().accountId !== accountId) return
  sessionId++
  preparationController?.abort()
  preparationController = null
  stagingSentences = null
  continuation.stop()
  queue.stop()
  useVoiceRuntime.setState({
    accountId: null,
    preparing: false,
    preparedSeconds: 0,
    preparationError: '',
    activeScriptId: null,
    activeScriptTitle: '',
  })
}

/** 中控台和自动回复状态只停止关联的直播播报，不影响独立本地试听。 */
export function stopLiveVoiceSession(accountId: string): void {
  if (useVoiceRuntime.getState().mode === 'live') stopVoiceSession(accountId)
}

/** 返回当前语音会话标识，供异步 AI 回复检查是否仍属于本次直播。 */
export function getVoiceSessionToken(accountId: string): number | null {
  const state = useVoiceRuntime.getState()
  return state.running && state.mode === 'live' && state.accountId === accountId ? sessionId : null
}

/** AI 回复仅能加入它生成时所属的有效语音会话。 */
export function enqueueVoiceReply(
  accountId: string,
  text: string,
  token: number | null = getVoiceSessionToken(accountId),
): void {
  if (token === null || token !== getVoiceSessionToken(accountId)) return
  queue.enqueue(splitSpeechText(text))
}

/** 单句试听复用完整播报的队列，不中断已有讲解或产生重叠声音。 */
export function previewVoice(accountId: string, text: string): void {
  const sentences = splitSpeechText(text)
  if (!sentences.length) throw new Error('请先填写要试听的文字')
  const state = useVoiceRuntime.getState()
  if (state.preparing) {
    if (state.accountId !== accountId) throw new Error('另一个账号正在准备播报，请先取消')
    throw new Error('正在准备开播语音，请先取消准备')
  }
  if (state.running && state.mode !== 'preview') {
    if (state.accountId !== accountId) throw new Error('另一个账号正在播报，请先停止语音')
    queue.enqueue(sentences)
    return
  }
  sessionId++
  continuation.stop()
  sessionConfig = getVoiceConfig(accountId)
  useVoiceRuntime.setState({
    accountId,
    mode: 'preview',
    preparationError: '',
    activeScriptId: null,
    activeScriptTitle: '',
  })
  queue.start(sentences, [], sessionConfig.gapMs)
}

/** 暂停会在本句播放结束后生效，恢复时按原有顺序继续。 */
export function pauseVoiceSession(paused: boolean): void {
  queue.setPaused(paused)
}

eventEmitter.on(EVENTS.ACCOUNT_REMOVED, (accountId: string) => stopVoiceSession(accountId))
