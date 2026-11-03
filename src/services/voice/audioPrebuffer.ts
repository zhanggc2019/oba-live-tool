export interface PreparedAudioBuffer<Audio> {
  sentences: string[]
  audio: Map<string, Audio>
  durationSeconds: number
}

export interface AudioPrebufferDriver<Audio> {
  synthesize(text: string, signal: AbortSignal): Promise<Audio>
  duration(audio: Audio, text: string, signal: AbortSignal): Promise<number>
  requestMore(signal: AbortSignal): Promise<string[]>
  onProgress(seconds: number): void
}

/** 开播前最多同时合成两句，并按实际音频时长累计到目标；底稿不足时先获取新段落。 */
export async function prepareAudioBuffer<Audio>(
  initial: string[],
  targetSeconds: number,
  driver: AudioPrebufferDriver<Audio>,
  signal: AbortSignal,
): Promise<PreparedAudioBuffer<Audio>> {
  const sentences = [...initial]
  const audio = new Map<string, Audio>()
  let durationSeconds = 0
  let position = 0
  while (durationSeconds < targetSeconds) {
    signal.throwIfAborted()
    if (position >= sentences.length) {
      const more = await driver.requestMore(signal)
      signal.throwIfAborted()
      if (!more.length) throw new Error('续稿没有可播报的内容，请检查文本模型')
      sentences.push(...more)
    }
    const batch = sentences.slice(position, position + 2)
    const pending = new Map<string, Promise<Audio>>()
    const prepared = await Promise.all(
      batch.map(async text => {
        const cached = audio.get(text)
        if (cached) return cached
        let task = pending.get(text)
        if (!task) {
          task = driver.synthesize(text, signal)
          pending.set(text, task)
        }
        return task
      }),
    )
    signal.throwIfAborted()
    for (let index = 0; index < batch.length; index++) {
      const text = batch[index]
      const result = prepared[index]
      if (!audio.has(text)) audio.set(text, result)
      durationSeconds += await driver.duration(result, text, signal)
      driver.onProgress(durationSeconds)
    }
    position += batch.length
  }
  return { sentences, audio, durationSeconds }
}
