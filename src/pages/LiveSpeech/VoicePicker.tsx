import { Volume2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import {
  MIMO_VOICES,
  QWEN_VOICES,
  TTS_PRESETS,
  type TtsProviderId,
  type TtsSettings,
  type TtsVoice,
} from 'shared/voice'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface Props {
  accountId: string
  provider: TtsProviderId
  settings: TtsSettings
  onSelect: (voice: string) => void
  onPreview: () => void
  previewDisabled: boolean
}

const providerNames: Record<TtsProviderId, string> = {
  mimo: '小米 MiMo V2.5',
  lanyun: '蓝云 TTS',
  qwen: '阿里千问 TTS',
  'openai-compatible': 'OpenAI 兼容厂商',
}

/** 展示 MiMo、千问预置音色及当前自定义音色；蓝云目录按身份查询。 */
export function VoicePicker({
  accountId,
  provider,
  settings,
  onSelect,
  onPreview,
  previewDisabled,
}: Props) {
  const identity = JSON.stringify([
    accountId,
    provider,
    settings.baseURL,
    settings.userId,
    settings.voiceIdType,
  ])
  const { baseURL, userId, voiceIdType } = settings
  const [catalog, setCatalog] = useState<{ identity: string; voices: TtsVoice[]; status: string }>({
    identity: '',
    voices: [],
    status: '',
  })
  const currentCatalog = catalog.identity === identity ? catalog : { voices: [], status: '' }

  useEffect(() => {
    if (provider !== 'lanyun' || voiceIdType === 'external_voice_id') return
    let active = true
    const requestId = crypto.randomUUID()
    const voiceSettings = { ...TTS_PRESETS.lanyun, baseURL, userId }
    setCatalog({ identity, voices: [], status: '正在读取可用音色…' })
    /** 查询密钥状态后获取蓝云音色；任何阶段的旧结果都不能写入新身份。 */
    const load = async () => {
      try {
        const hasKey = await window.ipcRenderer.invoke(IPC_CHANNELS.tts.hasKey, 'lanyun')
        if (!active) return
        if (!hasKey) {
          setCatalog({ identity, voices: [], status: '请先在音色克隆页面保存蓝云 API Key' })
          return
        }
        const voices = await window.ipcRenderer.invoke(IPC_CHANNELS.tts.listVoices, {
          requestId,
          settings: voiceSettings,
        })
        if (active)
          setCatalog({ identity, voices, status: voices.length ? '' : '当前身份暂无可用音色' })
      } catch (error) {
        if (active)
          setCatalog({
            identity,
            voices: [],
            status: error instanceof Error ? error.message : '音色列表获取失败',
          })
      }
    }
    void load()
    return () => {
      active = false
      void window.ipcRenderer.invoke(IPC_CHANNELS.tts.cancel, requestId).catch(() => {})
    }
  }, [identity, provider, voiceIdType, baseURL, userId])

  const options = useMemo(() => {
    if (provider === 'mimo')
      return MIMO_VOICES.map(id => ({ id, label: id === 'mimo_default' ? 'MiMo 默认音色' : id }))
    const listed =
      provider === 'lanyun' && settings.voiceIdType !== 'external_voice_id'
        ? currentCatalog.voices.map(voice => ({
            id: voice.id,
            label: `${voice.name}${voice.isPrivate ? ' · 私人' : ''} · ${voice.id}`,
          }))
        : provider === 'qwen'
          ? QWEN_VOICES.map(voice => ({ id: voice.id, label: voice.name }))
          : []
    if (settings.voice && !listed.some(voice => voice.id === settings.voice))
      listed.unshift({ id: settings.voice, label: `当前音色 · ${settings.voice}` })
    return listed
  }, [provider, settings.voice, settings.voiceIdType, currentCatalog.voices])

  return (
    <div className="space-y-2">
      <Label htmlFor="broadcast-voice">本场播报音色</Label>
      <div className="flex gap-2">
        <Select
          value={settings.voice || undefined}
          onValueChange={onSelect}
          disabled={!options.length}
        >
          <SelectTrigger id="broadcast-voice" className="min-w-0 flex-1 bg-background">
            <SelectValue placeholder="请先配置音色" />
          </SelectTrigger>
          <SelectContent>
            {options.map(voice => (
              <SelectItem key={voice.id} value={voice.id}>
                {voice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          disabled={!settings.voice.trim() || previewDisabled}
          onClick={onPreview}
        >
          <Volume2 className="h-4 w-4" />
          试听音色
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        当前厂商：{providerNames[provider]}。
        {provider === 'lanyun'
          ? settings.voiceIdType === 'external_voice_id'
            ? '外部映射 ID 由厂商提供，请在音色克隆页面填写。'
            : currentCatalog.status || '已读取当前身份可用音色。'
          : provider === 'openai-compatible'
            ? '兼容厂商没有统一的音色目录，请在音色克隆页面填写 Voice ID。'
            : '切换后将在下一次开始播报时生效。'}{' '}
        <Link to="/tts-settings" className="text-primary underline">
          配置声音
        </Link>
      </p>
    </div>
  )
}
