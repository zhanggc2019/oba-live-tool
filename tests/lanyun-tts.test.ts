import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import {
  LanyunTtsProvider,
  listLanyunVoices,
  validateTtsSettings,
} from '../electron/main/services/tts/providers'
import { TTS_PRESETS, type TtsSettings } from '../shared/voice'

const settings: TtsSettings = { ...TTS_PRESETS.lanyun, voice: 'voice-test' }

/** 生成格式正确的静音 WAV，协议测试不使用真实账号或合成接口。 */
function wav(): Buffer {
  const bytes = Buffer.alloc(48)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(40, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(24000, 24)
  bytes.writeUInt32LE(48000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(4, 40)
  return bytes
}

/** 生成带完整首帧的 MP3 格式样本，仅用于检查帧头与文件类型识别。 */
function mp3(withTag: boolean): Buffer {
  const frame = Buffer.alloc(417)
  frame.set([0xff, 0xfb, 0x90, 0x00])
  return withTag ? Buffer.concat([Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]), frame]) : frame
}

/** 用固定配置执行一次合成，便于覆盖各种服务响应。 */
function synthesize(patch: Partial<TtsSettings> = {}, signal = new AbortController().signal) {
  return new LanyunTtsProvider().synthesize(
    '欢迎来到直播间。',
    { ...settings, ...patch },
    'test-lanyun-key',
    signal,
  )
}

test('蓝云使用原生鉴权，合成及下载携带相同私人身份，返回 WAV', async context => {
  const calls: string[] = []
  const signal = new AbortController().signal
  context.mock.method(globalThis, 'fetch', async (url: string | URL, init: RequestInit) => {
    calls.push(String(url))
    const headers = new Headers(init.headers)
    assert.equal(headers.get('X-API-Key'), 'test-lanyun-key')
    assert.equal(headers.get('X-User-ID'), 'user-001')
    assert.equal(headers.get('Authorization'), null)
    assert.equal(init.redirect, 'error')
    assert.equal(init.signal, signal)
    if (init.method === 'POST') {
      assert.equal(headers.get('Content-Type'), 'application/json')
      assert.deepEqual(JSON.parse(init.body as string), {
        text: '欢迎来到直播间。',
        voice_id: 'voice-test',
        lang: 'ZH',
        speech_rate: 1.2,
        loudness_rate: 1,
        duration_factor: 1,
        interval_silence: 80,
        use_random: false,
        use_emo_text: true,
        emo_text: '亲切自然',
        emo_alpha: 1,
      })
      return Response.json({ audio_url: '/recordings/generated.wav' }, { status: 201 })
    }
    return new Response(wav(), { headers: { 'Content-Type': 'application/octet-stream' } })
  })
  assert.deepEqual(
    await synthesize(
      { userId: 'user-001', speechRate: 1.2, intervalSilence: 80, instructions: '亲切自然' },
      signal,
    ),
    {
      mimeType: 'audio/wav',
      base64: wav().toString('base64'),
    },
  )
  assert.deepEqual(calls, [
    'https://tts.lanyun.net/api/v1/tts/synthesize',
    'https://tts.lanyun.net/recordings/generated.wav',
  ])
})

test('外部音色 ID 不混入 voice_id，空情感禁用，按内容识别两种 MP3 头', async context => {
  let tagged = false
  context.mock.method(globalThis, 'fetch', async (_url: string | URL, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get('X-User-ID'), null)
    if (init.method === 'POST') {
      const body = JSON.parse(init.body as string)
      assert.equal(body.external_voice_id, 'external-test')
      assert.equal(body.voice_id, undefined)
      assert.equal(body.use_emo_text, false)
      assert.equal(body.emo_text, undefined)
      assert.equal(body.lang, 'EN')
      assert.equal(body.model, undefined)
      return Response.json({ audio_url: 'https://tts.lanyun.net/recordings/no-extension' })
    }
    return new Response(mp3(tagged))
  })
  for (const withTag of [false, true]) {
    tagged = withTag
    const audio = await synthesize({
      voice: 'external-test',
      voiceIdType: 'external_voice_id',
      language: 'EN',
    })
    assert.equal(audio.mimeType, 'audio/mpeg')
    assert.equal(audio.base64, mp3(withTag).toString('base64'))
  }
})

test('未选音色也能获取目录，保留私人音色，过滤隐藏及无效项', async context => {
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://tts.lanyun.net/api/v1/voices')
    assert.equal(init.redirect, 'error')
    assert.equal(new Headers(init.headers).get('X-User-ID'), 'user-private')
    assert.equal(new Headers(init.headers).get('X-API-Key'), 'test-list-key')
    return Response.json({
      voices: [
        { voice_id: 'public-1', name: '公共音色', visibility: 'public' },
        { voice_id: 'private-1', name: '我的音色', visibility: 'private' },
        { voice_id: 'hidden', api_visible: false },
        { voice_id: '' },
        null,
      ],
    })
  })
  assert.deepEqual(
    await listLanyunVoices(
      { ...TTS_PRESETS.lanyun, userId: 'user-private' },
      'test-list-key',
      new AbortController().signal,
    ),
    [
      { id: 'public-1', name: '公共音色', isPrivate: false },
      { id: 'private-1', name: '我的音色', isPrivate: true },
    ],
  )
})

