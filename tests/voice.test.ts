import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MimoTtsProvider,
  OpenAICompatibleTtsProvider,
  validateTtsSettings,
} from '../electron/main/services/tts/providers'
import { splitSpeechText, TTS_PRESETS } from '../shared/voice'
import { VoiceQueue } from '../src/services/voice/VoiceQueue'

/** 等待队列推进到指定阶段，设置上限使死锁能明确失败。 */
async function until(check: () => boolean): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > 2000) throw new Error('队列未在预期时间推进')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** 构造可以由测试主动结束的合成或播放步骤。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

/** 生成最小有效 WAV 容器，用于验证音频协议而非实际发声。 */
function wav(): Buffer {
  const buffer = Buffer.alloc(46)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(38, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(24000, 24)
  buffer.writeUInt32LE(48000, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(2, 40)
  return buffer
}

test('切句保留价格、中文标点与跨行内容，长句按 Unicode 字符拆分', () => {
  assert.deepEqual(splitSpeechText('欢迎！价格是19.9元。\nHello there. Welcome back!'), [
    '欢迎！',
    '价格是19.9元。',
    'Hello there.',
    'Welcome back!',
  ])
  assert.deepEqual(splitSpeechText('  \n!?'), [])
  const chunks = splitSpeechText('商品介绍'.repeat(200))
  assert.ok(chunks.every(chunk => Array.from(chunk).length <= 220))
  assert.equal(chunks.join(''), '商品介绍'.repeat(200))
})

test('回复在完整句子之间优先插播，开场不会重播', async () => {
  const played: string[] = []
  const first = deferred<void>()
  const queue = new VoiceQueue<string>({
    synthesize: async text => text,
    play: async text => {
      played.push(text)
      if (text === '开场一') await first.promise
    },
    onChange: () => {},
  })
  queue.start(['开场一', '开场二'], [], 0)
  await until(() => played.length === 1)
  queue.enqueue(['观众回答'])
  assert.deepEqual(played, ['开场一'])
  first.resolve()
  await until(() => queue.getState().phase === 'idle')
  assert.deepEqual(played, ['开场一', '观众回答', '开场二'])
  queue.stop()
})

test('停止及重新开始后，过期合成结果不再播放', async () => {
  const stale = deferred<string>()
  const played: string[] = []
  const queue = new VoiceQueue<string>({
    synthesize: async text => (text === '旧内容' ? stale.promise : text),
    play: async text => {
      played.push(text)
    },
    onChange: () => {},
  })
  queue.start(['旧内容'], [], 0)
  queue.stop()
  queue.start(['新内容'], [], 0)
  stale.resolve('旧音频')
  await until(() => queue.getState().phase === 'idle')
  assert.deepEqual(played, ['新内容'])
  queue.stop()
})

test('开场一次后进入循环，暂停与恢复保留顺序，停止取消播放', async () => {
  const played: string[] = []
  const first = deferred<void>()
  let aborted = false
  const queue = new VoiceQueue<string>({
    synthesize: async text => text,
    play: async (text, signal) => {
      played.push(text)
      if (text === '开场') await first.promise
      else
        await new Promise<void>(resolve =>
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              resolve()
            },
            { once: true },
          ),
        )
    },
    onChange: () => {},
  })
  queue.start(['开场'], ['循环一', '循环二'], 0)
  await until(() => played.length === 1)
  queue.setPaused(true)
  first.resolve()
  await until(() => queue.getState().phase === 'paused')
  assert.deepEqual(played, ['开场'])
  queue.setPaused(false)
  await until(() => played.length === 2)
  assert.deepEqual(played, ['开场', '循环一'])
  queue.stop()
  assert.equal(aborted, true)
  assert.equal(queue.getState().running, false)
})

test('合成失败停止循环且显示错误，不形成无限重试', async () => {
  let calls = 0
  const queue = new VoiceQueue<string>({
    synthesize: async () => {
      calls++
      throw new Error('额度不足')
    },
    play: async () => assert.fail('失败后不得播放'),
    onChange: () => {},
  })
  queue.start([], ['循环'], 0)
  await until(() => queue.getState().phase === 'error')
  assert.equal(queue.getState().error, '额度不足')
  assert.equal(queue.getState().running, false)
  assert.equal(calls, 1)
})

test('队列限制回复积压，停止后拒绝新增', () => {
  const queue = new VoiceQueue<string>({
    synthesize: async text => text,
    play: async () => {},
    onChange: () => {},
  })
  assert.throws(() => queue.enqueue(['回复']), /先开始/)
  queue.start([])
  queue.setPaused(true)
  queue.enqueue(Array(30).fill('句子'))
  assert.throws(() => queue.enqueue(['过量']), /已满/)
  queue.stop()
})

