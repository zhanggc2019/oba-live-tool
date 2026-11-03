export const MAX_CLONE_AUDIO_BYTES = 10 * 1024 * 1024
export const CLONE_AUDIO_EXTENSIONS = ['wav', 'mp3', 'ogg', 'm4a', 'aac'] as const

/** 跳过可选 ID3 标签并检查完整 MP3 首帧，防止纯文本伪造音频文件。 */
function hasMp3Frame(audio: Uint8Array): boolean {
  let offset = 0
  if (String.fromCharCode(...audio.slice(0, 3)) === 'ID3') {
    if (audio.length < 10 || ![2, 3, 4].includes(audio[3])) return false
    if ([...audio.slice(6, 10)].some(value => value & 0x80)) return false
    offset = 10 + (audio[6] << 21) + (audio[7] << 14) + (audio[8] << 7) + audio[9]
  }
  if (offset + 4 > audio.length || audio[offset] !== 0xff || (audio[offset + 1] & 0xe0) !== 0xe0)
    return false
  const version = (audio[offset + 1] >> 3) & 3
  const layer = (audio[offset + 1] >> 1) & 3
  const bitrateIndex = audio[offset + 2] >> 4
  const sampleIndex = (audio[offset + 2] >> 2) & 3
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
    ((audio[offset + 2] >> 1) & 1)
  return offset + frameLength <= audio.length
}

/** 校验上传文件后缀与内容标识，拒绝空文件、超限文件和伪装成音频的文件。 */
export function validateCloneAudio(fileName: string, audio: Uint8Array): void {
  if (!(audio instanceof Uint8Array)) throw new Error('请选择要克隆的音频文件')
  if (!audio.length) throw new Error('音频文件为空，请重新上传')
  if (audio.length > MAX_CLONE_AUDIO_BYTES) throw new Error('音频文件超过 10 MiB，请压缩后重新上传')
  const extension = fileName.split('.').at(-1)?.toLowerCase()
  if (
    !extension ||
    !CLONE_AUDIO_EXTENSIONS.includes(extension as (typeof CLONE_AUDIO_EXTENSIONS)[number])
  )
    throw new Error('仅支持 WAV、MP3、OGG、M4A、AAC 音频，请重新上传')
  const ascii = (start: number, end: number) => String.fromCharCode(...audio.slice(start, end))
  const valid =
    extension === 'wav'
      ? audio.length >= 44 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE'
      : extension === 'mp3'
        ? hasMp3Frame(audio)
        : extension === 'ogg'
          ? ascii(0, 4) === 'OggS'
          : extension === 'm4a'
            ? audio.length >= 12 && ascii(4, 8) === 'ftyp'
            : audio.length >= 7 && audio[0] === 0xff && (audio[1] & 0xf6) === 0xf0
  if (!valid) throw new Error('文件内容与音频格式不符，请重新上传有效的音频文件')
}
