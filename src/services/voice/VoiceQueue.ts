export interface VoiceQueueState {
  running: boolean
  paused: boolean
  phase: 'idle' | 'synthesizing' | 'playing' | 'waiting' | 'paused' | 'error'
  currentText: string
  pending: number
  remainingCharacters: number
  buffered: number
  lastSynthesisMs: number
  error: string
}

export interface VoiceQueueDriver<Audio> {
  synthesize(text: string, signal: AbortSignal): Promise<Audio>
  play(audio: Audio, signal: AbortSignal): Promise<void>
  onChange(state: VoiceQueueState): void
}

type PreparedResult<Audio> = { audio: Audio } | { error: unknown }
interface PreparedAudio<Audio> {
  status: 'queued' | 'synthesizing' | 'ready' | 'error'
  result: Promise<PreparedResult<Audio>>
  settle(result: PreparedResult<Audio>): void
}
interface QueueEntry {
  text: string
  source: 'reply' | 'opening' | 'continuation' | 'loop'
}

/** 可取消的句间停顿，不留下计时器或中止监听器。 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    /** 清除停顿计时器并结束本次等待。 */
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      resolve()
    }
    /** 停止队列时立即取消停顿。 */
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** 单通道播放器配合两路合成，提前准备后两句；回复优先，停止取消全部预取。 */
export class VoiceQueue<Audio> {
  private controller = new AbortController()
  private generation = 0
  private processing = false
  private replies: string[] = []
  private opening: string[] = []
  private continuations: string[] = []
  private loop: string[] = []
  private loopIndex = 0
  private gapMs = 150
  private current?: QueueEntry
  private prepared = new Map<string, PreparedAudio<Audio>>()
  private retainedPreload = new Set<string>()
  private synthesizing = 0
  private wake?: () => void
  private state: VoiceQueueState = {
    running: false,
    paused: false,
    phase: 'idle',
    currentText: '',
    pending: 0,
    remainingCharacters: 0,
    buffered: 0,
    lastSynthesisMs: 0,
    error: '',
  }

  /** 通过驱动注入合成和播放实现，方便离线验证时序。 */
  constructor(private driver: VoiceQueueDriver<Audio>) {}

  /** 返回运行状态快照，避免调用方修改内部状态。 */
  getState(): VoiceQueueState {
    return { ...this.state }
  }

  /** 开启新会话，清空上一次的播放、合成和回复。 */
  start(
    opening: string[],
    loop: string[] = [],
    gapMs = 150,
    preloaded = new Map<string, Audio>(),
  ): void {
    this.stop()
    this.controller = new AbortController()
    this.opening = [...opening]
    this.loop = [...loop]
    this.loopIndex = 0
    this.gapMs = Math.max(0, Math.min(30_000, gapMs))
    for (const [text, audio] of preloaded) {
      const task = this.createTask()
      task.status = 'ready'
      task.settle({ audio })
      this.prepared.set(text, task)
      this.retainedPreload.add(text)
    }
    this.publish({ running: true, error: '' })
    void this.drain()
  }

  /** 在当前句子结束后优先播报回复；限制积压，避免长时间播报过期答案。 */
  enqueue(sentences: string[]): void {
    if (!this.state.running) throw new Error('请先开始语音播报')
    if (this.replies.length + sentences.length > 30) throw new Error('语音回复队列已满，请稍后再试')
    this.replies.push(...sentences)
    this.publish({})
    this.prepareAhead()
    this.wake?.()
    void this.drain()
  }

  /** 添加实时生成的新段落，排在原稿之后、回复之前，并在空队列时恢复播放。 */
  supply(sentences: string[]): void {
    if (!this.state.running || !sentences.length) return
    this.continuations.push(...sentences)
    this.publish({})
    this.prepareAhead()
    this.wake?.()
    void this.drain()
  }

  /** 请求句末暂停，暂停后不新增预取，恢复时继续使用已准备的音频。 */
  setPaused(paused: boolean): void {
    if (!this.state.running) return
    this.publish({ paused })
    this.wake?.()
    if (!paused) {
      this.prepareAhead()
      void this.drain()
    }
  }

  /** 立即停止播放和全部预合成，释放等待者，旧会话结果不能写回新队列。 */
  stop(): void {
    this.generation++
    this.controller.abort()
    for (const task of this.prepared.values()) task.settle({ error: new Error('播放已停止') })
    this.prepared.clear()
    this.retainedPreload.clear()
    this.synthesizing = 0
    this.current = undefined
    this.wake?.()
    this.wake = undefined
    this.processing = false
    this.replies = []
    this.opening = []
    this.continuations = []
    this.loop = []
    this.publish({
      running: false,
      paused: false,
      phase: 'idle',
      currentText: '',
      error: '',
      lastSynthesisMs: 0,
    })
  }

  /** 只查看未来两句，不消耗开场、回复或循环位置。 */
  private upcoming(): string[] {
    const next = [
      ...this.replies.slice(0, 2),
      ...this.opening.slice(0, 2),
      ...this.continuations.slice(0, 2),
    ].slice(0, 2)
    for (let offset = 0; next.length < 2 && this.loop.length; offset++)
      next.push(this.loop[(this.loopIndex + offset) % this.loop.length])
    return next
  }

