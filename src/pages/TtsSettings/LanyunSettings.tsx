import { useEffect, useRef, useState } from 'react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import type { TtsLanguage, TtsSettings, TtsVoice } from 'shared/voice'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/useToast'

interface Props {
  settings: TtsSettings
  hasKey: boolean
  keyRevision: number
  dynamicRate: boolean
  onChange: (patch: Partial<TtsSettings>) => void
}

/** 蓝云音色及原生参数配置；更换应用密钥或用户身份时清理过期目录。 */
export function LanyunSettings({ settings, hasKey, keyRevision, dynamicRate, onChange }: Props) {
  const identity = JSON.stringify([settings.baseURL, settings.userId, keyRevision, hasKey])
  const [catalog, setCatalog] = useState<{ identity: string; voices: TtsVoice[]; loaded: boolean }>(
    { identity, voices: [], loaded: false },
  )
  const { voices, loaded } = catalog.identity === identity ? catalog : { voices: [], loaded: false }
  const [loading, setLoading] = useState(false)
  const requestRef = useRef<string | null>(null)
  const { toast } = useToast()

  useEffect(() => {
    // 目录的可见范围由地址、应用密钥和用户身份共同决定。
    setCatalog({ identity, voices: [], loaded: false })
    setLoading(false)
    return () => {
      const id = requestRef.current
      requestRef.current = null
      if (id) window.ipcRenderer.invoke(IPC_CHANNELS.tts.cancel, id).catch(() => {})
    }
  }, [identity])

  /** 读取公开及当前用户可见的私人音色，忽略已取消或已切换身份的结果。 */
  async function loadVoices() {
    const requestId = crypto.randomUUID()
    requestRef.current = requestId
    setLoading(true)
    try {
      const items = await window.ipcRenderer.invoke(IPC_CHANNELS.tts.listVoices, {
        requestId,
        settings,
      })
      if (requestRef.current !== requestId) return
      setCatalog({ identity, voices: items, loaded: true })
      toast.success(items.length ? `已获取 ${items.length} 个音色` : '当前应用和用户暂无可用音色')
    } catch (error) {
      if (requestRef.current === requestId)
        toast.error(error instanceof Error ? error.message : '音色列表获取失败')
    } finally {
      if (requestRef.current === requestId) {
        requestRef.current = null
        setLoading(false)
      }
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="lanyun-user">用户 ID（私人音色需要）</Label>
        <Input
          id="lanyun-user"
          value={settings.userId ?? ''}
          maxLength={256}
          placeholder="公共音色可留空；私人音色填写所属业务用户 ID"
          onChange={event => onChange({ userId: event.target.value })}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="lanyun-id-type">音色 ID 类型</Label>
        <Select
          value={settings.voiceIdType ?? 'voice_id'}
          onValueChange={value =>
            onChange({ voiceIdType: value as TtsSettings['voiceIdType'], voice: '' })
          }
        >
          <SelectTrigger id="lanyun-id-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="voice_id">蓝云音色 ID（voice_id）</SelectItem>
            <SelectItem value="external_voice_id">外部映射 ID（external_voice_id）</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {settings.voiceIdType !== 'external_voice_id' && (
        <div className="space-y-2">
          <Label htmlFor="lanyun-voices">可用音色</Label>
          <div className="flex gap-2">
            <Select
              disabled={!voices.length || loading}
              value={voices.some(voice => voice.id === settings.voice) ? settings.voice : ''}
              onValueChange={value => onChange({ voice: value })}
            >
              <SelectTrigger id="lanyun-voices">
                <SelectValue placeholder={loaded ? '请选择音色' : '获取音色后选择'} />
              </SelectTrigger>
              <SelectContent>
                {voices.map(voice => (
                  <SelectItem key={voice.id} value={voice.id}>
                    {voice.name}
                    {voice.isPrivate ? ' · 私人' : ''} · {voice.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" disabled={!hasKey || loading} onClick={loadVoices}>
              {loading ? '获取中…' : '获取音色'}
            </Button>
          </div>
          {loaded && !voices.length && (
            <p className="text-xs text-muted-foreground">暂无可用音色，请检查应用权限和用户 ID。</p>
          )}
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="tts-voice">音色 ID</Label>
        <Input
          id="tts-voice"
          value={settings.voice}
          maxLength={settings.voiceIdType === 'external_voice_id' ? 128 : 64}
          placeholder={
            settings.voiceIdType === 'external_voice_id'
              ? '填写 external_voice_id'
              : '从目录选择，或直接填写 voice_id'
          }
          onChange={event => onChange({ voice: event.target.value })}
        />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-2">
          <Label htmlFor="lanyun-language">合成语言</Label>
          <Select
            value={settings.language ?? 'ZH'}
            onValueChange={value => onChange({ language: value as TtsLanguage })}
          >
            <SelectTrigger id="lanyun-language">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ZH">中文</SelectItem>
              <SelectItem value="EN">英文</SelectItem>
              <SelectItem value="JA">日文</SelectItem>
              <SelectItem value="ES">西班牙文</SelectItem>
              <SelectItem value="AR">阿拉伯文</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="lanyun-rate">语速倍率</Label>
          <Input
            id="lanyun-rate"
            disabled={dynamicRate}
            type="number"
            min={0.5}
            max={2}
            step={0.1}
            value={settings.speechRate ?? 1}
            onChange={event => onChange({ speechRate: Number(event.target.value) })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="lanyun-silence">段间停顿 / 毫秒</Label>
          <Input
            id="lanyun-silence"
            type="number"
            min={0}
            max={1000}
            step={10}
            value={settings.intervalSilence ?? 120}
            onChange={event => onChange({ intervalSilence: Number(event.target.value) })}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {dynamicRate && '动态语速已开启，合成时使用每句的倍率；关闭后恢复这里保存的固定倍率。'}
        段间停顿控制单次合成内部的间隔；分句播报的间隔仍由「直播话术」页设置。
      </p>
    </div>
  )
}
