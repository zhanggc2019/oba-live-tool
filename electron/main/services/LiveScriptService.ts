import {
  buildLiveScriptMessages,
  type ContinuationScriptInput,
  type LiveScriptInput,
} from '../../../shared/liveScript'

interface ScriptChunk {
  content?: string | null
  finishReason?: string
}
interface ScriptModel {
  chatStream(
    messages: { role: 'system' | 'user'; content: string }[],
    model: string,
    options: { signal: AbortSignal; maxTokens: number },
  ): AsyncIterable<ScriptChunk>
}

/** 独立的长文生成流程，隔离聊天事件并保留流式生成结果。 */
export async function generateLiveScript(
  input: LiveScriptInput | ContinuationScriptInput,
  model: string,
  service: ScriptModel,
  signal: AbortSignal,
  onChunk: (chunk: string) => void,
): Promise<{ text: string; truncated: boolean }> {
  const messages = buildLiveScriptMessages(input)
  let text = ''
  let truncated = false
  for await (const chunk of service.chatStream(messages, model, { signal, maxTokens: 8192 })) {
    signal.throwIfAborted()
    if (chunk.finishReason === 'length') truncated = true
    if (chunk.content) {
      if (text.length + chunk.content.length > 20000)
        throw new Error('生成内容过长，已停止，请调整补充要求')
      text += chunk.content
      onChunk(chunk.content)
    }
  }
  signal.throwIfAborted()
  if (!text.trim()) throw new Error('AI 未返回话术正文，请检查模型是否支持文本生成')
  return { text: text.trim(), truncated }
}