  /** 取出下一句，优先回复；只有这一处推进播放位置。 */
  private takeNext(): QueueEntry | undefined {
    const reply = this.replies.shift()
    if (reply !== undefined) return { text: reply, source: 'reply' }
    const opening = this.opening.shift()
    if (opening !== undefined) return { text: opening, source: 'opening' }
    const continuation = this.continuations.shift()
    if (continuation !== undefined) return { text: continuation, source: 'continuation' }
    if (this.loop.length)
      return { text: this.loop[this.loopIndex++ % this.loop.length], source: 'loop' }
    return undefined
  }

  /** 尚未播放时退回原位置，让暂停或新到达的回复不会丢失预取话术。 */
  private putBack(entry: QueueEntry): void {
    if (entry.source === 'reply') this.replies.unshift(entry.text)
    else if (entry.source === 'opening') this.opening.unshift(entry.text)
    else if (entry.source === 'continuation') this.continuations.unshift(entry.text)
    else this.loopIndex--
  }

  /** 更新剩余句数和预备音频数；未来句子合成时仍显示当前句正在播放。 */
  private publish(patch: Partial<VoiceQueueState>): void {
    this.state = {
      ...this.state,
      ...patch,
      pending: this.replies.length + this.opening.length + this.continuations.length,
      remainingCharacters:
        [...this.opening, ...this.continuations].reduce((total, text) => total + text.length, 0) +
        (this.current && this.current.source !== 'reply' ? this.current.text.length : 0),
      buffered: this.upcoming().filter(text => this.prepared.get(text)?.status === 'ready').length,
    }
    this.driver.onChange(this.getState())
  }

  /** 创建不会产生未处理拒绝的合成槽；错误在该句实际轮到播放时呈现。 */
  private createTask(): PreparedAudio<Audio> {
    let settle!: PreparedAudio<Audio>['settle']
    const result = new Promise<PreparedResult<Audio>>(resolve => {
      settle = resolve
    })
    return { status: 'queued', result, settle }
  }

  /** 保留当前句和后两句，最多同时合成两句；同文共享音频，回复优先抢下一空闲槽。 */
  private prepareAhead(): void {
    if (!this.state.running || this.state.paused) return
    const priority = [
      ...new Set([...(this.current ? [this.current.text] : []), ...this.upcoming()]),
    ]
    const wanted = new Set(priority)
    for (const [text, task] of this.prepared) {
      if (!wanted.has(text) && task.status !== 'synthesizing' && !this.retainedPreload.has(text))
        this.prepared.delete(text)
    }
    for (const text of priority) {
      if (!this.prepared.has(text)) this.prepared.set(text, this.createTask())
    }
    for (const text of priority) {
      if (this.synthesizing >= 2) break
      const task = this.prepared.get(text)
      if (task?.status !== 'queued') continue
      task.status = 'synthesizing'
      this.synthesizing++
      void this.synthesizeTask(text, task, this.generation, this.controller.signal)
    }
  }

  /** 后台合成完成后补齐有限窗口，始终用会话版本隔离迟到结果。 */
  private async synthesizeTask(
    text: string,
    task: PreparedAudio<Audio>,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const start = performance.now()
    try {
      const audio = await this.driver.synthesize(text, signal)
      if (generation !== this.generation || signal.aborted) return
      task.status = 'ready'
      task.settle({ audio })
    } catch (error) {
      if (generation !== this.generation || signal.aborted) return
      task.status = 'error'
      task.settle({ error })
    } finally {
      if (generation === this.generation && !signal.aborted) {
        this.synthesizing--
        this.publish({ lastSynthesisMs: Math.round(performance.now() - start) })
        this.prepareAhead()
      }
    }
  }

  /** 播放始终串行；合成在后台重叠执行，句末优先插播回复，失败停止全部预取。 */
  private async drain(): Promise<void> {
    if (this.processing || !this.state.running) return
    this.processing = true
    const generation = this.generation
    const signal = this.controller.signal
    try {
      while (!signal.aborted && generation === this.generation) {
        if (this.state.paused) {
          this.publish({ phase: 'paused' })
          await new Promise<void>(resolve => {
            this.wake = resolve
          })
          if (generation !== this.generation) break
          this.wake = undefined
          continue
        }
        const entry = this.takeNext()
        this.current = entry
        if (!entry) {
          this.prepareAhead()
          this.publish({ phase: 'idle', currentText: '' })
          break
        }
        this.prepareAhead()
        const task = this.prepared.get(entry.text)
        if (!task) throw new Error('语音预备队列状态异常，请重新开始播报')
        this.publish({
          phase: task.status === 'ready' ? 'playing' : 'synthesizing',
          currentText: entry.text,
        })
        const result = await task.result
        if (signal.aborted || generation !== this.generation) break
        if (this.state.paused || (entry.source !== 'reply' && this.replies.length)) {
          this.putBack(entry)
          this.current = undefined
          continue
        }
        if ('error' in result) throw result.error
        this.publish({ phase: 'playing' })
        await this.driver.play(result.audio, signal)
        if (signal.aborted || generation !== this.generation) break
        this.retainedPreload.delete(entry.text)
        this.current = undefined
        this.prepareAhead()
        this.publish({ phase: 'waiting', currentText: '' })
        await delay(this.gapMs, signal)
      }
    } catch (error) {
      if (!signal.aborted && generation === this.generation) {
        const message = error instanceof Error ? error.message : '语音播报失败'
        this.stop()
        this.publish({ phase: 'error', error: message })
      }
    } finally {
      if (generation === this.generation) this.processing = false
    }
  }
}
