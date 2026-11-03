import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildContinuationScriptMessages,
  type ContinuationScriptRequest,
} from '../shared/liveScript'
import {
  type ContinuousScriptConfig,
  ContinuousScriptController,
  type ContinuousScriptState,
  continuationTarget,
  continuationThreshold,
} from '../src/services/voice/continuousScript'
import { VoiceQueue } from '../src/services/voice/VoiceQueue'

const config: ContinuousScriptConfig = {
  accountId: 'test-account',
  seedScript: '这里介绍商品的基础信息。'.repeat(220),
  productIntro: '水杯，容量500毫升。',
  referenceText: '材质已确认，价格未提供。',
  requirements: '自然讲解',
  provider: 'test',
  model: 'text-model',
  apiKey: 'test-key',
}

/** 用受控 Promise 模拟网络返回，以验证播放进度和停止后的竞态。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

/** 生成满足目标字数、句子不与底稿重复的模拟续稿。 */
function nextText(index: number, length: number): string {
  const marker = ['甲', '乙', '丙', '丁'][index % 4]
  return Array.from(
    { length: Math.ceil(length / 24) },
    (_, sentenceIndex) =>
      `${marker}${String.fromCharCode(0x4e00 + sentenceIndex)}类场景会关注什么，应该如何判断。`,
  ).join('')
}

/** 等待异步请求或队列状态推进，超时明确指出调度没有继续。 */
async function until(check: () => boolean): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > 2500) throw new Error('持续供稿没有按预期推进')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('续稿长度接近底稿，短稿立即预备、长稿在剩余字数较多时预备', () => {
  assert.equal(continuationTarget('短稿'), 400)
  assert.equal(continuationTarget('介绍'.repeat(800)), 1600)
  assert.equal(continuationTarget('长稿'.repeat(3000)), 4000)
  assert.equal(continuationThreshold(400), 400)
  assert.equal(continuationThreshold(2500), 1200)
})

test('续稿提示词隔离商品事实、底稿与最近内容，并拒绝不合理长度', () => {
  const request: ContinuationScriptRequest = {
    mode: 'continuation',
    requestId: 'test',
    accountId: 'test',
    provider: 'test',
    model: 'm',
    apiKey: 'k',
    seedScript: '底稿正文。',
    productIntro: '容量500毫升。',
    referenceText: '价格未提供。',
    requirements: '温和讲解',
    theme: '使用场景',
    recentThemes: ['产品细节'],
    recentSamples: ['最近说过的片段。'],
    targetCharacters: 1200,
    segmentIndex: 2,
  }
  const messages = buildContinuationScriptMessages(request)
  assert.match(messages[0].content, /1200/)
  assert.match(messages[0].content, /不要复述/)
  assert.match(messages[1].content, /容量500毫升/)
  assert.match(messages[1].content, /最近说过的片段/)
  assert.throws(() => buildContinuationScriptMessages({ ...request, targetCharacters: 200 }))
})

test('剩余字数触发下一段；新段落接入队列后不会立即无限预生成，主题继续轮换', async () => {
  const requests: ContinuationScriptRequest[] = []
  const supplied: string[] = []
  const states: ContinuousScriptState[] = []
  const controller = new ContinuousScriptController({
    generate: async request => {
      requests.push(request)
      return {
        text: nextText(requests.length, request.targetCharacters),
        cancelled: false,
        truncated: false,
      }
    },
    onText: text => supplied.push(text),
    onState: state => states.push(state),
  })
  controller.start(config)
  controller.observe(true, false, 1300)
  assert.equal(requests.length, 0)
  controller.observe(true, false, 1100)
  await until(() => supplied.length === 1)
  assert.equal(requests[0].targetCharacters, continuationTarget(config.seedScript))
  assert.equal(states.at(-1)?.generatedSegments, 1)
  controller.observe(true, false, 3000)
  assert.equal(requests.length, 1)
  controller.observe(true, false, 1100)
  await until(() => supplied.length === 2)
  assert.equal(requests[1].recentThemes[0], requests[0].theme)
  assert.notEqual(requests[1].theme, requests[0].theme)
  controller.stop()
})

test('停止后旧续稿不入队，失败有限重试并显示可见错误', async () => {
  const pending = deferred<{ text: string; cancelled: boolean; truncated: boolean }>()
  let supplies = 0
  let attempts = 0
  const states: ContinuousScriptState[] = []
  const controller = new ContinuousScriptController({
    generate: async () => {
      attempts++
      return pending.promise
    },
    onText: () => {
      supplies++
    },
    onState: state => states.push(state),
  })
  controller.start({ ...config, seedScript: '短稿。' })
  controller.observe(true, false, 3)
  await until(() => attempts === 1)
  controller.stop()
  pending.resolve({ text: nextText(1, 400), cancelled: false, truncated: false })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(supplies, 0)
  assert.equal(states.at(-1)?.status, 'idle')

  const retryRequests: ContinuationScriptRequest[] = []
  const retry = new ContinuousScriptController({
    generate: async request => {
      retryRequests.push(request)
      return { text: '', cancelled: false, truncated: false, error: '模拟模型错误' }
    },
    onText: () => {
      supplies++
    },
    onState: state => states.push(state),
  })
  retry.start({ ...config, seedScript: '短稿。' })
  retry.observe(true, false, 3)
  await until(() => states.at(-1)?.status === 'error')
  assert.equal(retryRequests.length, 3)
  assert.equal(supplies, 0)
  assert.match(states.at(-1)?.error ?? '', /续稿失败/)
  retry.stop()
})

test('整段复读会更换主题重试，只有合格新文案进入播放队列', async () => {
  const themes: string[] = []
  const supplied: string[] = []
  const controller = new ContinuousScriptController({
    generate: async request => {
      themes.push(request.theme)
      return {
        text:
          themes.length === 1
            ? '同一句话反复讲解，没有带来新的内容和视角。'.repeat(30)
            : nextText(1, request.targetCharacters),
        cancelled: false,
        truncated: false,
      }
    },
    onText: text => supplied.push(text),
    onState: () => {},
  })
  controller.start({ ...config, seedScript: '较短底稿。'.repeat(30) })
  controller.observe(true, false, 100)
  await until(() => supplied.length === 1)
  assert.equal(themes.length, 2)
  assert.notEqual(themes[0], themes[1])
  assert.ok(!supplied[0].includes('同一句话反复讲解'))
  controller.stop()
})

test('回复优先于新续稿，播完原稿后接续新段落，等待期间不自行重播', async () => {
  const played: string[] = []
  const queue = new VoiceQueue<string>({
    synthesize: async text => text,
    play: async text => {
      played.push(text)
    },
    onChange: () => {},
  })
  queue.start(['底稿第一句'], [], 0)
  await until(() => queue.getState().phase === 'idle')
  assert.deepEqual(played, ['底稿第一句'])
  queue.supply(['新主题第一句', '新主题第二句'])
  queue.enqueue(['观众问题回答'])
  await until(() => queue.getState().phase === 'idle' && played.length === 4)
  assert.deepEqual(played, ['底稿第一句', '观众问题回答', '新主题第一句', '新主题第二句'])
  queue.stop()
})
