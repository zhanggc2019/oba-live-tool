import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import type { SpeechAudio, TtsProviderId } from 'shared/voice'
import { validateCloneAudio } from 'shared/voiceClone'
import {
  listLanyunVoices,
  ttsProviders,
  uploadLanyunVoice,
  validateTtsSettings,
} from '../services/tts/providers'
import { typedIpcMainHandle } from '../utils/ipc'

const pending = new Map<string, AbortController>()
const voiceLists = new Map<string, AbortController>()
const cloneUploads = new Map<string, AbortController>()
const cache = new Map<string, SpeechAudio>()
let cacheSize = 0
const MAX_CACHE_SIZE = 32 * 1024 * 1024

/** 检查密钥归属厂商，避免任意文件名或未知适配器。 */
function checkProvider(provider: TtsProviderId) {
  if (!['mimo', 'lanyun', 'qwen', 'openai-compatible'].includes(provider))
    throw new Error('未知 TTS 厂商')
}

/** 使用 Windows 系统加密存储密钥，磁盘及前端配置中均不保存明文。 */
function keyFile(provider: TtsProviderId): string {
  checkProvider(provider)
  return path.join(app.getPath('userData'), 'tts-keys', `${provider}.bin`)
}

/** 仅在主进程解密密钥，前端只查询是否已配置。 */
function readKey(provider: TtsProviderId): string {
  const file = keyFile(provider)
  if (!existsSync(file)) return ''
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥加密服务不可用')
  return safeStorage.decryptString(readFileSync(file))
}