test('当前句播放期间已完成后两句合成，不提前请求整篇稿件', async () => {
  const first = deferred<void>()
  const calls: string[] = []
  const played: string[] = []
  const queue = new VoiceQueue<string>({
    synthesize: async text => {
      calls.push(text)
      return text
    },
    play: async text => {
      played.push(text)
      if (text === '第一句') await first.promise
    },
    onChange: () => {},
  })
  queue.start(['第一句', '第二句', '第三句', '第四句'], [], 0)
  await until(() => queue.getState().buffered === 2)
  assert.deepEqual(played, ['第一句'])
  assert.deepEqual(calls, ['第一句', '第二句', '第三句'])
  assert.equal(queue.getState().phase, 'playing', '后台预合成不把正在播放的状态改成合成中')
  first.resolve()
  await until(() => queue.getState().phase === 'idle')
  assert.deepEqual(played, ['第一句', '第二句', '第三句', '第四句'])
  assert.equal(calls.filter(text => text === '第二句').length, 1, '播放预备音频不重复调用合成')
  queue.stop()
})

test('最多两路合成，插播获得下一空闲槽，已预取话术不丢失', async () => {
  const gates = new Map<string, ReturnType<typeof deferred<string>>>()
  const firstPlay = deferred<void>()
  const calls: string[] = []
  const played: string[] = []
  let active = 0
  let maxActive = 0
  const queue = new VoiceQueue<string>({
    synthesize: async text => {
      calls.push(text)
      active++
      maxActive = Math.max(maxActive, active)
      const gate = deferred<string>()
      gates.set(text, gate)
      try {
        return await gate.promise
      } finally {
        active--
      }
    },
    play: async text => {
      played.push(text)
      if (text === '开场一') await firstPlay.promise
    },
    onChange: () => {},
  })
  queue.start(['开场一', '开场二', '开场三'], [], 0)
  assert.deepEqual(calls, ['开场一', '开场二'])
  queue.enqueue(['观众回复'])
  gates.get('开场一')?.resolve('开场一')
  await until(() => calls.includes('观众回复'))
  assert.deepEqual(calls, ['开场一', '开场二', '观众回复'])
  gates.get('观众回复')?.resolve('观众回复')
  gates.get('开场二')?.resolve('开场二')
  await until(() => played.includes('观众回复'))
  await until(() => played.includes('开场一'))
  firstPlay.resolve()
  await until(() => calls.includes('开场三'))
  gates.get('开场三')?.resolve('开场三')
  await until(() => queue.getState().phase === 'idle')
  assert.deepEqual(played, ['观众回复', '开场一', '开场二', '开场三'])
  assert.equal(maxActive, 2)
  assert.equal(calls.filter(text => text === '开场二').length, 1)
  queue.stop()
})

test('预取同文句子共享音频，循环不会重复触发并发请求', async () => {
  let calls = 0
  let plays = 0
  const queue = new VoiceQueue<string>({
    synthesize: async text => {
      calls++
      return text
    },
    play: async () => {
      plays++
      if (plays === 5) queue.stop()
    },
    onChange: () => {},
  })
  queue.start([], ['同一句循环'], 0)
  await until(() => plays === 5)
  assert.equal(calls, 1)
})

test('停止取消当前和预取合成，重新开始后迟到音频不能污染新会话', async () => {
  const gates: ReturnType<typeof deferred<string>>[] = []
  const signals: AbortSignal[] = []
  const played: string[] = []
  const queue = new VoiceQueue<string>({
    synthesize: async (text, signal) => {
      if (text === '新的开场') return text
      const gate = deferred<string>()
      gates.push(gate)
      signals.push(signal)
      return gate.promise
    },
    play: async text => {
      played.push(text)
    },
    onChange: () => {},
  })
  queue.start(['旧的一', '旧的二', '旧的三'], [], 0)
  assert.equal(gates.length, 2)
  queue.stop()
  assert.ok(signals.every(signal => signal.aborted))
  queue.start(['新的开场'], [], 0)
  for (const gate of gates) gate.resolve('旧音频')
  await until(() => queue.getState().phase === 'idle')
  assert.deepEqual(played, ['新的开场'])
  assert.equal(gates.length, 2, '停止后不再启动尚未发出的第三句预取')
  queue.stop()
})