test('阻止音频地址跨域、协议降级或嵌入凭据，不发起第二次请求', async context => {
  let audioURL = ''
  let calls = 0
  context.mock.method(globalThis, 'fetch', async () => {
    calls++
    return Response.json({ audio_url: audioURL })
  })
  for (const value of [
    'https://other.example/secret.wav',
    '//other.example/secret.wav',
    'http://tts.lanyun.net/file.wav',
    'https://name:pass@tts.lanyun.net/file.wav',
    'data:audio/wav;base64,anything',
  ]) {
    audioURL = value
    const before = calls
    await assert.rejects(synthesize(), /必须与 API 同源/)
    assert.equal(calls, before + 1)
  }
})

test('真实 fetch 拒绝录音重定向，不把密钥发送到重定向目标', async () => {
  let forwarded = false
  const server = createServer((request, response) => {
    if (request.url === '/api/v1/tts/synthesize') {
      response
        .writeHead(201, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ audio_url: '/redirect' }))
    } else if (request.url === '/redirect') {
      response.writeHead(302, { Location: '/unexpected' }).end()
    } else {
      forwarded = true
      response.end(wav())
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await assert.rejects(synthesize({ baseURL: `http://127.0.0.1:${address.port}` }))
    assert.equal(forwarded, false)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    )
  }
})

test('拒绝无效 JSON、缺失地址、伪音频与超限响应', async context => {
  let responseBody: () => Response = () => new Response('secret-key-and-invalid-json')
  context.mock.method(globalThis, 'fetch', async (_url: string | URL, init: RequestInit) => {
    if (init.method !== 'POST') return responseBody()
    return mode === 'json' ? responseBody() : Response.json({ audio_url: '/recordings/test' })
  })
  let mode = 'json'
  await assert.rejects(synthesize(), /无效的 JSON/)
  responseBody = () => Response.json({})
  await assert.rejects(synthesize(), /未返回合成音频地址/)
  responseBody = () => new Response('x'.repeat(1024 * 1024 + 1))
  await assert.rejects(synthesize(), /过大/)
  mode = 'audio'
  for (const body of [
    Buffer.from('<html>error</html>'),
    Buffer.from('ID3error'),
    mp3(false).subarray(0, 4),
    Buffer.alloc(16 * 1024 * 1024 + 1),
  ]) {
    responseBody = () => new Response(body)
    await assert.rejects(synthesize(), /有效的 WAV 或 MP3|过大/)
  }
})

test('合成返回前取消，后续不再下载；查询也支持取消', async context => {
  const controller = new AbortController()
  let calls = 0
  context.mock.method(globalThis, 'fetch', async () => {
    calls++
    controller.abort()
    return Response.json({ audio_url: '/recordings/test.wav' })
  })
  await assert.rejects(synthesize({}, controller.signal), { name: 'AbortError' })
  assert.equal(calls, 1)
  await assert.rejects(listLanyunVoices(TTS_PRESETS.lanyun, 'key', controller.signal), {
    name: 'AbortError',
  })
  assert.equal(calls, 1)
})

test('HTTP 错误包含可操作提示，不泄露原文与密钥', async context => {
  let status = 401
  let downloadError = false
  context.mock.method(globalThis, 'fetch', async (_url: string | URL, init: RequestInit) => {
    if (downloadError && init.method === 'POST')
      return Response.json({ audio_url: '/recordings/test.wav' })
    return new Response('sensitive-original-body test-lanyun-key', { status })
  })
  for (const atDownload of [false, true]) {
    downloadError = atDownload
    for (const code of [401, 403, 404, 408, 422, 429, 500, 504]) {
      status = code
      await assert.rejects(synthesize(), (error: Error) => {
        assert.match(error.message, new RegExp(`HTTP ${code}`))
        assert.ok(!error.message.includes('test-lanyun-key'))
        assert.ok(!error.message.includes('sensitive-original-body'))
        return true
      })
    }
  }
})

test('校验音色、语速、语言和停顿范围，旧配置补充缺省值', () => {
  assert.throws(() => validateTtsSettings(TTS_PRESETS.lanyun), /音色 ID/)
  assert.doesNotThrow(() => validateTtsSettings(TTS_PRESETS.lanyun, false))
  for (const patch of [
    { speechRate: 0.4 },
    { speechRate: 2.1 },
    { speechRate: Number.NaN },
    { intervalSilence: -1 },
    { intervalSilence: 1001 },
    { intervalSilence: 1.5 },
    { language: 'XX' },
    { voiceIdType: 'unknown' },
    { userId: 'abc\nInjected: header' },
    { voice: 'a'.repeat(65) },
    { baseURL: 'http://unsafe.example' },
  ])
    assert.throws(() => validateTtsSettings({ ...settings, ...patch } as TtsSettings))
  assert.doesNotThrow(() =>
    validateTtsSettings({
      provider: 'lanyun',
      baseURL: settings.baseURL,
      model: '',
      voice: 'valid',
      instructions: '',
    }),
  )
  assert.doesNotThrow(() =>
    validateTtsSettings({ ...settings, voice: 'a'.repeat(128), voiceIdType: 'external_voice_id' }),
  )
})
