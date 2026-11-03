import { IPC_CHANNELS } from 'shared/ipcChannels'
import { buildLiveScriptMessages, type LiveScriptResult } from 'shared/liveScript'
import { AIChatService } from '../services/AIChatServices'
import { generateLiveScript } from '../services/LiveScriptService'
import { typedIpcMainHandle } from '../utils/ipc'

const requests = new Map<string, AbortController>()

/** 注册带请求标识的长话术生成与取消，不干扰 AI 聊天或直播问答。 */
export function setupLiveScriptIpcHandlers() {
  typedIpcMainHandle(IPC_CHANNELS.liveScript.cancel, (event, requestId) => {
    requests.get(`${event.sender.id}:${requestId}`)?.abort()
  })
  typedIpcMainHandle(
    IPC_CHANNELS.liveScript.generate,
    async (event, request): Promise<LiveScriptResult> => {
      if (
        !request ||
        typeof request.requestId !== 'string' ||
        request.requestId.length > 100 ||
        !request.accountId ||
        request.accountId.length > 100 ||
        !request.apiKey?.trim() ||
        !request.model?.trim() ||
        !request.provider?.trim()
      ) {
        throw new Error('请先配置文本生成模型与 API Key')
      }
      buildLiveScriptMessages(request)
      const id = `${event.sender.id}:${request.requestId}`
      if (requests.has(id) || requests.size >= 3) throw new Error('已有话术正在生成，请稍后重试')
      const controller = new AbortController()
      requests.set(id, controller)
      let partial = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, 180_000)
      /** 页面销毁后停止外部模型请求。 */
      const abort = () => controller.abort()
      /** Hash 路由切换不影响生成，完整刷新则取消请求。 */
      const onNavigation = (details: { isSameDocument: boolean; isMainFrame: boolean }) => {
        if (details.isMainFrame && !details.isSameDocument) abort()
      }
      event.sender.once('destroyed', abort)
      event.sender.on('did-start-navigation', onNavigation)
      try {
        const service = AIChatService.createService(
          request.apiKey,
          request.provider,
          request.customBaseURL,
        )
        const result = await generateLiveScript(
          request,
          request.model,
          service,
          controller.signal,
          chunk => {
            partial += chunk
            if (!event.sender.isDestroyed())
              event.sender.send(IPC_CHANNELS.liveScript.progress, {
                requestId: request.requestId,
                accountId: request.accountId,
                chunk,
              })
          },
        )
        return { ...result, cancelled: false }
      } catch (error) {
        if (controller.signal.aborted)
          return {
            text: partial,
            cancelled: true,
            truncated: false,
            ...(timedOut ? { error: '生成超过 3 分钟，已保留当前内容，请重试或调整模型' } : {}),
          }
        const message = error instanceof Error ? error.message : '话术生成失败'
        return {
          text: partial,
          cancelled: false,
          truncated: false,
          error: message.replaceAll(request.apiKey, '[已隐藏]'),
        }
      } finally {
        clearTimeout(timer)
        requests.delete(id)
        event.sender.removeListener('destroyed', abort)
        event.sender.removeListener('did-start-navigation', onNavigation)
      }
    },
  )
}
