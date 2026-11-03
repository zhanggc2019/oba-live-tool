import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  QwenTtsProvider,
  ttsProviders,
  validateTtsSettings,
} from '../electron/main/services/tts/providers'
import { QWEN_VOICES, TTS_PRESETS, type TtsSettings } from '../shared/voice'

const settings: TtsSettings = {
  ...TTS_PRESETS.qwen,
  baseURL: 'https://workspace-test.cn-beijing.maas.aliyuncs.com/api/v1',
}
const audioURL = 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.wav?Signature=test'

/** 创建可通过播放器格式校验的最小 WAV 容器。 */
function wav(): Buffer {
  const bytes = Buffer.alloc(46)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(38, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(24000, 24)
  bytes.writeUInt32LE(48000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(2, 40)
  return bytes
}

/** 通过真实适配器执行一次合成，网络由各测试独立模拟。 */
function synthesize(config = settings, signal = new AbortController().signal) {
  return new QwenTtsProvider().synthesize('欢迎来到直播间。', config, 'test-qwen-key', signal)
}

test('千问使用原生请求和单数 instruction，下载升级 HTTPS 且不携带密钥', async context => {
  const controller = new AbortController()
  let calls = 0
  context.mock.method(globalThis, 'fetch', async (url: string | URL, init: RequestInit) => {
    calls++
    assert.equal(init.signal, controller.signal)
    assert.equal(init.redirect, 'error')
    if (calls === 1) {
      assert.equal(url, `${settings.baseURL}/services/audio/tts/SpeechSynthesizer`)
      assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer test-qwen-key')
      assert.equal(new Headers(init.headers).get('Content-Type'), 'application/json')
      assert.equal(init.method, 'POST')
      assert.deepEqual(JSON.parse(init.body as string), {
        model: 'qwen-audio-3.1-tts-flash',
        input: {
          text: '欢迎来到直播间。',
          voice: 'longanhuan_v3.1',
          format: 'wav',
          sample_rate: 24000,
          instruction: settings.instructions,
        },
      })
      return Response.json({ output: { finish_reason: 'stop', audio: { url: audioURL } } })
    }
    assert.equal(String(url), audioURL.replace('http:', 'https:'))
    assert.equal(new Headers(init.headers).get('Authorization'), null)
    return new Response(wav())
  })
  assert.deepEqual(await synthesize(settings, controller.signal), {
    base64: wav().toString('base64'),
    mimeType: 'audio/wav',
  })
  assert.equal(calls, 2)
  assert.ok(ttsProviders.qwen instanceof QwenTtsProvider)
  assert.ok(QWEN_VOICES.some(voice => voice.id === TTS_PRESETS.qwen.voice))
})

test('新加坡地址及自定义音色保留，空风格不提交 instruction', async context => {
  const config = {
    ...settings,
    baseURL: 'https://workspace-test.ap-southeast-1.maas.aliyuncs.com/api/v1/',
    voice: 'custom-voice',
    instructions: '  ',
  }
  context.mock.method(globalThis, 'fetch', async (url: string | URL, init: RequestInit) => {
    if (init.method === 'POST') {
      assert.equal(url, `${config.baseURL}services/audio/tts/SpeechSynthesizer`)
      const body = JSON.parse(init.body as string)
      assert.equal(body.input.voice, 'custom-voice')
      assert.ok(!('instruction' in body.input))
      return Response.json({ output: { audio: { url: audioURL } } })
    }
    return new Response(wav())
  })
  await synthesize(config)
})

test('千问密钥只允许发送到带业务空间的北京或新加坡官方 API', () => {
  for (const baseURL of [
    'https://evil.example/api/v1',
    'https://workspace.cn-beijing.maas.aliyuncs.com.evil.example/api/v1',
    'https://cn-beijing.maas.aliyuncs.com/api/v1',
    'http://workspace.cn-beijing.maas.aliyuncs.com/api/v1',
    'https://workspace.cn-beijing.maas.aliyuncs.com:8443/api/v1',
    'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1?key=secret',
  ])
    assert.throws(() => validateTtsSettings({ ...settings, baseURL }), /地址/)
  assert.throws(() => validateTtsSettings({ ...settings, voice: '' }), /音色/)
  assert.throws(() => validateTtsSettings({ ...settings, instructions: 'x'.repeat(2001) }), /过长/)
})

test('拒绝异常下载地址，且不会向该地址发送任何请求', async context => {
  for (const url of [
    'https://evil.example/audio.wav',
    'http://127.0.0.1/audio.wav',
    'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com.evil.example/audio.wav',
    'https://user:pass@dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav',
    'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com:8443/audio.wav',
    'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav#fragment',
    'file:///audio.wav',
    '/audio.wav',
    '',
  ]) {
    const mock = context.mock.method(globalThis, 'fetch', async () =>
      Response.json({ output: { audio: { url } } }),
    )
    await assert.rejects(synthesize(), /音频下载地址/)
    assert.equal(mock.mock.callCount(), 1)
    mock.mock.restore()
  }
})

test('HTTP 鉴权、限流及服务错误不回显密钥或服务端原文', async context => {
  for (const status of [400, 401, 403, 429, 500]) {
    const mock = context.mock.method(
      globalThis,
      'fetch',
      async () => new Response('sensitive-body test-qwen-key', { status }),
    )
    await assert.rejects(synthesize(), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, new RegExp(`HTTP ${status}`))
      assert.ok(!/sensitive-body|test-qwen-key/.test(error.message))
      return true
    })
    mock.mock.restore()
  }
})

