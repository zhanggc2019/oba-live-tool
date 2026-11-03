import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getChatModelOptions,
  mergeProviders,
  normalizeChatBaseURL,
  providers,
} from '../shared/providers'

test('旧缓存和远端模型目录更新后仍保留 Qwen3-8B，并保留新厂商', () => {
  const oldCatalog = {
    siliconflow: { ...providers.siliconflow, models: ['deepseek-ai/DeepSeek-V3.2'] },
    custom: { ...providers.custom, name: '自定义' },
    thirdparty: {
      name: '新增厂商',
      baseURL: 'https://example.com/v1',
      apiUrl: '',
      models: ['demo'],
    },
  }
  const merged = mergeProviders(oldCatalog)
  assert.deepEqual(merged.siliconflow.models, ['Qwen/Qwen3-8B', 'deepseek-ai/DeepSeek-V3.2'])
  assert.equal(merged.custom.name, '其他 OpenAI 兼容服务')
  assert.equal(merged.thirdparty.models[0], 'demo')
  assert.deepEqual(mergeProviders(merged), merged)
  assert.deepEqual(oldCatalog.siliconflow.models, ['deepseek-ai/DeepSeek-V3.2'])
})

test('兼容基础地址、完整聊天端点和本机模型服务，不重复拼接接口路径', () => {
  assert.equal(normalizeChatBaseURL(' https://api.example.com/v1/ '), 'https://api.example.com/v1')
  assert.equal(
    normalizeChatBaseURL('https://example.com/openai/v1/chat/completions/'),
    'https://example.com/openai/v1',
  )
  assert.equal(normalizeChatBaseURL('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/v1')
  assert.equal(
    normalizeChatBaseURL('https://example.com/compatible-mode/v1'),
    'https://example.com/compatible-mode/v1',
  )
  for (const value of [
    '',
    'example.com',
    'file:///tmp/api',
    'https://user:key@example.com/v1',
    'https://example.com/v1?key=secret',
  ])
    assert.throws(() => normalizeChatBaseURL(value), /接口地址/)
})

test('仅硅基流动 Qwen3-8B 添加非思考参数，通用兼容模型不发送厂商专有字段', () => {
  assert.deepEqual(getChatModelOptions('siliconflow', 'Qwen/Qwen3-8B'), { enable_thinking: false })
  assert.deepEqual(getChatModelOptions('custom', 'Qwen/Qwen3-8B'), {})
  assert.deepEqual(getChatModelOptions('siliconflow', 'deepseek-ai/DeepSeek-R1'), {})
  assert.deepEqual(getChatModelOptions('openrouter', 'qwen/qwen3-8b'), {})
})
