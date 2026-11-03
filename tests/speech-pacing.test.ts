import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_SPEECH_PACING,
  normalizeSpeechPacing,
  planSpeechPacing,
  prepareSpeechPacing,
} from '../shared/speechPacing'
import { TTS_PRESETS } from '../shared/voice'

test('旧配置默认启用 0.85～1.15，非法数值、倒置范围及部分配置可恢复', () => {
  assert.deepEqual(normalizeSpeechPacing(), DEFAULT_SPEECH_PACING)
  assert.deepEqual(normalizeSpeechPacing(null), DEFAULT_SPEECH_PACING)
  assert.deepEqual(
    normalizeSpeechPacing({ minRate: Number.NaN, maxRate: Number.POSITIVE_INFINITY }),
    DEFAULT_SPEECH_PACING,
  )
  const inverted = normalizeSpeechPacing({ minRate: 5, maxRate: 0.1, enabled: false })
  assert.equal(inverted.minRate, 0.5)
  assert.equal(inverted.maxRate, 2)
  assert.equal(inverted.enabled, false)
  assert.equal(normalizeSpeechPacing({ style: 'calm' }).maxRate, 1.15)
  assert.equal(
    normalizeSpeechPacing({ requirements: '要求'.repeat(1000) }).requirements.length,
    1000,
  )
})

test('数字、中文金额、注意事项比欢迎和普通讲解慢，长句进一步放慢', () => {
  const welcome = planSpeechPacing('欢迎来到直播间！', DEFAULT_SPEECH_PACING).rate
  const ordinary = planSpeechPacing('这里的学习环境很不错。', DEFAULT_SPEECH_PACING).rate
  const amount = planSpeechPacing('费用为三十九元。', DEFAULT_SPEECH_PACING).rate
  const numeric = planSpeechPacing('营业时间为9点到21点。', DEFAULT_SPEECH_PACING).rate
  const caution = planSpeechPacing('请注意，体验券仅限本人使用。', DEFAULT_SPEECH_PACING).rate
  assert.ok(welcome > ordinary)
  assert.ok(ordinary > amount && ordinary > numeric)
  assert.ok(caution < ordinary)
  assert.ok(
    planSpeechPacing('这里的学习环境很不错'.repeat(10), DEFAULT_SPEECH_PACING).rate < ordinary,
  )
  assert.ok(planSpeechPacing('欢迎大家，价格是39元！', DEFAULT_SPEECH_PACING).rate < ordinary)
})

test('节奏倾向与直播间要求影响速度，专用要求优先于话术生成要求并处理常见否定', () => {
  const text = '这里提供舒适的学习环境。'
  const natural = planSpeechPacing(text, DEFAULT_SPEECH_PACING).rate
  assert.ok(planSpeechPacing(text, { ...DEFAULT_SPEECH_PACING, style: 'calm' }).rate < natural)
  assert.ok(planSpeechPacing(text, { ...DEFAULT_SPEECH_PACING, style: 'energetic' }).rate > natural)
  assert.ok(planSpeechPacing(text, DEFAULT_SPEECH_PACING, '自习室，安静舒缓').rate < natural)
  assert.ok(
    planSpeechPacing(text, { ...DEFAULT_SPEECH_PACING, requirements: '不要太快' }).rate < natural,
  )
  assert.ok(
    planSpeechPacing(text, { ...DEFAULT_SPEECH_PACING, requirements: '不要太慢' }).rate > natural,
  )
  assert.ok(
    planSpeechPacing(text, { ...DEFAULT_SPEECH_PACING, requirements: '轻快活泼' }, '舒缓').rate >
      natural,
  )
})

test('每句倍率严格落在指定区间，相同文字和配置规划稳定以复用缓存', () => {
  const texts = ['欢迎大家！', '请注意退款规则。', '今天39.9元。', '普通产品讲解。']
  for (const [minRate, maxRate] of [
    [0.85, 1.15],
    [0.9, 0.95],
    [1.1, 1.1],
    [0.5, 2],
  ]) {
    for (const style of ['natural', 'calm', 'energetic'] as const) {
      const settings = { ...DEFAULT_SPEECH_PACING, minRate, maxRate, style }
      for (const text of texts) {
        const plan = planSpeechPacing(text, settings)
        assert.ok(plan.rate >= minRate && plan.rate <= maxRate)
        assert.deepEqual(planSpeechPacing(text, settings), plan)
      }
    }
  }
})

test('蓝云覆盖固定倍率，播放器保持 1 倍；MiMo 和兼容厂商只在播放器调速', () => {
  for (const provider of Object.values(TTS_PRESETS)) {
    const settings = { ...provider, speechRate: 1.8 }
    const snapshot = { ...settings }
    const plan = prepareSpeechPacing('价格是39元。', settings, DEFAULT_SPEECH_PACING)
    assert.ok(plan.rate < 1 && plan.rate >= 0.85)
    if (provider.provider === 'lanyun') {
      assert.equal(plan.synthesisSettings.speechRate, plan.rate)
      assert.equal(plan.playbackRate, 1)
    } else {
      assert.deepEqual(plan.synthesisSettings, settings)
      assert.equal(plan.playbackRate, plan.rate)
    }
    assert.deepEqual(settings, snapshot, '逐句合成不能覆盖用户保存的固定倍率')
  }
})

test('关闭动态模式恢复蓝云固定倍率及其他厂商原速', () => {
  for (const provider of Object.values(TTS_PRESETS)) {
    const plan = prepareSpeechPacing(
      '欢迎大家！',
      { ...provider, speechRate: 1.2 },
      { ...DEFAULT_SPEECH_PACING, enabled: false },
    )
    assert.equal(plan.rate, provider.provider === 'lanyun' ? 1.2 : 1)
    assert.equal(plan.playbackRate, 1)
    assert.equal(plan.reason, '固定语速')
  }
})