test('无效 JSON、业务错误及缺失音频给出脱敏提示', async context => {
  for (const body of [
    'sensitive-body test-qwen-key',
    JSON.stringify(null),
    JSON.stringify({}),
    JSON.stringify({ code: 'InvalidParameter', message: 'test-qwen-key' }),
  ]) {
    const mock = context.mock.method(globalThis, 'fetch', async () => new Response(body))
    await assert.rejects(synthesize(), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /阿里 TTS/)
      assert.ok(!/sensitive-body|test-qwen-key/.test(error.message))
      return true
    })
    mock.mock.restore()
  }
})

test('下载失败不泄露签名，非 WAV 响应不能播放', async context => {
  for (const result of ['network', 'http', 'invalid'] as const) {
    const mock = context.mock.method(globalThis, 'fetch', async (_: unknown, init: RequestInit) => {
      if (init.method === 'POST') return Response.json({ output: { audio: { url: audioURL } } })
      if (result === 'network') throw new Error(`fetch failed ${audioURL}`)
      return new Response('invalid audio', { status: result === 'http' ? 403 : 200 })
    })
    await assert.rejects(synthesize(), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /下载失败|WAV/)
      assert.ok(!error.message.includes('Signature'))
      return true
    })
    mock.mock.restore()
  }
})

test('过大的 JSON 与音频响应受到大小限制', async context => {
  for (const stage of ['json', 'audio']) {
    const mock = context.mock.method(globalThis, 'fetch', async (_: unknown, init: RequestInit) => {
      if (stage === 'audio' && init.method === 'POST')
        return Response.json({ output: { audio: { url: audioURL } } })
      return new Response(Buffer.alloc(stage === 'json' ? 1024 * 1024 + 1 : 16 * 1024 * 1024 + 1))
    })
    await assert.rejects(synthesize(), /过大/)
    mock.mock.restore()
  }
})

test('已取消的请求不会合成，合成完成后取消不会继续下载', async context => {
  const controller = new AbortController()
  const mock = context.mock.method(globalThis, 'fetch', async () => {
    controller.abort()
    return Response.json({ output: { audio: { url: audioURL } } })
  })
  await assert.rejects(synthesize(settings, controller.signal), { name: 'AbortError' })
  assert.equal(mock.mock.callCount(), 1)
  await assert.rejects(synthesize(settings, controller.signal), { name: 'AbortError' })
  assert.equal(mock.mock.callCount(), 1)
})

test('音频下载过程可取消', async context => {
  const controller = new AbortController()
  context.mock.method(globalThis, 'fetch', async (_: unknown, init: RequestInit) => {
    if (init.method === 'POST') return Response.json({ output: { audio: { url: audioURL } } })
    assert.equal(init.signal, controller.signal)
    controller.abort()
    init.signal?.throwIfAborted()
    return new Response(wav())
  })
  await assert.rejects(synthesize(settings, controller.signal), { name: 'AbortError' })
})
