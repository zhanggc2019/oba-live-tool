import assert from 'node:assert/strict'
import { test } from 'node:test'
import { uploadLanyunVoice } from '../electron/main/services/tts/providers'
import { TTS_PRESETS } from '../shared/voice'
import { MAX_CLONE_AUDIO_BYTES, validateCloneAudio } from '../shared/voiceClone'

/** 构造带 WAV 文件头的短录音，用于验证上传协议而不发送真实声音。 */
function wav(): Uint8Array {
  const bytes = Buffer.alloc(48)
  bytes.write('RIFF', 0)
  bytes.write('WAVE', 8)
  return bytes
}

test('音色克隆拒绝超限、空文件、错误后缀和伪装的音频', () => {
  assert.doesNotThrow(() => validateCloneAudio('声音.WAV', wav()))
  assert.throws(() => validateCloneAudio('空.wav', new Uint8Array()), /为空/)
  assert.throws(
    () => validateCloneAudio('过大.wav', new Uint8Array(MAX_CLONE_AUDIO_BYTES + 1)),
    /超过/,
  )
  assert.throws(() => validateCloneAudio('文档.txt', wav()), /仅支持/)
  assert.throws(() => validateCloneAudio('伪装.mp3', wav()), /内容与音频格式不符/)
})

test('蓝云私人音色上传使用用户身份和 multipart，返回可播报 voice_id', async context => {
  const settings = { ...TTS_PRESETS.lanyun, userId: 'owner-001' }
  const signal = new AbortController().signal
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://tts.lanyun.net/api/v1/user/voices')
    assert.equal(init.method, 'POST')
    assert.equal(init.redirect, 'error')
    assert.equal(init.signal, signal)
    const headers = new Headers(init.headers)
    assert.equal(headers.get('X-API-Key'), 'test-key')
    assert.equal(headers.get('X-User-ID'), 'owner-001')
    assert.equal(headers.get('Content-Type'), null)
    const form = init.body as FormData
    assert.equal(form.get('name'), '我的直播声线')
    assert.equal(form.get('gender'), 'unknown')
    assert.equal(form.get('category'), 'custom')
    const audio = form.get('audio') as File
    assert.equal(audio.name, 'sample.wav')
    assert.deepEqual(new Uint8Array(await audio.arrayBuffer()), Uint8Array.from(wav()))
    return Response.json({ voice_id: 'private-voice-1', name: '我的直播声线' }, { status: 201 })
  })
  const voice = await uploadLanyunVoice(
    '我的直播声线',
    'sample.wav',
    wav(),
    settings,
    'test-key',
    signal,
  )
  assert.deepEqual(voice, { id: 'private-voice-1', name: '我的直播声线', isPrivate: true })
})

test('未填写蓝云用户 ID 或已取消时不会向服务发送上传请求', async context => {
  let requests = 0
  context.mock.method(globalThis, 'fetch', async () => {
    requests++
    return Response.json({ voice_id: 'unexpected' })
  })
  await assert.rejects(
    uploadLanyunVoice(
      '测试',
      'sample.wav',
      wav(),
      TTS_PRESETS.lanyun,
      'test-key',
      new AbortController().signal,
    ),
    /用户 ID/,
  )
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    uploadLanyunVoice(
      '测试',
      'sample.wav',
      wav(),
      { ...TTS_PRESETS.lanyun, userId: 'owner-001' },
      'test-key',
      controller.signal,
    ),
    /abort/i,
  )
  assert.equal(requests, 0)
})

test('蓝云拒绝超大或无效录音时给出重新上传提示', async context => {
  let status = 413
  context.mock.method(globalThis, 'fetch', async () => new Response('private error', { status }))
  const settings = { ...TTS_PRESETS.lanyun, userId: 'owner-001' }
  for (const code of [413, 422]) {
    status = code
    await assert.rejects(
      uploadLanyunVoice(
        '测试',
        'sample.wav',
        wav(),
        settings,
        'test-key',
        new AbortController().signal,
      ),
      error =>
        error instanceof Error &&
        /重新上传/.test(error.message) &&
        !error.message.includes('private error'),
    )
  }
})