test('合成中暂停不会在合成完成后擅自发声，也不继续新增预取', async () => {
  const gates: ReturnType<typeof deferred<string>>[] = []
  const played: string[] = []
  const queue = new VoiceQueue<string>({
    synthesize: async text => {
      if (text === '第三句') return text
      const gate = deferred<string>()
      gates.push(gate)
      return gate.promise
    },
    play: async text => {
      played.push(text)
    },
    onChange: () => {},
  })
  queue.start(['第一句', '第二句', '第三句'], [], 0)
  queue.setPaused(true)
  gates[0].resolve('第一句')
  gates[1].resolve('第二句')
  await until(() => queue.getState().phase === 'paused')
  assert.deepEqual(played, [])
  assert.equal(gates.length, 2)
  queue.setPaused(false)
  await until(() => queue.getState().phase === 'idle')
  assert.deepEqual(played, ['第一句', '第二句', '第三句'])
  queue.stop()
})

test('未来句预合成失败不截断正在播放的句子，轮到该句时明确停止', async () => {
  const firstPlay = deferred<void>()
  const played: string[] = []
  const queue = new VoiceQueue<string>({
    synthesize: async text => {
      if (text === '失败句') throw new Error('接口暂时失败')
      return text
    },
    play: async text => {
      played.push(text)
      await firstPlay.promise
    },
    onChange: () => {},
  })
  queue.start(['正在读的句子', '失败句'], [], 0)
  await until(() => played.length === 1)
  assert.equal(queue.getState().phase, 'playing')
  firstPlay.resolve()
  await until(() => queue.getState().phase === 'error')
  assert.deepEqual(played, ['正在读的句子'])
  assert.equal(queue.getState().error, '接口暂时失败')
})

test('MiMo 请求严格遵守 assistant 文本和 user 风格约定并解析音频', async context => {
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.xiaomimimo.com/v1/chat/completions')
    const body = JSON.parse(init.body as string)
    assert.equal(body.model, 'mimo-v2.5-tts')
    assert.deepEqual(body.messages, [
      { role: 'user', content: TTS_PRESETS.mimo.instructions },
      { role: 'assistant', content: '欢迎光临' },
    ])
    assert.deepEqual(body.audio, { format: 'wav', voice: 'mimo_default' })
    assert.equal(body.stream, false)
    return Response.json({ choices: [{ message: { audio: { data: wav().toString('base64') } } }] })
  })
  const audio = await new MimoTtsProvider().synthesize(
    '欢迎光临',
    TTS_PRESETS.mimo,
    'fake-key',
    new AbortController().signal,
  )
  assert.equal(audio.mimeType, 'audio/wav')
  assert.equal(audio.base64, wav().toString('base64'))
})

test('兼容厂商使用 audio/speech 而非 MiMo 格式，不传空风格', async context => {
  const settings = {
    ...TTS_PRESETS['openai-compatible'],
    baseURL: 'https://tts.example/v1/',
    model: 'speech-model',
    voice: 'voice-id',
  }
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://tts.example/v1/audio/speech')
    assert.deepEqual(JSON.parse(init.body as string), {
      model: 'speech-model',
      input: '你好',
      voice: 'voice-id',
      response_format: 'wav',
    })
    return new Response(wav(), { headers: { 'Content-Type': 'audio/wav' } })
  })
  const audio = await new OpenAICompatibleTtsProvider().synthesize(
    '你好',
    settings,
    'fake-key',
    new AbortController().signal,
  )
  assert.equal(audio.base64, wav().toString('base64'))
})

test('厂商错误不泄漏密钥或原始响应，空音频不进入播放', async context => {
  const mock = context.mock.method(
    globalThis,
    'fetch',
    async () => new Response('secret response', { status: 429 }),
  )
  await assert.rejects(
    new MimoTtsProvider().synthesize(
      '你好',
      TTS_PRESETS.mimo,
      'fake-key',
      new AbortController().signal,
    ),
    /HTTP 429/,
  )
  mock.mock.mockImplementation(async () => Response.json({ choices: [{ message: {} }] }))
  await assert.rejects(
    new MimoTtsProvider().synthesize(
      '你好',
      TTS_PRESETS.mimo,
      'fake-key',
      new AbortController().signal,
    ),
    /未返回音频/,
  )
})

test('阻止密钥通过明文远程地址或错误 MiMo 域名发送', () => {
  assert.throws(
    () => validateTtsSettings({ ...TTS_PRESETS.mimo, baseURL: 'https://wrong.example/v1' }),
    /官方/,
  )
  assert.throws(
    () =>
      validateTtsSettings({
        ...TTS_PRESETS['openai-compatible'],
        baseURL: 'http://remote.example/v1',
      }),
    /HTTPS/,
  )
  assert.doesNotThrow(() =>
    validateTtsSettings({
      ...TTS_PRESETS['openai-compatible'],
      baseURL: 'http://localhost:8000/v1',
      model: 'local',
      voice: 'default',
    }),
  )
})