/** 注册合成、取消及密钥管理 IPC，主进程统一限流与缓存。 */
export function setupTtsIpcHandlers() {
  typedIpcMainHandle(IPC_CHANNELS.tts.hasKey, (_, provider) => Boolean(readKey(provider)))
  typedIpcMainHandle(IPC_CHANNELS.tts.saveKey, (_, provider, key) => {
    checkProvider(provider)
    if (typeof key !== 'string' || key.length > 4096) throw new Error('API Key 格式不正确')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥加密服务不可用')
    const file = keyFile(provider)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, safeStorage.encryptString(key.trim()))
    cache.clear()
    cacheSize = 0
  })
  typedIpcMainHandle(IPC_CHANNELS.tts.cancel, (event, requestId) => {
    pending.get(`${event.sender.id}:${requestId}`)?.abort()
    voiceLists.get(`${event.sender.id}:${requestId}`)?.abort()
    cloneUploads.get(`${event.sender.id}:${requestId}`)?.abort()
  })
  /** 音频在主进程再次校验，密钥仅用于向蓝云私人音色接口发起上传。 */
  typedIpcMainHandle(IPC_CHANNELS.tts.cloneVoice, async (event, request) => {
    if (
      !request ||
      typeof request.requestId !== 'string' ||
      !request.requestId ||
      request.requestId.length > 100
    )
      throw new Error('音色克隆请求标识无效')
    if (
      typeof request.name !== 'string' ||
      typeof request.fileName !== 'string' ||
      request.fileName.length > 255 ||
      /[\\/\0]/.test(request.fileName)
    )
      throw new Error('音色名称或文件名无效，请重新选择文件')
    validateCloneAudio(request.fileName, request.audio)
    if (request.settings?.provider !== 'lanyun') throw new Error('目前仅蓝云支持上传保存私人音色')
    validateTtsSettings(request.settings, false)
    const apiKey = readKey('lanyun')
    if (!apiKey) throw new Error('请先保存蓝云 API Key')
    const id = `${event.sender.id}:${request.requestId}`
    if (cloneUploads.has(id)) throw new Error('该音色正在上传，请稍后重试')
    const controller = new AbortController()
    cloneUploads.set(id, controller)
    const timer = setTimeout(() => controller.abort(), 120_000)
    /** 页面关闭或完整导航时取消尚未完成的上传。 */
    const abort = () => controller.abort()
    /** Hash 路由切换不取消上传，页面导航会停止请求。 */
    const onNavigation = (details: { isSameDocument: boolean; isMainFrame: boolean }) => {
      if (details.isMainFrame && !details.isSameDocument) abort()
    }
    event.sender.once('destroyed', abort)
    event.sender.on('did-start-navigation', onNavigation)
    try {
      return await uploadLanyunVoice(
        request.name,
        request.fileName,
        request.audio,
        request.settings,
        apiKey,
        controller.signal,
      )
    } catch (error) {
      if (controller.signal.aborted) throw new Error('音色上传已取消或超过 120 秒，请重新上传')
      throw error
    } finally {
      clearTimeout(timer)
      cloneUploads.delete(id)
      event.sender.removeListener('destroyed', abort)
      event.sender.removeListener('did-start-navigation', onNavigation)
    }
  })
  /** 仅主进程带密钥查询目录，允许尚未选中音色时获取可用项。 */
  typedIpcMainHandle(IPC_CHANNELS.tts.listVoices, async (event, request) => {
    if (
      !request ||
      typeof request.requestId !== 'string' ||
      !request.requestId ||
      request.requestId.length > 100
    ) {
      throw new Error('音色列表请求标识无效')
    }
    if (request.settings?.provider !== 'lanyun') throw new Error('当前厂商不支持获取音色列表')
    validateTtsSettings(request.settings, false)
    const key = readKey('lanyun')
    if (!key) throw new Error('请先保存蓝云 API Key')
    const id = `${event.sender.id}:${request.requestId}`
    for (const [otherId, controller] of voiceLists) {
      if (otherId.startsWith(`${event.sender.id}:`)) controller.abort()
    }
    const controller = new AbortController()
    voiceLists.set(id, controller)
    const timer = setTimeout(() => controller.abort(), 30_000)
    /** 页面刷新或关闭后停止音色查询，释放网络连接。 */
    const abort = () => controller.abort()
    /** 页面内部切换由调用方取消，完整导航由主进程兜底。 */
    const onNavigation = (details: { isSameDocument: boolean; isMainFrame: boolean }) => {
      if (details.isMainFrame && !details.isSameDocument) abort()
    }
    event.sender.once('destroyed', abort)
    event.sender.on('did-start-navigation', onNavigation)
    try {
      return await listLanyunVoices(request.settings, key, controller.signal)
    } catch (error) {
      if (controller.signal.aborted) throw new Error('音色列表查询已取消或超过 30 秒，请重试')
      throw error
    } finally {
      clearTimeout(timer)
      if (voiceLists.get(id) === controller) voiceLists.delete(id)
      event.sender.removeListener('destroyed', abort)
      event.sender.removeListener('did-start-navigation', onNavigation)
    }
  })
  typedIpcMainHandle(IPC_CHANNELS.tts.synthesize, async (event, request) => {
    if (
      !request ||
      typeof request.text !== 'string' ||
      !request.text.trim() ||
      request.text.length > 2000 ||
      typeof request.requestId !== 'string' ||
      request.requestId.length > 100
    ) {
      throw new Error('待合成内容或请求标识无效')
    }
    validateTtsSettings(request.settings)
    const key = readKey(request.settings.provider)
    if (!key) throw new Error('请先在语音合成设置中保存 API Key')
    const cacheKey = createHash('sha256')
      .update(JSON.stringify([request.text, request.settings, key]))
      .digest('hex')
    const cached = cache.get(cacheKey)
    if (cached) {
      cache.delete(cacheKey)
      cache.set(cacheKey, cached)
      return cached
    }
    const id = `${event.sender.id}:${request.requestId}`
    const activeRequests = [...pending.values()].filter(
      controller => !controller.signal.aborted,
    ).length
    if (pending.has(id) || activeRequests >= 2) throw new Error('语音合成繁忙，请稍后重试')
    const controller = new AbortController()
    pending.set(id, controller)
    const timeoutMs = request.settings.provider === 'lanyun' ? 180_000 : 60_000
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    /** 页面退出或刷新时取消对应的外部合成请求。 */
    const abort = () => controller.abort()
    /** 仅完整页面导航会终止会话，Hash 路由切页继续合成。 */
    const onNavigation = (details: { isSameDocument: boolean; isMainFrame: boolean }) => {
      if (details.isMainFrame && !details.isSameDocument) abort()
    }
    event.sender.once('destroyed', abort)
    event.sender.on('did-start-navigation', onNavigation)
    try {
      const audio = await ttsProviders[request.settings.provider].synthesize(
        request.text.trim(),
        request.settings,
        key,
        controller.signal,
      )
      controller.signal.throwIfAborted()
      while (cacheSize + audio.base64.length > MAX_CACHE_SIZE && cache.size) {
        const oldest = cache.keys().next().value as string
        cacheSize -= cache.get(oldest)?.base64.length ?? 0
        cache.delete(oldest)
      }
      if (audio.base64.length <= MAX_CACHE_SIZE) {
        cache.set(cacheKey, audio)
        cacheSize += audio.base64.length
      }
      return audio
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error(`语音合成已取消或超过 ${timeoutMs / 1000} 秒，请重试`)
      throw error
    } finally {
      clearTimeout(timer)
      pending.delete(id)
      event.sender.removeListener('destroyed', abort)
      event.sender.removeListener('did-start-navigation', onNavigation)
    }
  })
}
