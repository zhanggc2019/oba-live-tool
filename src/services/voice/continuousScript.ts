import {
  type ContinuationScriptRequest,
  countScriptCharacters,
  type LiveScriptResult,
} from 'shared/liveScript'
import { splitSpeechText } from 'shared/voice'

export const CONTINUATION_THEMES = [
  '不同使用场景与一天中的具体需求',
  '适合的人群与选择时的判断方法',
  '产品细节及其实际用途',
  '常见疑问与选择建议',
  '日常使用步骤和维护方式',
  '与同类选择相比应关注的要点',
  '围绕观众需求的自然提问与讲解',
  '核心信息回顾和新的生活场景',
] as const

export interface ContinuousScriptConfig {
  accountId: string
  seedScript: string
  productIntro: string
  referenceText: string
  requirements: string
  provider: string
  model: string
  apiKey: string
  customBaseURL?: string
}

export interface ContinuousScriptState {
  status: 'idle' | 'waiting' | 'generating' | 'retrying' | 'error'
  theme: string
  generatedSegments: number
  error: string
}

export interface ContinuousScriptDriver {
  generate(request: ContinuationScriptRequest, signal: AbortSignal): Promise<LiveScriptResult>
  onText(text: string): void
  onState(state: ContinuousScriptState): void
}

/** 只比较足够长的非参数句，拦截模型整段复读，同时允许必要的商品信息重提。 */
function repeatedSentenceShare(text: string, history: string[]): number {
  const known = new Set(
    history
      .flatMap(item => splitSpeechText(item))
      .map(item => item.replace(/[\s，。！？、；,.!?;:：]/gu, ''))
      .filter(item => item.length >= 14 && !/\d|价格|容量|规格|材质/.test(item)),
  )
  const sentences = splitSpeechText(text)
    .map(item => item.replace(/[\s，。！？、；,.!?;:：]/gu, ''))
    .filter(item => item.length >= 14 && !/\d|价格|容量|规格|材质/.test(item))
  if (!sentences.length) return 0
  const seen = new Set<string>()
  let repeated = 0
  for (const sentence of sentences) {
    if (known.has(sentence) || seen.has(sentence)) repeated++
    seen.add(sentence)
  }
  return repeated / sentences.length
}

/** 每段按底稿长度设定字数，控制模型单次生成规模。 */
export function continuationTarget(seedScript: string): number {
  return Math.max(400, Math.min(4000, countScriptCharacters(seedScript)))
}

/** 播放到剩余约半段时开始供稿，短底稿提早启动以留出模型和 TTS 等待时间。 */
export function continuationThreshold(targetCharacters: number): number {
  return targetCharacters <= 1000
    ? targetCharacters
    : Math.max(600, Math.min(1200, Math.round(targetCharacters * 0.48)))
}

/** 管理单场直播的提前供稿、主题轮换、重复检测、有限重试与取消。 */
export class ContinuousScriptController {
  private config: ContinuousScriptConfig | null = null
  private controller = new AbortController()
  private generation = 0
  private generating = false
  private failed = false
  private themeIndex = 0
  private history: string[] = []
  private usedThemes: string[] = []
  private remainingCharacters = 0
  private rearmAtCharacters = Number.POSITIVE_INFINITY
  private paused = false
  private state: ContinuousScriptState = {
    status: 'idle',
    theme: '',
    generatedSegments: 0,
    error: '',
  }

  constructor(private driver: ContinuousScriptDriver) {}

  /** 开始新会话，保留本场底稿快照并丢弃上一场的迟到结果。 */
  start(config: ContinuousScriptConfig): void {
    this.stop()
    this.config = { ...config }
    this.controller = new AbortController()
    this.history = [config.seedScript]
    this.usedThemes = []
    this.themeIndex = 0
    this.rearmAtCharacters = Number.POSITIVE_INFINITY
    this.failed = false
    this.publish({ status: 'waiting', theme: '', generatedSegments: 0, error: '' })
  }

  /** 根据尚未朗读的真实文字量决定是否需要提前生成下一段。 */
  observe(running: boolean, paused: boolean, remainingCharacters: number): void {
    if (!this.config) return
    if (!running) {
      this.stop()
      return
    }
    this.paused = paused
    this.remainingCharacters = remainingCharacters
    if (paused || this.generating || this.failed || remainingCharacters > this.rearmAtCharacters)
      return
    if (remainingCharacters <= continuationThreshold(continuationTarget(this.config.seedScript)))
      void this.generateNext()
  }

