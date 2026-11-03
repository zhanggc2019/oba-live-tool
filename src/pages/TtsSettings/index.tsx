import { useEffect, useState } from 'react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { normalizeSpeechPacing, prepareSpeechPacing } from 'shared/speechPacing'
import {
  MIMO_VOICES,
  QWEN_VOICES,
  splitSpeechText,
  TTS_PRESETS,
  type TtsProviderId,
} from 'shared/voice'
import { Title } from '@/components/common/Title'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useAccounts } from '@/hooks/useAccounts'
import { useToast } from '@/hooks/useToast'
import { createVoiceConfig, useVoiceConfigStore } from '@/hooks/useVoiceConfig'
import { previewVoice } from '@/services/voice/runtime'
import { LanyunSettings } from './LanyunSettings'
import { SpeechPacingSettings } from './SpeechPacingSettings'
import { VoiceClone } from './VoiceClone'

/** 配置可切换的 TTS 厂商与声卡，密钥只发送主进程加密保存。 */
export default function TtsSettingsPage() {
  const accountId = useAccounts(state => state.currentAccountId)
  const stored = useVoiceConfigStore(state => state.contexts[accountId])
  const config = { ...createVoiceConfig(), ...stored }
  const pacing = normalizeSpeechPacing(config.speechPacing)
  const update = useVoiceConfigStore(state => state.update)
  const updateProvider = useVoiceConfigStore(state => state.updateProvider)
  const settings = { ...TTS_PRESETS[config.provider], ...config.providers[config.provider] }
  const [apiKey, setApiKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [keyRevision, setKeyRevision] = useState(0)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [preview, setPreview] = useState('欢迎来到直播间，很高兴为大家介绍今天的产品。')
  const { toast } = useToast()

  useEffect(() => {
    let active = true
    setApiKey('')
    setHasKey(false)
    window.ipcRenderer
      .invoke(IPC_CHANNELS.tts.hasKey, config.provider)
      .then(value => {
        if (active) setHasKey(value)
      })
      .catch(error => {
        if (active) toast.error(error instanceof Error ? error.message : '无法读取密钥状态')
      })
    return () => {
      active = false
    }
  }, [config.provider, toast])

  useEffect(() => {
    /** 刷新输出设备清单，保留失联设备的选择以便用户明确修复。 */
    const refresh = () => {
      navigator.mediaDevices
        ?.enumerateDevices()
        .then(items => setDevices(items.filter(item => item.kind === 'audiooutput')))
        .catch(() => {})
    }
    refresh()
    navigator.mediaDevices?.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh)
  }, [])

  /** 保存输入密钥后立即从输入框移除，不从主进程读回明文。 */
  async function saveKey() {
    setSaving(true)
    try {
      await window.ipcRenderer.invoke(IPC_CHANNELS.tts.saveKey, config.provider, apiKey)
      setHasKey(Boolean(apiKey.trim()))
      setApiKey('')
      setKeyRevision(value => value + 1)
      toast.success('TTS 密钥已加密保存')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '密钥保存失败')
    } finally {
      setSaving(false)
    }
  }

  /** 用户主动授权麦克风后读取设备名称；立即释放流，不保留录音。 */
  async function discoverDevices() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const track of stream.getTracks()) track.stop()
      const items = await navigator.mediaDevices.enumerateDevices()
      setDevices(items.filter(item => item.kind === 'audiooutput'))
      toast.success('音频设备已刷新')
    } catch {
      toast.error('无法读取设备名称，请检查 Windows 麦克风权限；也可使用默认输出设备')
    }
  }

  /** 播放测试句，使用与直播一致的厂商、音色及设备。 */
  function audition() {
    try {
      previewVoice(accountId, preview)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '试听失败')
    }
  }

  return (
    <div className="container space-y-6 py-6">
      <Title
        title="音色克隆"
        description="上传保存蓝云私人音色；厂商、音色及输出设置按直播账号保存"
      />
      <VoiceClone
        settings={settings}
        hasKey={hasKey && !saving}
        onCreated={voice =>
          updateProvider(accountId, 'lanyun', { voice: voice.id, voiceIdType: 'voice_id' })
        }
      />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>TTS 厂商</CardTitle>
            <CardDescription>
              正在播报时的配置修改，下次开始生效。密钥按厂商在本机共用。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Label htmlFor="tts-provider">厂商</Label>
            <Select
              disabled={saving}
              value={config.provider}
              onValueChange={value => update(accountId, { provider: value as TtsProviderId })}
            >
              <SelectTrigger id="tts-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mimo">小米 MiMo V2.5 TTS</SelectItem>
                <SelectItem value="lanyun">蓝云 TTS（IndexTTS-2.5）</SelectItem>
                <SelectItem value="qwen">阿里千问 TTS（Qwen Audio 3.1 Flash）</SelectItem>
                <SelectItem value="openai-compatible">OpenAI 兼容语音厂商</SelectItem>
              </SelectContent>
            </Select>
            <div className="space-y-2">
              <Label htmlFor="tts-url">API 基础地址</Label>
              <Input
                id="tts-url"
                value={settings.baseURL}
                disabled={config.provider === 'mimo'}
                placeholder={
                  config.provider === 'qwen'
                    ? 'https://业务空间ID.cn-beijing.maas.aliyuncs.com/api/v1'
                    : 'https://厂商域名/v1'
                }
                onChange={event =>
                  updateProvider(accountId, config.provider, { baseURL: event.target.value })
                }
              />
              {config.provider === 'qwen' && (
                <p className="text-xs text-muted-foreground">
                  将地址中的业务空间 ID 换为百炼控制台的实际 ID；新加坡地域将 cn-beijing 改为
                  ap-southeast-1，并使用同地域 API Key。
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="tts-key">API Key {hasKey ? '· 已保存' : '· 未配置'}</Label>
              <div className="flex gap-2">
                <Input
                  id="tts-key"
                  type="password"
                  autoComplete="new-password"
                  value={apiKey}
                  placeholder={hasKey ? '输入新密钥可替换' : '粘贴厂商 API Key'}
                  onChange={event => setApiKey(event.target.value)}
                />
                <Button disabled={saving || !apiKey.trim()} onClick={saveKey}>
                  保存密钥
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="tts-model">模型</Label>
              <Input
                id="tts-model"
                value={settings.model}
                disabled={config.provider === 'lanyun' || config.provider === 'qwen'}
                maxLength={200}
                onChange={event =>
                  updateProvider(accountId, config.provider, { model: event.target.value })
                }
              />
            </div>
            {config.provider === 'lanyun' ? (
              <LanyunSettings
                key={accountId}
                settings={settings}
                hasKey={hasKey && !saving}
                keyRevision={keyRevision}
                dynamicRate={pacing.enabled}
                onChange={patch => updateProvider(accountId, 'lanyun', patch)}
              />
            ) : (
              <div className="space-y-2">
                <Label htmlFor="tts-voice">音色</Label>
                {config.provider === 'mimo' ? (
                  <Select
                    value={settings.voice}
                    onValueChange={value =>
                      updateProvider(accountId, config.provider, { voice: value })
                    }
                  >
                    <SelectTrigger id="tts-voice">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MIMO_VOICES.map(voice => (
                        <SelectItem key={voice} value={voice}>
                          {voice === 'mimo_default' ? 'MiMo 默认音色' : voice}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : config.provider === 'qwen' ? (
                  <>
                    <Select
                      value={settings.voice}
                      onValueChange={value => updateProvider(accountId, 'qwen', { voice: value })}
                    >
                      <SelectTrigger id="tts-voice">
                        <SelectValue placeholder="选择音色或填写音色 ID" />
                      </SelectTrigger>
                      <SelectContent>
                        {settings.voice &&
                          !QWEN_VOICES.some(voice => voice.id === settings.voice) && (
                            <SelectItem value={settings.voice}>
                              当前音色 · {settings.voice}
                            </SelectItem>
                          )}
                        {QWEN_VOICES.map(voice => (
                          <SelectItem key={voice.id} value={voice.id}>
                            {voice.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Label htmlFor="qwen-voice-id">音色 ID（可填写其他系统或复刻音色）</Label>
                    <Input
                      id="qwen-voice-id"
                      value={settings.voice}
                      maxLength={200}
                      onChange={event =>
                        updateProvider(accountId, 'qwen', { voice: event.target.value })
                      }
                    />
                  </>
                ) : (
                  <Input
                    id="tts-voice"
                    value={settings.voice}
                    maxLength={200}
                    placeholder="厂商提供的 Voice ID"
                    onChange={event =>
                      updateProvider(accountId, config.provider, { voice: event.target.value })
                    }
                  />
                )}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="tts-style">
                {config.provider === 'lanyun' ? '情感描述（可选）' : '朗读风格'}
              </Label>
              <Textarea
                id="tts-style"
                value={settings.instructions}
                maxLength={2000}
                placeholder="亲切自然、语速适中……"
                onChange={event =>
                  updateProvider(accountId, config.provider, { instructions: event.target.value })
                }
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {config.provider === 'lanyun'
                ? '蓝云模型由服务端管理。填写情感描述会启用文本情感控制，留空则使用音色默认表现。'
                : config.provider === 'qwen'
                  ? '使用阿里原生 TTS 接口。朗读风格用于控制情感、方言和角色；复刻音色须绑定当前模型，更多音色请确认地域支持。'
                  : '兼容厂商需支持 /audio/speech 与 WAV 输出；若不支持风格指令，请留空。MiMo 使用预置音色模型 mimo-v2.5-tts。'}
            </p>
          </CardContent>
        </Card>
        <div className="space-y-6">
          <SpeechPacingSettings
            settings={pacing}
            onChange={patch => update(accountId, { speechPacing: { ...pacing, ...patch } })}
          />
          <Card>
            <CardHeader>
              <CardTitle>声音输出</CardTitle>
              <CardDescription>本软件负责播放；直播软件负责把该音频送入直播间</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Label htmlFor="tts-output">输出设备</Label>
              <Select
                value={config.outputDeviceId}
                onValueChange={value => update(accountId, { outputDeviceId: value })}
              >
                <SelectTrigger id="tts-output">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">系统默认输出设备</SelectItem>
                  {devices
                    .filter(device => device.deviceId && device.deviceId !== 'default')
                    .map((device, index) => (
                      <SelectItem key={device.deviceId} value={device.deviceId}>
                        {device.label || `音频输出设备 ${index + 1}`}
                      </SelectItem>
                    ))}
                  {config.outputDeviceId !== 'default' &&
                    !devices.some(device => device.deviceId === config.outputDeviceId) && (
                      <SelectItem value={config.outputDeviceId}>
                        已保存的设备（暂未检测到）
                      </SelectItem>
                    )}
                </SelectContent>
              </Select>
              <Button variant="outline" onClick={discoverDevices}>
                授权读取设备名称 / 刷新
              </Button>
              <div className="space-y-2">
                <Label htmlFor="tts-volume">播放音量：{Math.round(config.volume * 100)}%</Label>
                <input
                  id="tts-volume"
                  className="w-full"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={config.volume}
                  onChange={event => update(accountId, { volume: Number(event.target.value) })}
                />
              </div>
              <div className="rounded-md bg-muted p-3 text-sm space-y-2">
                <p>OBS / 直播伴侣：添加本软件的应用音频采集；或采集这里所选设备的桌面音频。</p>
                <p>
                  虚拟声卡：这里选择虚拟声卡的播放端，再把其录音端设为直播软件的麦克风。声卡需自行安装并配置。
                </p>
                <p>
                  先试听并观察直播软件音量条，再正式播报。不要同时采集桌面音频和同一路虚拟麦克风，以免重音。
                </p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>合成试听</CardTitle>
              <CardDescription>
                播放时提前合成后两句；相同文本和配置可复用本次运行的音频缓存
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                aria-label="试听文字"
                value={preview}
                maxLength={1000}
                onChange={event => setPreview(event.target.value)}
              />
              <fieldset
                className="space-y-2 rounded-md bg-muted p-3 text-xs"
                aria-label="分句语速预览"
              >
                <p className="font-medium">分句语速预览（最多 4 句）</p>
                {[...new Set(splitSpeechText(preview))].slice(0, 4).map(text => {
                  const plan = prepareSpeechPacing(
                    text,
                    settings,
                    pacing,
                    config.scriptRequirements,
                  )
                  return (
                    <div key={text} className="flex items-start gap-2">
                      <span className="shrink-0 font-medium">{plan.rate.toFixed(2)}×</span>
                      <span className="min-w-0 truncate" title={`${text}\n${plan.reason}`}>
                        {text}
                      </span>
                    </div>
                  )
                })}
              </fieldset>
              <Button
                disabled={!hasKey || saving || !settings.voice.trim() || !preview.trim()}
                onClick={audition}
              >
                合成并播放
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
