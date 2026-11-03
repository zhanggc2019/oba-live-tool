import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright'
import { checkSpeechPacing } from './speech-pacing-ui.mjs'

/** 生成静音 WAV，让浏览器实际走解码与播放流程，不调用付费语音服务。 */
function makeSilentWav(seconds = 0.1) {
  const data = Buffer.alloc(44 + Math.round(seconds * 48000))
  data.write('RIFF', 0)
  data.writeUInt32LE(data.length - 8, 4)
  data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20)
  data.writeUInt16LE(1, 22)
  data.writeUInt32LE(24000, 24)
  data.writeUInt32LE(48000, 28)
  data.writeUInt16LE(2, 32)
  data.writeUInt16LE(16, 34)
  data.write('data', 36)
  data.writeUInt32LE(data.length - 44, 40)
  return data.toString('base64')
}

await mkdir('test-results', { recursive: true })
/** 仅提供本次构建产物，使用随机本机端口，测试后自动关闭。 */
const server = createServer(async (request, response) => {
  const relative =
    decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\/+/, '') ||
    'index.html'
  const file = path.resolve('dist', relative)
  if (!file.startsWith(`${path.resolve('dist')}${path.sep}`)) {
    response.writeHead(403).end()
    return
  }
  try {
    const body = await readFile(file)
    const types = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.png': 'image/png',
    }
    response
      .writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' })
      .end(body)
  } catch {
    response.writeHead(404).end()
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
let page
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ viewport: { width: 1440, height: 1080 } })
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(
    ({ audio, prebufferAudio }) => {
      const listeners = new Map()
      const keys = new Set()
      const cancelledScripts = new Set()
      if (!localStorage.getItem('ai-chat-storage')) {
        const config = {
          config: {
            provider: 'deepseek',
            model: 'deepseek-chat',
            modelPreferences: { deepseek: 'deepseek-chat' },
          },
          apiKeys: { deepseek: 'test-script-key' },
          customBaseURL: '',
        }
        localStorage.setItem(
          'ai-chat-storage',
          JSON.stringify({ state: { chat: config, autoReply: config }, version: 1 }),
        )
      }
      window.voiceTest = {
        requests: [],
        replies: [],
        chats: [],
        cancelled: [],
        scriptRequests: [],
        keyChecks: [],
        connections: [],
        voiceLists: [],
        playback: [],
        synthesisDelay: 120,
        continuations: [],
        clones: [],
      }
      const originalPlay = HTMLMediaElement.prototype.play
      /** 记录真实浏览器播放器的倍率和音高开关，仍然解码并播放测试 WAV。 */
      HTMLMediaElement.prototype.play = function () {
        window.voiceTest.playback.push({
          rate: this.playbackRate,
          preservesPitch: this.preservesPitch,
        })
        return originalPlay.call(this)
      }
      /** 模拟主进程事件，只用于隔离真实直播间的页面测试。 */
      window.emitTestEvent = (channel, ...args) => {
        for (const listener of listeners.get(channel) ?? []) listener(...args)
      }
      window.ipcRenderer = {
        /** 保留真实订阅/退订语义，以检测切页之后监听是否仍然有效。 */
        on(channel, listener) {
          const set = listeners.get(channel) ?? new Set()
          set.add(listener)
          listeners.set(channel, set)
          return () => set.delete(listener)
        },
        send() {},
        /** 模拟网络合成结果，其他行为保留应用前端原有逻辑。 */
        async invoke(channel, ...args) {
          if (channel === 'tasks:aiChat:testApiKey') {
            window.voiceTest.keyChecks.push(args[0])
            return { success: true }
          }
          if (channel === 'liveScript:cancel') {
            cancelledScripts.add(args[0])
            return
          }
          if (channel === 'liveScript:generate') {
            const request = args[0]
            window.voiceTest.scriptRequests.push(request)
            if (request.mode === 'continuation') {
              window.voiceTest.continuations.push(request)
              await new Promise(resolve => setTimeout(resolve, 180))
              const marker = ['甲', '乙', '丙', '丁'][request.segmentIndex % 4]
              const sentence = index =>
                `${marker}${String.fromCharCode(0x4e00 + index)}类使用场景可以从实际需要出发，看看哪些细节更加合适。`
              return {
                text: Array.from({ length: Math.ceil(request.targetCharacters / 32) }, (_, index) =>
                  sentence(index),
                ).join(''),
                cancelled: false,
                truncated: false,
              }
            }
            const whole = `${request.productIntro}，请结合自己的使用习惯选择。`
              .repeat(300)
              .slice(0, 3000)
            let text = ''
            for (let offset = 0; offset < whole.length; offset += 100) {
              await new Promise(resolve => setTimeout(resolve, 70))
              if (cancelledScripts.has(request.requestId))
                return { text, cancelled: true, truncated: false }
              const chunk = whole.slice(offset, offset + 100)
              text += chunk
              window.emitTestEvent('liveScript:progress', {
                requestId: request.requestId,
                accountId: request.accountId,
                chunk,
              })
            }
            return { text, cancelled: false, truncated: false }
          }
          if (channel === 'tts:hasKey') return keys.has(args[0])
          if (channel === 'tts:saveKey') {
            keys.add(args[0])
            return
          }
          if (channel === 'tts:cancel') {
            window.voiceTest.cancelled.push(args[0])
            return
          }
          if (channel === 'tts:listVoices') {
            const request = args[0]
            window.voiceTest.voiceLists.push(request)
            await new Promise(resolve =>
              setTimeout(resolve, request.settings.userId === 'old-user' ? 600 : 50),
            )
            return [
              { id: 'public-voice', name: '公共测试音色', isPrivate: false },
              { id: `${request.settings.userId}-voice`, name: '我的测试音色', isPrivate: true },
              ...window.voiceTest.clones.map(item => ({
                id: item.voiceId,
                name: item.name,
                isPrivate: true,
              })),
            ]
          }
          if (channel === 'tts:cloneVoice') {
            window.voiceTest.clones.push({ ...args[0], voiceId: 'cloned-voice-1' })
            return { id: 'cloned-voice-1', name: args[0].name, isPrivate: true }
          }
          if (channel === 'tts:synthesize') {
            window.voiceTest.requests.push(args[0])
            await new Promise(resolve => setTimeout(resolve, window.voiceTest.synthesisDelay))
            return {
              base64: window.voiceTest.prebufferAudio ? prebufferAudio : audio,
              mimeType: 'audio/wav',
            }
          }
          if (channel === 'tasks:aiChat:normalChat') {
            window.voiceTest.chats.push(args[0])
            return '这款杯子是五百毫升，适合日常使用。'
          }
          if (channel === 'tasks:autoReply:sendReply') {
            window.voiceTest.replies.push(args)
            return
          }
          if (channel === 'chrome:getPath') return 'test-browser'
          if (channel === 'tasks:liveControl:connect') {
            window.voiceTest.connections.push(args)
            return true
          }
          if (channel === 'app:getProviders') return null
          return true
        },
      }
    },
    {
      audio: makeSilentWav(),
      prebufferAudio: makeSilentWav(10),
    },
  )
  await page.goto(`http://127.0.0.1:${server.address().port}/#/live-speech`)
  await page.waitForLoadState('networkidle')
  await page.screenshot({ path: 'test-results/voice-initial.png' })
  if (process.argv.includes('--clone')) {
    await page.getByRole('link', { name: '音色克隆', exact: true }).click()
    const upload = page.getByRole('button', { name: '上传并克隆音色', exact: true })
    const file = page.locator('#clone-voice-file')
    await file.setInputFiles({
      name: 'sample.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('invalid'),
    })
    await page
      .getByRole('alert')
      .getByText(/仅支持 WAV/)
      .waitFor()
    assert.equal(await upload.isDisabled(), true)
    await file.setInputFiles({
      name: 'sample.wav',
      mimeType: 'audio/wav',
      buffer: Buffer.from('invalid'),
    })
    await page
      .getByRole('alert')
      .getByText(/内容与音频格式不符/)
      .waitFor()
    await file.setInputFiles({
      name: 'large.wav',
      mimeType: 'audio/wav',
      buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
    })
    await page
      .getByRole('alert')
      .getByText(/超过 10 MiB/)
      .waitFor()
    await file.setInputFiles({
      name: 'sample.wav',
      mimeType: 'audio/wav',
      buffer: Buffer.from(makeSilentWav(), 'base64'),
    })
    await page.getByText(/已选择：sample.wav/).waitFor()
    await page.locator('#tts-provider').click()
    await page.getByRole('option', { name: '蓝云 TTS（IndexTTS-2.5）', exact: true }).click()
    await page.getByLabel('用户 ID（私人音色需要）', { exact: true }).fill('owner-001')
    await page.locator('#tts-key').fill('test-clone-key')
    await page.getByRole('button', { name: '保存密钥', exact: true }).click()
    await page.locator('#clone-voice-name').fill('我的直播声线')
    await upload.click()
    await page.getByText(/已保存并选中：我的直播声线 · cloned-voice-1/).waitFor()
    const clone = await page.evaluate(() => window.voiceTest.clones[0])
    assert.equal(clone.settings.provider, 'lanyun')
    assert.equal(clone.settings.userId, 'owner-001')
    assert.equal(clone.fileName, 'sample.wav')
    assert.ok(clone.audio.length > 44)
    assert.equal(await page.getByLabel('音色 ID', { exact: true }).inputValue(), 'cloned-voice-1')
    await page.screenshot({ path: 'test-results/voice-clone.png', fullPage: true })
    await page.getByRole('link', { name: '直播话术', exact: true }).click()
    await page.locator('#broadcast-voice').click()
    await page
      .getByRole('option', { name: '我的直播声线 · 私人 · cloned-voice-1', exact: true })
      .waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '试听音色', exact: true }).click()
    await page.waitForFunction(() => window.voiceTest.requests.length >= 1)
    assert.equal(
      await page.evaluate(() => window.voiceTest.requests[0].settings.voice),
      'cloned-voice-1',
    )
    await page.getByRole('button', { name: '停止语音', exact: true }).click()
    assert.deepEqual(errors, [])
    console.log('VOICE CLONE UI CHECKS PASSED: file validation, upload, selection and preview')
  } else if (process.argv.includes('--voice-picker')) {
    await page.locator('#broadcast-voice').click()
    await page.getByRole('option', { name: '茉莉', exact: true }).click()
    await page.getByRole('button', { name: '试听音色', exact: true }).click()
    await page.getByText('请先在音色克隆页面保存当前厂商的 API Key', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.voiceTest.requests.length), 0)
    await page.getByRole('link', { name: '音色克隆', exact: true }).click()
    assert.equal(await page.locator('#tts-voice').innerText(), '茉莉')
    await page.locator('#tts-key').fill('test-mimo-key')
    await page.getByRole('button', { name: '保存密钥', exact: true }).click()
    await page.getByRole('link', { name: '直播话术', exact: true }).click()
    await page.getByRole('button', { name: '试听音色', exact: true }).click()
    await page.waitForFunction(() => window.voiceTest.requests.length >= 1)
    assert.equal(await page.evaluate(() => window.voiceTest.requests[0].settings.voice), '茉莉')
    assert.equal(await page.evaluate(() => window.voiceTest.continuations.length), 0)
    await page.getByRole('button', { name: '停止语音', exact: true }).click()
    await page.getByRole('link', { name: '音色克隆', exact: true }).click()
    await page.locator('#tts-provider').click()
    await page.getByRole('option', { name: '蓝云 TTS（IndexTTS-2.5）', exact: true }).click()
    await page.locator('#tts-key').fill('test-lanyun-key')
    await page.getByRole('button', { name: '保存密钥', exact: true }).click()
    await page.getByLabel('用户 ID（私人音色需要）', { exact: true }).fill('user-001')
    await page.getByRole('link', { name: '直播话术', exact: true }).click()
    await page.waitForFunction(() => window.voiceTest.voiceLists.length >= 1)
    await page.locator('#broadcast-voice').click()
    await page
      .getByRole('option', { name: '我的测试音色 · 私人 · user-001-voice', exact: true })
      .click()
    await page.getByRole('button', { name: '试听音色', exact: true }).click()
    await page.waitForFunction(() => window.voiceTest.requests.length >= 2)
    assert.equal(
      await page.evaluate(() => window.voiceTest.requests[1].settings.voice),
      'user-001-voice',
    )
    assert.equal(
      await page.evaluate(() => window.voiceTest.requests[1].settings.provider),
      'lanyun',
    )
    await page.getByRole('button', { name: '停止语音', exact: true }).click()
    assert.deepEqual(errors, [])
    console.log('VOICE PICKER UI CHECKS PASSED: MiMo and Lanyun selection, key guidance, preview')
  } else if (process.argv.includes('--prebuffer')) {
    await page.getByLabel('话术名称', { exact: true }).fill('水杯话术')
    await page.getByLabel('话术正文（可编辑）', { exact: true }).fill('这款水杯适合日常使用。')
    await page.getByRole('button', { name: '保存话术', exact: true }).click()
    await page.locator('#selected-live-script').click()
    await page.getByRole('option', { name: '水杯话术', exact: true }).click()
    assert.match(await page.locator('#prebuffer-seconds').innerText(), /30 秒/)
    await page.evaluate(() => {
      window.voiceTest.prebufferAudio = true
      window.voiceTest.synthesisDelay = 800
    })
    await page.getByRole('button', { name: '开始播报', exact: true }).click()
    await page.getByText('默认账号 · 准备开播语音', { exact: true }).waitFor()
    await page.getByText(/已预备 0\.0 \/ 约 30 秒/).waitFor()
    await page.getByRole('button', { name: '取消准备', exact: true }).first().click()
    await page.waitForFunction(() => window.voiceTest.cancelled.length >= 1)
    assert.equal(await page.getByText('默认账号 · 准备开播语音', { exact: true }).count(), 0)
    await page.evaluate(() => {
      window.voiceTest.synthesisDelay = 80
    })
    await page.getByRole('button', { name: '开始播报', exact: true }).click()
    await page.getByText('默认账号 · 准备开播语音', { exact: true }).waitFor()
    await page.getByText('默认账号 · 正在播放', { exact: true }).waitFor()
    assert.ok((await page.getByText(/正在预备语音：30\.0 \/ 约 30 秒/).count()) === 0)
    const playedText = await page.evaluate(() =>
      window.voiceTest.requests.map(request => request.text),
    )
    assert.ok(playedText.includes('这款水杯适合日常使用。'))
    assert.ok(playedText.some(text => text.includes('类使用场景')))
    await page.getByRole('button', { name: '停止语音', exact: true }).click()
    assert.deepEqual(errors, [])
    console.log(
      'PREBUFFER UI CHECKS PASSED: default 30s, cancel, continuation supply, automatic playback',
    )
  } else if (process.argv.includes('--script-switch')) {
    await page.evaluate(() => {
      const oldScript = '自习室适合安静学习。'.repeat(30)
      const newScript = '今天带大家看看北方周庄。这里的讲解围绕景区信息展开。'
      localStorage.setItem(
        'voice-config',
        JSON.stringify({
          state: {
            contexts: {
              default: {
                savedScripts: [
                  {
                    id: 'old',
                    title: '自习室话术',
                    content: oldScript,
                    updatedAt: '2026-01-01',
                    productIntro: '自习室',
                    referenceText: '安静学习',
                    scriptRequirements: '舒缓',
                  },
                  { id: 'new', title: '北方周庄直播', content: newScript, updatedAt: '2026-01-02' },
                ],
                selectedScriptId: 'old',
                loopScript: oldScript,
                productIntro: '自习室',
                referenceText: '安静学习',
                scriptRequirements: '舒缓',
                prebufferSeconds: 0,
              },
            },
          },
          version: 1,
        }),
      )
    })
    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: '开始播报', exact: true }).click()
    await page.getByText('当前正在播报：自习室话术', { exact: true }).waitFor()
    await page.waitForFunction(() =>
      window.voiceTest.requests.some(item => item.text.includes('自习室')),
    )
    await page.locator('#selected-live-script').click()
    await page.getByRole('option', { name: '北方周庄直播', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: '停止语音', exact: true }).count(), 0)
    assert.equal(await page.getByLabel('简短产品介绍', { exact: true }).inputValue(), '自习室')
    assert.equal(
      await page.getByLabel('商品要素与参考资料', { exact: true }).inputValue(),
      '安静学习',
    )
    assert.equal(await page.getByLabel('补充要求（选填）', { exact: true }).inputValue(), '舒缓')
    assert.equal(await page.getByRole('option', { name: /当前手动填写/ }).count(), 0)
    assert.equal(
      await page.getByRole('button', { name: '开始播报', exact: true }).isEnabled(),
      true,
    )
    await page.getByRole('button', { name: '开始播报', exact: true }).click()
    await page.getByText('当前正在播报：北方周庄直播', { exact: true }).waitFor()
    await page.waitForFunction(() =>
      window.voiceTest.requests.some(item => item.text.includes('北方周庄')),
    )
    await page.waitForFunction(() =>
      window.voiceTest.continuations.some(item => item.seedScript.includes('北方周庄')),
    )
    const continuation = await page.evaluate(() =>
      window.voiceTest.continuations.find(item => item.seedScript.includes('北方周庄')),
    )
    assert.equal(continuation.productIntro, '')
    assert.equal(continuation.referenceText, '')
    await page.getByRole('button', { name: '停止语音', exact: true }).click()
    await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('voice-config'))
      const config = saved.state.contexts.default
      config.selectedScriptId = 'new'
      config.productIntro = '自习室'
      config.referenceText = '安静学习'
      delete config.factsScriptId
      localStorage.setItem('voice-config', JSON.stringify(saved))
    })
    await page.reload()
    await page.waitForLoadState('networkidle')
    assert.equal(await page.getByLabel('简短产品介绍', { exact: true }).inputValue(), '自习室')
    assert.equal(
      await page.getByLabel('商品要素与参考资料', { exact: true }).inputValue(),
      '安静学习',
    )
    await page.getByLabel('简短产品介绍', { exact: true }).fill('北方周庄景区')
    await page.reload()
    await page.waitForLoadState('networkidle')
    assert.equal(
      await page.getByLabel('简短产品介绍', { exact: true }).inputValue(),
      '北方周庄景区',
    )
    assert.equal(
      await page.getByLabel('商品要素与参考资料', { exact: true }).inputValue(),
      '安静学习',
    )
    await page.locator('#script-library').click()
    await page.getByRole('option', { name: /自习室话术/ }).click()
    assert.equal(await page.getByLabel('简短产品介绍', { exact: true }).inputValue(), '自习室')
    assert.equal(
      await page.getByLabel('商品要素与参考资料', { exact: true }).inputValue(),
      '安静学习',
    )
    await page.getByRole('button', { name: '新建话术', exact: true }).click()
    assert.equal(await page.getByLabel('简短产品介绍', { exact: true }).inputValue(), '')
    assert.equal(await page.getByLabel('商品要素与参考资料', { exact: true }).inputValue(), '')
    await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('voice-config'))
      const config = saved.state.contexts.default
      config.savedScripts.find(script => script.id === 'new').content = config.savedScripts.find(
        script => script.id === 'old',
      ).content
      localStorage.setItem('voice-config', JSON.stringify(saved))
    })
    await page.reload()
    await page
      .getByRole('alert')
      .getByText(/北方周庄直播.*自习室话术/)
      .waitFor()
    assert.equal(
      await page.getByRole('button', { name: '开始播报', exact: true }).isDisabled(),
      true,
    )
    assert.deepEqual(errors, [])
    console.log(
      'SCRIPT SWITCH UI CHECKS PASSED: old playback stops and stale product facts are cleared',
    )
  } else if (process.argv.includes('--providers')) {
    // 模拟旧在线目录覆盖，验证 Qwen 预设仍保留。
    await page.evaluate(() =>
      window.emitTestEvent('app:providersUpdated', {
        siliconflow: {
          name: '硅基流动',
          baseURL: 'https://api.siliconflow.cn/v1',
          apiUrl: '',
          models: ['deepseek-ai/DeepSeek-V3.2'],
        },
        custom: { name: '自定义', baseURL: '', apiUrl: '', models: [] },
      }),
    )
    await page.getByRole('button', { name: '配置文本模型', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('选择提供商', { exact: true }).click()
    await page.getByRole('option', { name: '硅基流动', exact: true }).click()
    assert.equal(await dialog.getByLabel('模型 ID', { exact: true }).inputValue(), 'Qwen/Qwen3-8B')
    await dialog.getByLabel('API Key', { exact: true }).fill('test-siliconflow-key')
    await dialog.getByRole('button', { name: '测试连接', exact: true }).click()
    await dialog.getByRole('status').waitFor()
    await page.screenshot({ path: 'test-results/provider-siliconflow.png' })
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await page.getByLabel('简短产品介绍', { exact: true }).fill('蓝色水杯，容量500毫升')
    await page.getByRole('button', { name: '生成约 3000 字话术', exact: true }).click()
    await page.waitForFunction(() => window.voiceTest.scriptRequests.length === 1)
    const siliconflow = await page.evaluate(() => window.voiceTest.scriptRequests[0])
    assert.equal(siliconflow.provider, 'siliconflow')
    assert.equal(siliconflow.model, 'Qwen/Qwen3-8B')
    assert.equal(siliconflow.apiKey, 'test-siliconflow-key')
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await page.getByRole('button', { name: '生成约 3000 字话术', exact: true }).waitFor()
    await page.getByRole('button', { name: '配置文本模型', exact: true }).click()
    await dialog.getByLabel('选择提供商', { exact: true }).click()
    await page.getByRole('option', { name: '其他 OpenAI 兼容服务', exact: true }).click()
    await dialog.getByLabel('接口地址（Base URL）', { exact: true }).fill('invalid-url')
    await dialog.getByLabel('模型 ID', { exact: true }).fill('vendor/custom-model')
    await dialog.getByLabel('API Key', { exact: true }).fill('test-compatible-key')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    assert.equal(await dialog.isVisible(), true)
    assert.equal(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem('ai-chat-storage')).state.chat.config.provider,
      ),
      'siliconflow',
    )
    await dialog
      .getByLabel('接口地址（Base URL）', { exact: true })
      .fill('https://example.com/compatible/v1/chat/completions/')
    await dialog.getByRole('button', { name: '测试连接', exact: true }).click()
    await dialog.getByRole('status').waitFor()
    assert.equal(
      await page.evaluate(() => window.voiceTest.keyChecks.at(-1).customBaseURL),
      'https://example.com/compatible/v1',
    )
    await dialog.getByLabel('API Key', { exact: true }).fill('test-compatible-key-updated')
    assert.equal(await dialog.getByRole('status').count(), 0, '修改密钥后清除旧的连接成功状态')
    await page.screenshot({ path: 'test-results/provider-compatible.png' })
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: '生成约 3000 字话术', exact: true }).click()
    await page.waitForFunction(() => window.voiceTest.scriptRequests.length === 1)
    const compatible = await page.evaluate(() => window.voiceTest.scriptRequests[0])
    assert.equal(compatible.provider, 'custom')
    assert.equal(compatible.model, 'vendor/custom-model')
    assert.equal(compatible.customBaseURL, 'https://example.com/compatible/v1')
    assert.equal(compatible.apiKey, 'test-compatible-key-updated')
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await page.getByRole('button', { name: '生成约 3000 字话术', exact: true }).waitFor()
    // 开播后的自动续稿也必须使用保存的第三方模型、地址和密钥。
    await page.getByLabel('话术名称', { exact: true }).fill('第三方模型水杯话术')
    await page
      .getByLabel('话术正文（可编辑）', { exact: true })
      .fill('这款水杯容量五百毫升，适合上班通勤。'.repeat(5))
    await page.getByRole('button', { name: '保存话术', exact: true }).click()
    await page.locator('#selected-live-script').click()
    await page.getByRole('option', { name: '第三方模型水杯话术', exact: true }).click()
    await page.getByRole('link', { name: '音色克隆', exact: true }).click()
    await page.locator('#tts-key').fill('test-provider-tts-key')
    await page.getByRole('button', { name: '保存密钥', exact: true }).click()
    await page.getByText('API Key · 已保存', { exact: true }).waitFor()
    await page.getByRole('link', { name: '直播话术', exact: true }).click()
    await page.locator('#prebuffer-seconds').click()
    await page.getByRole('option', { name: '立即开始', exact: true }).click()
    await page.getByRole('button', { name: '开始播报', exact: true }).click()
    await page.waitForFunction(() => window.voiceTest.continuations.length >= 1)
    const continuation = await page.evaluate(() => window.voiceTest.continuations[0])
    assert.equal(continuation.provider, 'custom')
    assert.equal(continuation.model, 'vendor/custom-model')
    assert.equal(continuation.customBaseURL, 'https://example.com/compatible/v1')
    assert.equal(continuation.apiKey, 'test-compatible-key-updated')
    await page.getByRole('button', { name: '停止语音', exact: true }).click()
    await page.getByRole('button', { name: '配置文本模型', exact: true }).click()
    await dialog.getByLabel('选择提供商', { exact: true }).click()
    await page.getByRole('option', { name: '硅基流动', exact: true }).click()
    assert.equal(await dialog.getByLabel('模型 ID', { exact: true }).inputValue(), 'Qwen/Qwen3-8B')
    assert.equal(
      await dialog.getByLabel('API Key', { exact: true }).inputValue(),
      'test-siliconflow-key',
    )
    await dialog.getByLabel('模型 ID', { exact: true }).fill('Qwen/new-manual-model')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await page.getByRole('link', { name: '自动回复设置', exact: true }).click()
    await page.getByRole('tab', { name: 'AI回复', exact: true }).click()
    await page.getByRole('switch', { name: '启用AI自动回复', exact: true }).check()
    await page.getByRole('button', { name: '配置文本模型', exact: true }).click()
    await dialog.getByLabel('选择提供商', { exact: true }).click()
    await page.getByRole('option', { name: '硅基流动', exact: true }).click()
    await dialog.getByLabel('API Key', { exact: true }).fill('test-reply-key')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    const saved = await page.evaluate(
      () => JSON.parse(localStorage.getItem('ai-chat-storage')).state,
    )
    assert.equal(saved.autoReply.config.model, 'Qwen/Qwen3-8B')
    assert.equal(saved.chat.config.model, 'Qwen/new-manual-model')
    assert.equal(saved.chat.apiKeys.siliconflow, 'test-siliconflow-key')
    assert.deepEqual(errors, [])
    console.log(
      'PROVIDER UI CHECKS PASSED: old catalog, Qwen selection, custom endpoint, validation, persistence, third-party draft/continuation, independent reply settings',
    )
  } else if (process.argv.includes('--scripts')) {
    await page.getByLabel('简短产品介绍', { exact: true }).fill('蓝色水杯，容量500毫升')
    await page.getByLabel('补充要求（选填）', { exact: true }).fill('亲切自然')
    await page.getByLabel('商品要素与参考资料', { exact: true }).fill('容量500毫升')
    assert.equal(
      await page.getByRole('button', { name: '开始播报', exact: true }).isDisabled(),
      true,
    )
    assert.equal(await page.getByRole('textbox', { name: '讲解底稿', exact: true }).count(), 0)
    await page.getByRole('button', { name: '生成约 3000 字话术', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('#generated-script').value.length > 0)
    await page.getByRole('link', { name: '音色克隆', exact: true }).click()
    await page.locator('nav a').filter({ hasText: '直播话术' }).click()
    await page.waitForFunction(
      () => document.querySelector('#generated-script')?.value.length === 3000,
    )
    await page.getByRole('button', { name: '保存话术', exact: true }).waitFor({ state: 'visible' })
    assert.equal(await page.evaluate(() => window.voiceTest.scriptRequests.length), 1)
    await page.getByLabel('话术名称', { exact: true }).fill('水杯日常版')
    await page
      .getByLabel('话术正文（可编辑）', { exact: true })
      .fill('\n这是人工修改并确认过的水杯话术。\n')
    await page.getByRole('button', { name: '保存话术', exact: true }).click()
    assert.equal(await page.locator('#selected-live-script').innerText(), '请选择已保存话术')
    await page.locator('#selected-live-script').click()
    await page.getByRole('option', { name: '水杯日常版', exact: true }).click()
    await page.getByText(/话术正文：水杯日常版 · 1 句/).waitFor()
    assert.equal(await page.getByText(/随话术保存的商品资料：\d+ 字/).count(), 1)
    await page.getByLabel('话术正文（可编辑）', { exact: true }).fill('修订后的水杯话术。')
    await page.getByRole('button', { name: '保存修改', exact: true }).click()
    await page.getByText(/话术正文：水杯日常版 · 1 句/).waitFor()
    await page.getByLabel('话术名称', { exact: true }).fill('水杯晚间版')
    await page.getByRole('button', { name: '另存为新话术', exact: true }).click()
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem('voice-config')).state.contexts.default.savedScripts
          .length === 2,
    )
    await page.locator('#script-library').click()
    await page.getByRole('option', { name: /水杯晚间版/ }).click()
    assert.equal(await page.locator('#selected-live-script').innerText(), '水杯日常版')
    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.locator('#selected-live-script').click()
    await page.getByRole('option', { name: '水杯日常版', exact: true }).click()
    assert.equal(
      await page.getByLabel('商品要素与参考资料', { exact: true }).inputValue(),
      '容量500毫升',
    )
    assert.equal(await page.getByRole('switch', { name: '启用循环播报', exact: true }).count(), 0)
    assert.equal(
      await page.getByRole('button', { name: '停止语音', exact: true }).count(),
      0,
      '选择话术不会自动发声',
    )
    await page.getByRole('button', { name: '生成约 3000 字话术', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('#generated-script').value.length > 0)
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await page.getByText('已停止生成，当前内容保留为可编辑草稿。', { exact: true }).waitFor()
    assert.equal(
      await page.getByLabel('话术正文（可编辑）', { exact: true }).getAttribute('readonly'),
      null,
    )
    await page.locator('main').evaluate(element => {
      element.scrollTop = 0
    })
    await page.screenshot({ path: 'test-results/script-generator.png' })
    assert.deepEqual(errors, [])
    console.log(
      'SCRIPT UI CHECKS PASSED: streaming, editing, saving, save-as, reselect after reload, cancellation',
    )
  } else if (process.argv.includes('--pacing')) {
    await checkSpeechPacing(page)
    assert.deepEqual(errors, [])
    console.log(
      'PACING UI CHECKS PASSED: default range, provider routing, pitch, fixed mode, session snapshot, requirements, persistence',
    )
  } else if (process.argv.includes('--inspect')) {
    console.log((await page.locator('body').innerText()).slice(0, 6500))
  } else {
    assert.equal(
      await page.getByRole('button', { name: '开始播报', exact: true }).isDisabled(),
      true,
    )
    assert.equal(await page.getByRole('button', { name: '停止语音', exact: true }).count(), 0)
    await page.getByLabel('开场介绍', { exact: true }).fill('欢迎来到直播间。今天介绍我们的水杯。')
    await page.getByLabel('话术名称', { exact: true }).fill('水杯话术')
    await page
      .getByLabel('话术正文（可编辑）', { exact: true })
      .fill('这是水杯的基本介绍。'.repeat(5))
    await page
      .getByRole('textbox', { name: '商品要素与参考资料', exact: true })
      .fill('产品是水杯，容量500毫升。')
    await page.getByRole('button', { name: '保存话术', exact: true }).click()
    await page.locator('#selected-live-script').click()
    await page.getByRole('option', { name: '水杯话术', exact: true }).click()
    await page.getByRole('link', { name: '音色克隆', exact: true }).click()
    assert.equal(await page.getByLabel('模型', { exact: true }).inputValue(), 'mimo-v2.5-tts')
    const lanyunTest = process.argv.includes('--lanyun')
    const qwenTest = process.argv.includes('--qwen')
    if (qwenTest) {
      // 模拟升级前没有千问配置的账号，切换时应补齐预设。
      await page.evaluate(() => {
        const saved = JSON.parse(localStorage.getItem('voice-config'))
        for (const config of Object.values(saved.state.contexts)) delete config.providers.qwen
        localStorage.setItem('voice-config', JSON.stringify(saved))
      })
      await page.reload()
      await page.waitForLoadState('networkidle')
      await page.locator('#tts-provider').click()
      await page
        .getByRole('option', { name: '阿里千问 TTS（Qwen Audio 3.1 Flash）', exact: true })
        .click()
      assert.equal(await page.locator('#tts-model').inputValue(), 'qwen-audio-3.1-tts-flash')
      assert.equal(await page.locator('#tts-model').isDisabled(), true)
      assert.equal(await page.locator('#qwen-voice-id').inputValue(), 'longanhuan_v3.1')
      await page
        .locator('#tts-url')
        .fill('https://workspace-test.cn-beijing.maas.aliyuncs.com/api/v1')
      await page.locator('#tts-voice').click()
      await page.getByRole('option', { name: '许南川 · 男声', exact: true }).click()
      assert.equal(await page.locator('#qwen-voice-id').inputValue(), 'xunanchuan_v3.1')
      await page.locator('#qwen-voice-id').fill('custom-qwen-voice')
      assert.equal(await page.locator('#tts-voice').innerText(), '当前音色 · custom-qwen-voice')
      await page.locator('#tts-style').fill('亲切自然，用普通话讲解。')
    }
    if (lanyunTest) {
      // 已有账号最初只保存 MiMo 的设置，切换后应补齐蓝云默认配置。
      await page.evaluate(() => {
        const saved = JSON.parse(localStorage.getItem('voice-config'))
        for (const config of Object.values(saved.state.contexts)) delete config.providers.lanyun
        localStorage.setItem('voice-config', JSON.stringify(saved))
      })
      await page.reload()
      await page.waitForLoadState('networkidle')
      await page.locator('#tts-provider').click()
      await page.getByRole('option', { name: '蓝云 TTS（IndexTTS-2.5）', exact: true }).click()
      assert.equal(
        await page.getByLabel('API 基础地址', { exact: true }).inputValue(),
        'https://tts.lanyun.net',
      )
      assert.equal(await page.getByLabel('模型', { exact: true }).isDisabled(), true)
      assert.equal(
        await page.getByRole('button', { name: '获取音色', exact: true }).isDisabled(),
        true,
      )
      assert.equal(await page.getByLabel('音色 ID', { exact: true }).inputValue(), '')
    }
    await page.locator('#tts-key').fill('test-key-only')
    await page.getByRole('button', { name: '保存密钥', exact: true }).click()
    await page.getByText('API Key · 已保存', { exact: true }).waitFor()
    assert.equal(await page.locator('#tts-key').inputValue(), '')
    assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('test-key-only'))
    if (lanyunTest) {
      assert.equal(
        await page.getByRole('button', { name: '合成并播放', exact: true }).isDisabled(),
        true,
      )
      await page.getByLabel('用户 ID（私人音色需要）', { exact: true }).fill('old-user')
      await page.getByRole('button', { name: '获取音色', exact: true }).click()
      await page.waitForFunction(() => window.voiceTest.voiceLists.length === 1)
      await page.getByLabel('用户 ID（私人音色需要）', { exact: true }).fill('user-001')
      await page.getByRole('button', { name: '获取音色', exact: true }).click()
      await page.waitForFunction(() => window.voiceTest.voiceLists.length === 2)
      await page.getByLabel('可用音色', { exact: true }).click()
      await page
        .getByRole('option', { name: '我的测试音色 · 私人 · user-001-voice', exact: true })
        .click()
      assert.equal(await page.getByLabel('音色 ID', { exact: true }).inputValue(), 'user-001-voice')
      await page.getByRole('switch', { name: '动态语速', exact: true }).uncheck()
      await page.getByLabel('语速倍率', { exact: true }).fill('1.2')
      await page.getByLabel('段间停顿 / 毫秒', { exact: true }).fill('80')
      await page.getByLabel('情感描述（可选）', { exact: true }).fill('亲切自然')
      await page.getByLabel('音色 ID 类型', { exact: true }).click()
      await page
        .getByRole('option', { name: '外部映射 ID（external_voice_id）', exact: true })
        .click()
      assert.equal(await page.getByLabel('音色 ID', { exact: true }).inputValue(), '')
      await page.getByLabel('音色 ID', { exact: true }).fill('external-sample')
      await page.getByRole('button', { name: '合成并播放', exact: true }).click()
      await page.getByText('默认账号 · 等待回复', { exact: true }).waitFor()
      assert.equal(
        await page.evaluate(() => window.voiceTest.requests[0].settings.voiceIdType),
        'external_voice_id',
      )
      await page.getByRole('button', { name: '停止语音', exact: true }).click()
      await page.getByLabel('音色 ID 类型', { exact: true }).click()
      await page.getByRole('option', { name: '蓝云音色 ID（voice_id）', exact: true }).click()
      await page.getByLabel('可用音色', { exact: true }).click()
      assert.equal(await page.getByRole('option', { name: /old-user/ }).count(), 0)
      await page
        .getByRole('option', { name: '我的测试音色 · 私人 · user-001-voice', exact: true })
        .click()
    }
    await page.getByRole('button', { name: '合成并播放', exact: true }).click()
    await page.waitForFunction(
      expected => window.voiceTest.requests.length === expected,
      lanyunTest ? 2 : 1,
    )
    await page.getByText('默认账号 · 等待回复', { exact: true }).waitFor()
    await page.getByRole('button', { name: '停止语音', exact: true }).click()
    await page.locator('#tts-provider').click()
    await page.getByRole('option', { name: 'OpenAI 兼容语音厂商', exact: true }).click()
    await page.getByLabel('API 基础地址', { exact: true }).fill('https://tts.example/v1')
    await page.getByLabel('模型', { exact: true }).fill('custom-tts')
    await page.locator('#tts-provider').click()
    await page.getByRole('option', { name: '小米 MiMo V2.5 TTS', exact: true }).click()
    assert.equal(await page.getByLabel('模型', { exact: true }).inputValue(), 'mimo-v2.5-tts')
    if (lanyunTest) {
      await page.getByText('API Key · 未配置', { exact: true }).waitFor()
      await page.locator('#tts-provider').click()
      await page.getByRole('option', { name: '蓝云 TTS（IndexTTS-2.5）', exact: true }).click()
      await page.getByText('API Key · 已保存', { exact: true }).waitFor()
      assert.equal(await page.getByLabel('音色 ID', { exact: true }).inputValue(), 'user-001-voice')
      assert.equal(await page.getByLabel('语速倍率', { exact: true }).inputValue(), '1.2')
      await page.screenshot({ path: 'test-results/lanyun-tts-settings.png' })
    }
    if (qwenTest) {
      await page.getByText('API Key · 未配置', { exact: true }).waitFor()
      await page.locator('#tts-provider').click()
      await page
        .getByRole('option', { name: '阿里千问 TTS（Qwen Audio 3.1 Flash）', exact: true })
        .click()
      await page.getByText('API Key · 已保存', { exact: true }).waitFor()
      assert.equal(await page.locator('#qwen-voice-id').inputValue(), 'custom-qwen-voice')
      assert.equal(await page.locator('#tts-style').inputValue(), '亲切自然，用普通话讲解。')
      await page.reload()
      await page.waitForLoadState('networkidle')
      assert.equal(await page.locator('#qwen-voice-id').inputValue(), 'custom-qwen-voice')
      assert.equal(
        await page.locator('#tts-url').inputValue(),
        'https://workspace-test.cn-beijing.maas.aliyuncs.com/api/v1',
      )
      // 页面重新加载会重置测试桩的密钥状态，恢复后验证开播前选择及播报。
      await page.locator('#tts-key').fill('test-key-only')
      await page.getByRole('button', { name: '保存密钥', exact: true }).click()
      await page.getByText('API Key · 已保存', { exact: true }).waitFor()
      await page.screenshot({ path: 'test-results/qwen-tts-settings.png', fullPage: true })
    }
    await page.screenshot({ path: 'test-results/tts-settings.png' })
    await page.getByRole('link', { name: '直播话术', exact: true }).click()
    assert.equal(
      await page.getByLabel('开场介绍', { exact: true }).inputValue(),
      '欢迎来到直播间。今天介绍我们的水杯。',
    )
    if (qwenTest) {
      await page.locator('#broadcast-voice').click()
      await page
        .getByRole('option', { name: '当前音色 · custom-qwen-voice', exact: true })
        .waitFor()
      await page.getByRole('option', { name: '龙安灵心 · 女声', exact: true }).click()
    }
    assert.equal(
      await page.getByRole('button', { name: '开始播报', exact: true }).isDisabled(),
      false,
    )
    assert.match(await page.locator('#prebuffer-seconds').innerText(), /30 秒/)
    await page.locator('#prebuffer-seconds').click()
    await page.getByRole('option', { name: '立即开始', exact: true }).click()
    await page.getByRole('button', { name: '开始播报', exact: true }).click()
    await page.waitForFunction(() => window.voiceTest.continuations.length >= 1)
    const firstContinuation = await page.evaluate(() => window.voiceTest.continuations[0])
    assert.equal(firstContinuation.mode, 'continuation')
    assert.ok(firstContinuation.targetCharacters >= 400)
    assert.ok(firstContinuation.referenceText.includes('容量500毫升'))
    assert.ok(firstContinuation.seedScript.includes('水杯的基本介绍'))
    await page.getByText('本地试听', { exact: true }).waitFor()
    assert.equal(
      await page.getByRole('button', { name: '开始播报', exact: true }).isEnabled(),
      false,
    )
    await page.waitForFunction(() =>
      window.voiceTest.requests.some(request => request.text.includes('类使用场景')),
    )
    await page.getByRole('button', { name: '句末暂停', exact: true }).click()
    await page.getByText('默认账号 · 已暂停', { exact: true }).waitFor()
    await page.evaluate(() =>
      window.emitTestEvent('tasks:liveControl:disconnectedEvent', 'default'),
    )
    await page.getByText('默认账号 · 已暂停', { exact: true }).waitFor()
    assert.equal(
      await page.getByRole('button', { name: '停止语音', exact: true }).count(),
      1,
      '中控台/自动回复停止事件不终止本地试听',
    )
    await page.getByRole('button', { name: '继续', exact: true }).click()
    await page.getByText('默认账号 · 正在播放', { exact: true }).waitFor()
    assert.equal(
      await page.evaluate(() => window.voiceTest.connections.length),
      0,
      '本地试听全程不连接直播中控台',
    )
    await page.screenshot({ path: 'test-results/local-speech.png' })
    await page.getByRole('button', { name: '停止语音', exact: true }).click()
    assert.equal(await page.getByRole('switch', { name: '启用循环播报', exact: true }).count(), 0)
    await page.screenshot({ path: 'test-results/live-speech.png' })
    await page.locator('nav a').filter({ hasText: '打开中控台' }).click()
    await page.getByRole('button', { name: '连接直播控制台', exact: true }).click()
    await page.getByRole('button', { name: '断开连接', exact: true }).waitFor()
    await page.locator('nav a').filter({ hasText: '直播话术' }).click()
    await page.getByRole('button', { name: '开始播报', exact: true }).click()
    await page.waitForFunction(() =>
      window.voiceTest.requests.some(request => request.text === '今天介绍我们的水杯。'),
    )
    await page.getByRole('button', { name: '停止语音', exact: true }).waitFor()
    await page.getByRole('link', { name: '自动回复设置', exact: true }).click()
    await page.getByRole('tab', { name: 'AI回复', exact: true }).click()
    await page.getByRole('switch', { name: '启用AI自动回复', exact: true }).check()
    await page.getByRole('switch', { name: '自动发送', exact: true }).check()
    await page.locator('#ai-output-mode').click()
    await page.getByRole('option', { name: '语音播报', exact: true }).click()
    await page.locator('nav a').filter({ hasText: '自动回复' }).click()
    await page.getByRole('button', { name: '开始监听', exact: true }).click()
    await page.getByRole('button').filter({ hasText: '开始任务' }).click()
    await page.getByRole('button').filter({ hasText: '停止任务' }).waitFor()
    await page.evaluate(() =>
      window.emitTestEvent('tasks:autoReply:showComment', {
        accountId: 'default',
        comment: {
          msg_id: 'question-1',
          msg_type: 'comment',
          nick_name: '观众甲',
          content: '容量多少？',
          time: Date.now(),
        },
      }),
    )
    await page.waitForFunction(() =>
      window.voiceTest.requests.some(request => request.text.includes('五百毫升')),
    )
    const result = await page.evaluate(() => window.voiceTest)
    assert.equal(result.replies.length, 0, '语音模式不发送文字')
    assert.ok(
      result.chats[0].messages[0].content.includes('产品是水杯，容量500毫升。'),
      'AI 收到产品参考资料',
    )
    await page.screenshot({ path: 'test-results/ai-voice-reply.png' })
    // 新账号使用不同参考资料；后台默认账号的评论仍应使用默认账号配置。
    await page.locator('header button').last().click()
    await page.getByPlaceholder('账号名称', { exact: true }).fill('第二直播间')
    await page.getByRole('button', { name: '确定', exact: true }).click()
    await page.locator('header').getByRole('combobox').click()
    await page.getByRole('option', { name: '第二直播间', exact: true }).click()
    await page.locator('nav a').filter({ hasText: '直播话术' }).click()
    assert.equal(await page.getByLabel('开场介绍', { exact: true }).inputValue(), '')
    await page
      .getByRole('textbox', { name: '商品要素与参考资料', exact: true })
      .fill('第二直播间销售雨伞。')
    await page.evaluate(() =>
      window.emitTestEvent('tasks:autoReply:showComment', {
        accountId: 'default',
        comment: {
          msg_id: 'question-background',
          msg_type: 'comment',
          nick_name: '观众丙',
          content: '介绍一下容量',
          time: Date.now(),
        },
      }),
    )
    await page.waitForFunction(() => window.voiceTest.chats.length === 2)
    const background = await page.evaluate(() => window.voiceTest.chats[1])
    assert.ok(background.messages[0].content.includes('产品是水杯，容量500毫升。'))
    assert.ok(!background.messages[0].content.includes('第二直播间销售雨伞。'))
    await page.locator('header').getByRole('combobox').click()
    await page.getByRole('option', { name: '默认账号', exact: true }).click()
    await page.locator('nav a').filter({ hasText: '自动回复' }).click()
    await page.getByRole('button', { name: '停止语音', exact: true }).click()
    const before = await page.evaluate(() => window.voiceTest.requests.length)
    await page.evaluate(() =>
      window.emitTestEvent('tasks:autoReply:showComment', {
        accountId: 'default',
        comment: {
          msg_id: 'question-2',
          msg_type: 'comment',
          nick_name: '观众乙',
          content: '多大容量？',
          time: Date.now(),
        },
      }),
    )
    await page.waitForFunction(() => window.voiceTest.chats.length === 3)
    await page.waitForFunction(() => document.body.textContent.includes('观众乙'))
    assert.equal(
      await page.evaluate(() => window.voiceTest.requests.length),
      before,
      '停止语音后不再合成 AI 答案',
    )
    await page.getByRole('button').filter({ hasText: '停止任务' }).click()
    const completedRequests = await page.evaluate(() => window.voiceTest.requests)
    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.locator('nav a').filter({ hasText: '直播话术' }).click()
    assert.equal(
      await page.getByLabel('开场介绍', { exact: true }).inputValue(),
      '欢迎来到直播间。今天介绍我们的水杯。',
    )
    assert.deepEqual(errors, [])
    if (qwenTest) {
      assert.ok(completedRequests.length > 5)
      assert.ok(completedRequests.every(request => request.settings.provider === 'qwen'))
      assert.ok(
        completedRequests.every(request => request.settings.model === 'qwen-audio-3.1-tts-flash'),
      )
      assert.ok(completedRequests.some(request => request.settings.voice === 'longanlingxin_v3.1'))
      assert.ok(completedRequests.some(request => request.text.includes('五百毫升')))
      await page.getByRole('link', { name: '音色克隆', exact: true }).click()
      assert.equal(await page.locator('#qwen-voice-id').inputValue(), 'longanlingxin_v3.1')
      console.log(
        'QWEN UI CHECKS PASSED: legacy settings, presets/custom voice, provider switching, persistence, local/live playback and AI replies',
      )
    }
    if (lanyunTest) {
      const requests = completedRequests
      assert.ok(requests.length > 5)
      assert.ok(requests.every(request => request.settings.provider === 'lanyun'))
      assert.ok(requests.some(request => request.text.includes('五百毫升')))
      await page.getByRole('link', { name: '音色克隆', exact: true }).click()
      assert.equal(await page.getByLabel('音色 ID', { exact: true }).inputValue(), 'user-001-voice')
      assert.equal(
        await page.getByLabel('用户 ID（私人音色需要）', { exact: true }).inputValue(),
        'user-001',
      )
      assert.equal(await page.getByLabel('语速倍率', { exact: true }).inputValue(), '1.2')
      console.log(
        'LANYUN UI CHECKS PASSED: settings, private/external voices, stale list cancellation, provider switching, persistence, local playback and AI replies',
      )
    }
    console.log('VOICE UI CHECKS PASSED; screenshots:', path.resolve('test-results'))
  }
} catch (error) {
  console.log('FAILED PAGE', await page?.locator('body').innerText())
  console.log('IPC STATE', await page?.evaluate(() => window.voiceTest))
  await page?.screenshot({ path: 'test-results/voice-failure.png' })
  throw error
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