  /** 开播预备阶段主动获取一段续稿，用于底稿不足以覆盖预备时长的情况。 */
  async prepareNext(): Promise<void> {
    if (!this.config) throw new Error('续稿会话尚未开始')
    await this.generateNext(true)
    if (this.failed) throw new Error(this.state.error)
  }

  /** 取消模型请求，清除会话历史并让所有迟到结果失效。 */
  stop(): void {
    this.generation++
    this.controller.abort()
    this.config = null
    this.generating = false
    this.failed = false
    this.history = []
    this.publish({ status: 'idle', theme: '', generatedSegments: 0, error: '' })
  }

  /** 广播独立供稿状态，让界面能区分模型等待与 TTS 等待。 */
  private publish(patch: Partial<ContinuousScriptState>): void {
    this.state = { ...this.state, ...patch }
    this.driver.onState({ ...this.state })
  }

  /** 生成新角度的完整段落；失败最多重试两次，成功后由队列按句预合成。 */
  private async generateNext(preparing = false): Promise<void> {
    const config = this.config
    if (!config || this.generating) return
    this.generating = true
    const generation = this.generation
    const signal = this.controller.signal
    let lastError = '续稿失败'
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal.aborted || generation !== this.generation) return
      const theme = CONTINUATION_THEMES[this.themeIndex++ % CONTINUATION_THEMES.length]
      this.publish({ status: attempt ? 'retrying' : 'generating', theme, error: '' })
      const request: ContinuationScriptRequest = {
        mode: 'continuation',
        requestId: crypto.randomUUID(),
        accountId: config.accountId,
        provider: config.provider,
        model: config.model,
        apiKey: config.apiKey,
        customBaseURL: config.customBaseURL,
        productIntro: config.productIntro,
        referenceText: config.referenceText,
        requirements: config.requirements,
        seedScript: config.seedScript,
        targetCharacters: continuationTarget(config.seedScript),
        segmentIndex: this.state.generatedSegments + 1,
        theme,
        recentThemes: this.usedThemes.slice(-6),
        recentSamples: this.history
          .slice(-3)
          .map(text =>
            text.length <= 1000 ? text : `${text.slice(0, 500)}\n…\n${text.slice(-450)}`,
          ),
      }
      try {
        const result = await this.driver.generate(request, signal)
        if (signal.aborted || generation !== this.generation) return
        if (result.cancelled || result.error) throw new Error(result.error || '续稿已取消')
        const text = result.text.trim()
        const minimum = Math.max(220, Math.floor(request.targetCharacters * 0.55))
        if (countScriptCharacters(text) < minimum)
          throw new Error(`续稿字数不足，需至少约 ${minimum} 字`)
        if (repeatedSentenceShare(text, this.history.slice(-3)) > 0.32)
          throw new Error('续稿与近期内容重复过多')
        this.history.push(text)
        this.history = this.history.slice(-3)
        this.usedThemes.push(theme)
        this.usedThemes = this.usedThemes.slice(-12)
        const remainingBeforeSupply = this.remainingCharacters
        this.driver.onText(text)
        this.remainingCharacters = Math.max(
          this.remainingCharacters,
          remainingBeforeSupply + countScriptCharacters(text),
        )
        this.rearmAtCharacters =
          this.remainingCharacters - Math.min(100, Math.round(request.targetCharacters * 0.1))
        this.publish({
          status: 'waiting',
          theme,
          generatedSegments: this.state.generatedSegments + 1,
          error: '',
        })
        this.generating = false
        if (!preparing) this.observe(true, this.paused, this.remainingCharacters)
        return
      } catch (error) {
        if (signal.aborted || generation !== this.generation) return
        lastError = error instanceof Error ? error.message : '续稿失败'
      }
    }
    if (signal.aborted || generation !== this.generation) return
    this.generating = false
    this.failed = true
    this.publish({
      status: 'error',
      error: `续稿失败：${lastError}。请检查文本模型后重新开始播报。`,
    })
  }
}
