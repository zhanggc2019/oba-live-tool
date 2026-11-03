import OpenAI, { AuthenticationError, NotFoundError } from 'openai'
import { getChatModelOptions, normalizeChatBaseURL } from 'shared/providers'
import { createLogger } from '#/logger'
import { providerService } from '#/services/ProviderService'

type ProviderType = string

interface ChatMessage {
  role: 'assistant' | 'system' | 'user'
  content: string
}

const checkAPIKeyErrors = {
  NotFoundError: '目标平台不支持测试 API KEY，你可以跳过测试直接使用',
  AuthenticationError: 'API KEY 验证失败，请确认是否输入正确',
  UnknownError: '未知错误',
} as const

interface CheckAPIKeySuccess {
  kind: 'success'
}

interface CheckAPIKeyFail {
  kind: 'fail'
  type: keyof typeof checkAPIKeyErrors
  message?: string
}

type CheckAPIKeyResult = CheckAPIKeySuccess | CheckAPIKeyFail

export class AIChatService {
  private logger: ReturnType<typeof createLogger> = createLogger('AI对话')
  private openai: OpenAI
  private constructor(
    private apiKey: string,
    private baseURL: string,
    private provider: ProviderType,
  ) {
    this.openai = new OpenAI({ apiKey, baseURL })
  }

  /** 所有文本入口共用同一厂商配置，兼容第三方 Chat Completions 地址。 */
  public static createService(apiKey: string, provider: ProviderType, customBaseURL?: string) {
    let baseURL: string
    if (provider === 'custom') {
      if (!customBaseURL) {
        throw new Error('使用自定义 provider 请提供 baseURL')
      }
      baseURL = normalizeChatBaseURL(customBaseURL)
    } else {
      const info = providerService.providers[provider]
      if (!info) throw new Error('所选模型提供商不存在，请重新配置')
      baseURL = info.baseURL
    }

    return new AIChatService(apiKey.trim(), baseURL, provider)
  }

  /** 生成文本流；长话术可指定输出预算与取消信号，普通聊天保持原行为。 */
  public async *chatStream(
    messages: ChatMessage[],
    model: string,
    options?: { signal: AbortSignal; maxTokens: number },
  ) {
    try {
      this.logger.debug('流式 chatStream 请求', { model })
      const stream = await this.openai.chat.completions.create(
        {
          model,
          messages,
          stream: true,
          ...getChatModelOptions(this.provider, model),
          ...(options ? { max_tokens: options.maxTokens } : {}),
        },
        options ? { signal: options.signal, maxRetries: 0 } : undefined,
      )

      let contentLength = 0
      let reasoningLength = 0

      for await (const chunk of stream) {
        if (!chunk.choices.length) continue
        const delta = chunk.choices[0].delta
        const { content, reasoning_content: reasoning } = delta as typeof delta & {
          reasoning_content?: string
        }

        contentLength += content?.length ?? 0
        reasoningLength += reasoning?.length ?? 0

        if (content || reasoning) {
          yield { content, reasoning }
        }
        if (chunk.choices[0].finish_reason) yield { finishReason: chunk.choices[0].finish_reason }
      }

      this.logger.debug('chatStream 响应完成', {
        contentLength,
        reasoningLength,
      })
    } catch (error) {
      this.logger.error('AI 不想回答：chatStream 错误', error)
      throw error
    }
  }

  /** 使用标准非流式接口生成直播回复，并仅返回回答正文供 TTS 播放。 */
  public async chat(messages: ChatMessage[], model: string) {
    try {
      this.logger.debug('非流式 chat 请求', { model })

      const response = await this.openai.chat.completions.create({
        model,
        messages,
        stream: false,
        ...getChatModelOptions(this.provider, model),
      })

      const output = response.choices[0].message.content ?? ''

      this.logger.debug('chat 响应完成', { outputLength: output.length })

      return output
    } catch (error) {
      this.logger.error('AI 不想回答：chat 错误', error)
      throw error
    }
  }

  public async checkAPIKey() {
    let result: CheckAPIKeyResult
    if (this.provider === 'openrouter') {
      result = await this.checkOpenRouterAPIKey()
    } else {
      result = await this.checkDefaultAPIKey()
    }

    if (result.kind === 'fail') {
      switch (result.type) {
        case 'NotFoundError':
          this.logger.error(checkAPIKeyErrors.NotFoundError)
          throw new Error(checkAPIKeyErrors.NotFoundError)
        case 'AuthenticationError':
          this.logger.error(checkAPIKeyErrors.AuthenticationError)
          throw new Error(checkAPIKeyErrors.AuthenticationError)
        default: {
          const errorMessage = `${checkAPIKeyErrors.UnknownError}: ${result.message}`
          this.logger.error(errorMessage)
          throw new Error(errorMessage)
        }
      }
    }

    this.logger.success('API Key 通过测试！你的 API Key 大概率是有效的')
  }

  private async checkDefaultAPIKey(): Promise<CheckAPIKeyResult> {
    try {
      await this.openai.models.list()
      return {
        kind: 'success',
      }
    } catch (error) {
      if (error instanceof NotFoundError) {
        return {
          kind: 'fail',
          type: 'NotFoundError',
        }
      }
      if (error instanceof AuthenticationError) {
        return {
          kind: 'fail',
          type: 'AuthenticationError',
        }
      }
      return {
        kind: 'fail',
        type: 'UnknownError',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async checkOpenRouterAPIKey(): Promise<CheckAPIKeyResult> {
    const url = `${providerService.providers.openrouter.baseURL}/credits`
    const options = {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.apiKey}` },
    }
    const resp = await fetch(url, options)
    const data = await resp.json()
    switch (resp.status) {
      case 200:
        return {
          kind: 'success',
        }
      case 401: {
        return {
          kind: 'fail',
          type: 'AuthenticationError',
        }
      }
      default: {
        return {
          kind: 'fail',
          type: 'UnknownError',
          message: `${data?.error?.message}, CODE: ${data?.error?.code}`,
        }
      }
    }
  }
}
