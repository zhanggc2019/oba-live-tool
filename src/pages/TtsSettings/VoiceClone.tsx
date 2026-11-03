import { useEffect, useRef, useState } from 'react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import type { TtsSettings, TtsVoice } from 'shared/voice'
import { MAX_CLONE_AUDIO_BYTES, validateCloneAudio } from 'shared/voiceClone'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/hooks/useToast'

interface Props {
  settings: TtsSettings
  hasKey: boolean
  onCreated: (voice: TtsVoice) => void
}

/** 保存蓝云私人音色：上传前检查大小及真实文件标识，成功后选中新音色。 */
export function VoiceClone({ settings, hasKey, onCreated }: Props) {
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<{ fileName: string; audio: Uint8Array } | null>(null)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [created, setCreated] = useState<TtsVoice | null>(null)
  const requestRef = useRef<string | null>(null)
  const { toast } = useToast()

  useEffect(
    () => () => {
      if (requestRef.current)
        void window.ipcRenderer.invoke(IPC_CHANNELS.tts.cancel, requestRef.current).catch(() => {})
    },
    [],
  )

  /** 选中文件时立即检查格式、大小和文件头，失败后允许重新选同一个文件。 */
  async function chooseFile(file: File | undefined) {
    setSelected(null)
    setCreated(null)
    setError('')
    if (!file) return
    try {
      if (file.size > MAX_CLONE_AUDIO_BYTES)
        throw new Error('音频文件超过 10 MiB，请压缩后重新上传')
      const audio = new Uint8Array(await file.arrayBuffer())
      validateCloneAudio(file.name, audio)
      setSelected({ fileName: file.name, audio })
      if (!name.trim()) setName(file.name.replace(/\.[^.]+$/, '').slice(0, 80))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '音频文件无法读取，请重新上传')
    }
  }

  /** 把通过本地校验的录音交给主进程上传，成功后保存新 voice_id。 */
  async function upload() {
    if (!selected || uploading) return
    if (!name.trim() || name.trim().length > 80) {
      setError('请输入 1 到 80 个字符的音色名称')
      return
    }
    if (!settings.userId?.trim()) {
      setError('请先在蓝云设置中填写用户 ID，私人音色将保存到该用户')
      return
    }
    const requestId = crypto.randomUUID()
    requestRef.current = requestId
    setUploading(true)
    setError('')
    try {
      const voice = await window.ipcRenderer.invoke(IPC_CHANNELS.tts.cloneVoice, {
        requestId,
        name: name.trim(),
        fileName: selected.fileName,
        audio: selected.audio,
        settings,
      })
      if (requestRef.current !== requestId) return
      onCreated(voice)
      setCreated(voice)
      setSelected(null)
      toast.success(`音色「${voice.name}」已保存并选中`)
    } catch (caught) {
      if (requestRef.current === requestId)
        setError(caught instanceof Error ? caught.message : '音色上传失败，请重新上传')
    } finally {
      if (requestRef.current === requestId) {
        requestRef.current = null
        setUploading(false)
      }
    }
  }

  return (
    <Card id="voice-clone">
      <CardHeader>
        <CardTitle>克隆私人音色</CardTitle>
        <CardDescription>
          上传一段清晰的单人录音，保存后可在开播前选择和试听。目前由蓝云 TTS 提供此功能。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="clone-voice-name">音色名称</Label>
            <Input
              id="clone-voice-name"
              value={name}
              maxLength={80}
              placeholder="例如：我的直播音色"
              onChange={event => setName(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="clone-voice-file">参考录音</Label>
            <Input
              id="clone-voice-file"
              type="file"
              accept=".wav,.mp3,.ogg,.m4a,.aac"
              disabled={uploading}
              onChange={event => {
                void chooseFile(event.currentTarget.files?.[0])
                event.currentTarget.value = ''
              }}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          支持 WAV、MP3、OGG、M4A、AAC，文件不超过 10
          MiB。请使用本人或已获授权的声音，尽量选择无噪声的单人录音。
        </p>
        {selected && (
          <p className="text-sm">
            已选择：{selected.fileName} · {(selected.audio.length / 1024 / 1024).toFixed(2)} MiB
          </p>
        )}
        {created && (
          <p className="text-sm text-primary" role="status">
            已保存并选中：{created.name} · {created.id}
          </p>
        )}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            disabled={uploading || !selected || !hasKey || settings.provider !== 'lanyun'}
            onClick={() => void upload()}
          >
            {uploading ? '正在上传…' : '上传并克隆音色'}
          </Button>
          {uploading && (
            <Button
              variant="outline"
              onClick={() => {
                if (requestRef.current)
                  void window.ipcRenderer
                    .invoke(IPC_CHANNELS.tts.cancel, requestRef.current)
                    .catch(() => {})
              }}
            >
              取消上传
            </Button>
          )}
        </div>
        {settings.provider !== 'lanyun' && (
          <p className="text-xs text-muted-foreground">请在下方将 TTS 厂商切换为蓝云后上传。</p>
        )}
        {settings.provider === 'lanyun' && !hasKey && (
          <p className="text-xs text-muted-foreground">请先在下方保存蓝云 API Key。</p>
        )}
      </CardContent>
    </Card>
  )
}
