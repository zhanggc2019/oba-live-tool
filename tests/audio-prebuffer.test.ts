import assert from 'node:assert/strict'
import { test } from 'node:test'
import { playbackDuration } from '../src/services/voice/audioDuration'
import { prepareAudioBuffer } from '../src/services/voice/audioPrebuffer'
import { VoiceQueue } from '../src/services/voice/VoiceQueue'

/** 生成指定时长的极小 WAV 测试数据，验证预备量按真实时长计算。 */
function wav(seconds: number): string {
  const bytes = Buffer.alloc(44 + seconds * 8000)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(8000, 24)
  bytes.writeUInt32LE(8000, 28)
  bytes.writeUInt16LE(1, 32)
  bytes.writeUInt16LE(8, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(seconds * 8000, 40)
  return bytes.toString('base64')
}

test('30 秒预备按音频实际播放时长累计，不足时获取新文案', async () => {
  const synthesized: string[] = []
  const progress: number[] = []
  let more = 0
  const result = await prepareAudioBuffer(
    ['开场', '首段'],
    30,
    {
      synthesize: async text => {
        synthesized.push(text)
        return { base64: wav(10), mimeType: 'audio/wav' as const, playbackRate: 1 }
      },
      duration: (audio, _text, signal) => playbackDuration(audio, signal),
      requestMore: async () => {
        more++
        return ['续稿第一句']
      },
      onProgress: seconds => progress.push(seconds),
    },
    new AbortController().signal,
  )
  assert.equal(result.durationSeconds, 30)
  assert.deepEqual(progress, [10, 20, 30])
  assert.deepEqual(synthesized, ['开场', '首段', '续稿第一句'])
  assert.equal(more, 1)
  assert.equal(result.audio.size, 3)
})

test('播放倍率计入预备时长；准备取消后不会继续获取后续文案', async () => {
  const signal = new AbortController()
  const seconds = await playbackDuration(
    { base64: wav(10), mimeType: 'audio/wav', playbackRate: 2 },
    signal.signal,
  )
  assert.equal(seconds, 5)
  let more = 0
  await assert.rejects(
    prepareAudioBuffer(
      ['首句'],
      30,
      {
        synthesize: async () => {
          signal.abort()
          return { base64: wav(10), mimeType: 'audio/wav', playbackRate: 1 }
        },
        duration: async () => 10,
        requestMore: async () => {
          more++
          return []
        },
        onProgress: () => {},
      },
      signal.signal,
    ),
  )
  assert.equal(more, 0)
})

test('已预备音频交给播放队列，不重新请求同一句 TTS', async () => {
  const played: string[] = []
  let syntheses = 0
  const queue = new VoiceQueue<string>({
    synthesize: async text => {
      syntheses++
      return text
    },
    play: async text => {
      played.push(text)
    },
    onChange: () => {},
  })
  queue.start(
    ['甲', '乙', '丙'],
    [],
    0,
    new Map([
      ['甲', '甲'],
      ['乙', '乙'],
      ['丙', '丙'],
    ]),
  )
  const start = Date.now()
  while (played.length < 3 && Date.now() - start < 1000)
    await new Promise(resolve => setTimeout(resolve, 2))
  assert.deepEqual(played, ['甲', '乙', '丙'])
  assert.equal(syntheses, 0)
  queue.stop()
})
