import type { SpeechAudio } from 'shared/voice'

/** 从 WAV 头读取数据字节数与平均字节率，避免等待浏览器加载时长。 */
function wavDuration(bytes: Uint8Array): number | null {
  if (bytes.length < 44) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645)
    return null
  let byteRate = 0
  let dataSize = 0
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const size = view.getUint32(offset + 4, true)
    const name = String.fromCharCode(...bytes.slice(offset, offset + 4))
    if (name === 'fmt ' && size >= 16 && offset + 16 <= bytes.length)
      byteRate = view.getUint32(offset + 16, true)
    if (name === 'data') {
      dataSize = Math.min(size, bytes.length - offset - 8)
      break
    }
    offset += 8 + size + (size % 2)
  }
  return byteRate > 0 && dataSize > 0 ? dataSize / byteRate : null
}

/** 用媒体元数据读取压缩音频时长；取消准备时立即释放 URL 与监听器。 */
function browserAudioDuration(
  bytes: Uint8Array,
  mimeType: string,
  signal: AbortSignal,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: mimeType }))
    const audio = new Audio()
    let settled = false
    /** 统一清理浏览器音频元素和计时器。 */
    const finish = (value?: number, error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      audio.onloadedmetadata = null
      audio.onerror = null
      audio.removeAttribute('src')
      audio.load()
      URL.revokeObjectURL(url)
      error ? reject(error) : resolve(value ?? 0)
    }
    /** 中止媒体时长读取。 */
    const abort = () => finish(undefined, new Error('语音准备已取消'))
    const timeout = setTimeout(() => finish(undefined, new Error('无法读取 TTS 音频时长')), 10_000)
    signal.addEventListener('abort', abort, { once: true })
    audio.onloadedmetadata = () => finish(audio.duration)
    audio.onerror = () => finish(undefined, new Error('无法读取 TTS 音频时长'))
    audio.src = url
    audio.load()
    if (signal.aborted) abort()
  })
}

/** 返回实际播放秒数；本地调速会相应缩短或延长时长。 */
export async function playbackDuration(
  audio: SpeechAudio & { playbackRate: number },
  signal: AbortSignal,
): Promise<number> {
  signal.throwIfAborted()
  const bytes = Uint8Array.from(atob(audio.base64), char => char.charCodeAt(0))
  const sourceSeconds =
    audio.mimeType === 'audio/wav'
      ? (wavDuration(bytes) ?? (await browserAudioDuration(bytes, audio.mimeType, signal)))
      : await browserAudioDuration(bytes, audio.mimeType, signal)
  if (!Number.isFinite(sourceSeconds) || sourceSeconds <= 0)
    throw new Error('TTS 返回的音频时长无效')
  return sourceSeconds / Math.max(0.1, audio.playbackRate)
}
