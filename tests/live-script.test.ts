import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateLiveScript } from '../electron/main/services/LiveScriptService'
import {
  buildLiveScriptMessages,
  countScriptCharacters,
  findScriptTopicConflict,
  saveLiveScript,
} from '../shared/liveScript'

test('话术提示词要求约3000字、可直接朗读，并保留产品事实约束', () => {
  const messages = buildLiveScriptMessages({ productIntro: '500ml水杯', requirements: '亲切自然' })
  assert.match(messages[0].content, /3000/)
  assert.match(messages[0].content, /2700 至 3300/)
  assert.match(messages[0].content, /不得虚构价格/)
  assert.match(messages[0].content, /不要 Markdown/)
  assert.equal(JSON.parse(messages[1].content).产品资料, '500ml水杯')
  assert.throws(() => buildLiveScriptMessages({ productIntro: ' ', requirements: '' }), /产品介绍/)
  assert.equal(countScriptCharacters('你 好\n😀'), 3)
})

test('话术标题与正文发生明显串稿时阻止再次保存和播报', () => {
  const study = saveLiveScript([], {
    title: '自习室直播',
    content: '自习室适合学习。自习室可以帮助专注。',
  })
  const wrong = {
    id: 'wrong',
    title: '北方周庄直播',
    content: study[0].content,
    updatedAt: '2026-01-01',
  }
  assert.equal(findScriptTopicConflict(wrong, [wrong, ...study])?.id, study[0].id)
  assert.throws(
    () => saveLiveScript(study, { title: wrong.title, content: wrong.content }),
    /正文多次提到/,
  )
  assert.equal(
    findScriptTopicConflict({ ...wrong, content: '今天带大家了解北方周庄。' }, [wrong, ...study]),
    undefined,
  )
})

test('保存修改与另存为分别更新旧版本和创建独立版本', () => {
  const first = saveLiveScript([], { title: '水杯版', content: '欢迎来到直播间。' })
  const updated = saveLiveScript(first, {
    id: first[0].id,
    title: '水杯新版',
    content: '修改后的讲解。',
  })
  assert.equal(updated.length, 1)
  assert.equal(updated[0].id, first[0].id)
  assert.equal(updated[0].content, '修改后的讲解。')
  const copied = saveLiveScript(updated, { title: '水杯晚间版', content: '晚上好。' })
  assert.equal(copied.length, 2)
  assert.notEqual(copied[0].id, copied[1].id)
  assert.equal(copied[1].content, '修改后的讲解。')
  assert.throws(() => saveLiveScript([], { title: '', content: '稿件' }), /名称/)
  assert.throws(
    () => saveLiveScript([], { id: 'missing', title: '稿件', content: '正文' }),
    /已删除/,
  )
})

test('保存话术时保留对应商品资料，切换版本不会继承另一款商品的资料', () => {
  const first = saveLiveScript([], {
    title: '北方周庄直播',
    content: '今天带大家看看北方周庄。',
    productIntro: '北方周庄景区',
    referenceText: '地址与开放时间以景区公告为准',
    scriptRequirements: '自然介绍景区',
  })
  assert.equal(first[0].productIntro, '北方周庄景区')
  assert.equal(first[0].referenceText, '地址与开放时间以景区公告为准')
  const updated = saveLiveScript(first, {
    id: first[0].id,
    title: first[0].title,
    content: '北方周庄的新讲解稿。',
  })
  assert.equal(updated[0].productIntro, '北方周庄景区')
  assert.equal(updated[0].scriptRequirements, '自然介绍景区')
})

test('长话术独立收集文本流与截断状态，分配足够的输出预算', async () => {
  const chunks: string[] = []
  const controller = new AbortController()
  const service = {
    /** 模拟模型流以检查参数、正文拼接与长度终止。 */
    async *chatStream(
      _messages: unknown,
      model: string,
      options: { maxTokens: number; signal: AbortSignal },
    ) {
      assert.equal(model, 'text-model')
      assert.equal(options.maxTokens, 8192)
      assert.equal(options.signal, controller.signal)
      yield { content: '欢迎来到直播间。' }
      yield { content: '今天介绍这款水杯。' }
      yield { finishReason: 'length' }
    },
  }
  const result = await generateLiveScript(
    { productIntro: '水杯', requirements: '' },
    'text-model',
    service,
    controller.signal,
    chunk => chunks.push(chunk),
  )
  assert.equal(result.text, chunks.join(''))
  assert.equal(result.truncated, true)
})

test('取消生成后不再发送后续正文，空结果报告错误', async () => {
  const controller = new AbortController()
  const chunks: string[] = []
  const service = {
    /** 第一段之后模拟用户取消，迟到的内容必须丢弃。 */
    async *chatStream() {
      yield { content: '第一段。' }
      controller.abort()
      yield { content: '迟到内容。' }
    },
  }
  await assert.rejects(
    generateLiveScript(
      { productIntro: '水杯', requirements: '' },
      'model',
      service,
      controller.signal,
      chunk => chunks.push(chunk),
    ),
  )
  assert.deepEqual(chunks, ['第一段。'])
  await assert.rejects(
    generateLiveScript(
      { productIntro: '水杯', requirements: '' },
      'model',
      {
        /** 空流表示模型未产生可展示正文。 */
        async *chatStream() {
          yield { finishReason: 'stop' }
        },
      },
      new AbortController().signal,
      () => {},
    ),
    /未返回话术正文/,
  )
})
