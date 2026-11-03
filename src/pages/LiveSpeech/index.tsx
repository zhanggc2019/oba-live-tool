import { Play, Volume2 } from 'lucide-react'
import { Link } from 'react-router'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { findScriptTopicConflict } from 'shared/liveScript'
import { splitSpeechText, TTS_PRESETS } from 'shared/voice'
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
import { useCurrentLiveControl } from '@/hooks/useLiveControl'
import { useToast } from '@/hooks/useToast'
import { getVoiceConfig, useVoiceConfigStore } from '@/hooks/useVoiceConfig'
import {
  previewVoice,
  startVoiceSession,
  stopVoiceSession,
  useVoiceRuntime,
} from '@/services/voice/runtime'
import { ScriptGenerator } from './ScriptGenerator'
import { VoicePicker } from './VoicePicker'

/** 只从已保存的话术及其商品资料开始播报，后续讲解由 AI 持续供稿。 */
export default function LiveSpeech() {
  const accountId = useAccounts(state => state.currentAccountId)
  useVoiceConfigStore(state => state.contexts[accountId])
  const config = getVoiceConfig(accountId)
  const update = useVoiceConfigStore(state => state.update)
  const updateProvider = useVoiceConfigStore(state => state.updateProvider)
  const connected = useCurrentLiveControl(state => state.isConnected === 'connected')
  const runtime = useVoiceRuntime()
  const { toast } = useToast()
  const opening = splitSpeechText(config.openingScript)
  const selectedScript = config.savedScripts.find(script => script.id === config.selectedScriptId)
  const topicConflict =
    selectedScript && findScriptTopicConflict(selectedScript, config.savedScripts)
  const seedScript = selectedScript?.content ?? ''
  const seed = splitSpeechText(seedScript)

  /** 开始播报或试听，并将即时校验错误呈现在界面。 */
  function run(action: () => void) {
    try {
      action()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法启动语音')
    }
  }

  /** 切换已保存话术时停止旧会话；正文和资料由所选版本读取。 */
  function selectBroadcastScript(id: string) {
    if (id === selectedScript?.id) return
    const script = config.savedScripts.find(item => item.id === id)
    if (!script) return
    const active = useVoiceRuntime.getState()
    if (active.accountId === accountId && (active.running || active.preparing)) {
      stopVoiceSession(accountId)
      toast.success('已停止上一份话术；请确认新话术后点击开始播报')
    }
    update(accountId, { selectedScriptId: script.id })
  }

  /** 用本场音色试听一句讲解示例，不启动持续播报或预备队列。 */
  async function auditionSelectedVoice() {
    try {
      const hasKey = await window.ipcRenderer.invoke(IPC_CHANNELS.tts.hasKey, config.provider)
      if (!hasKey) throw new Error('请先在音色克隆页面保存当前厂商的 API Key')
      const sample = Array.from(seed[0] ?? opening[0] ?? '欢迎来到直播间，今天为大家介绍这款产品。')
        .slice(0, 80)
        .join('')
      previewVoice(accountId, sample)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '音色试听失败')
    }
  }

  return (
    <div className="container space-y-6 py-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Title title="直播话术" description="选择已保存的话术，AI 按它对应的商品资料持续供稿" />
        <Button asChild variant="outline">
          <Link to="/tts-settings">配置声音</Link>
        </Button>
      </div>
      <Card id="broadcast-setup" className="border-primary/40 bg-primary/[0.03]">
        <CardHeader>
          <CardTitle className="text-lg">开播前确认 · 持续讲解</CardTitle>
          <CardDescription>
            所选话术播报一次；播放过程中根据剩余字数提前生成新段落，不会从头重放同一份话术。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="selected-live-script" className="text-base font-semibold">
                本次播报话术
              </Label>
              <Select
                value={selectedScript?.id}
                onValueChange={selectBroadcastScript}
                disabled={!config.savedScripts.length}
              >
                <SelectTrigger id="selected-live-script" className="w-full bg-background">
                  <SelectValue placeholder="请选择已保存话术" />
                </SelectTrigger>
                <SelectContent>
                  {config.savedScripts.map(script => (
                    <SelectItem key={script.id} value={script.id}>
                      {script.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!config.savedScripts.length && (
                <p className="text-xs text-muted-foreground">
                  暂无已保存话术；请在下方编辑区新建并保存话术。
                </p>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              每份话术的正文和商品资料一起保存。要修改内容，请在下方编辑区打开并保存。
            </p>
            <VoicePicker
              accountId={accountId}
              provider={config.provider}
              settings={{ ...TTS_PRESETS[config.provider], ...config.providers?.[config.provider] }}
              onSelect={voice => updateProvider(accountId, config.provider, { voice })}
              onPreview={() => void auditionSelectedVoice()}
              previewDisabled={runtime.running || runtime.preparing}
            />
            <div className="space-y-2">
              <Label htmlFor="prebuffer-seconds">开播前预备语音</Label>
              <Select
                value={String(config.prebufferSeconds)}
                onValueChange={value => update(accountId, { prebufferSeconds: Number(value) })}
              >
                <SelectTrigger id="prebuffer-seconds" className="w-full bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">立即开始</SelectItem>
                  <SelectItem value="15">约 15 秒</SelectItem>
                  <SelectItem value="30">约 30 秒（推荐）</SelectItem>
                  <SelectItem value="45">约 45 秒</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                按合成音频的实际播放时长准备；话术正文不足时先生成续稿。准备完成后自动开始播报。
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Label htmlFor="speech-gap">句间停顿（秒）</Label>
              <Input
                id="speech-gap"
                className="w-24"
                type="number"
                min={0}
                max={30}
                step={0.05}
                value={config.gapMs / 1000}
                onChange={event =>
                  update(accountId, {
                    gapMs: Math.round(
                      Math.max(0, Math.min(30, Number(event.target.value) || 0)) * 1000,
                    ),
                  })
                }
              />
            </div>
          </div>
          <div className="flex flex-col justify-between gap-4 rounded-lg border bg-background p-4">
            <div className="space-y-2">
              <p className="text-sm font-medium">即将播报的内容</p>
              <p className="text-sm text-muted-foreground">
                开场：{opening.length ? `${opening.length} 句，播放一次` : '未填写'}
              </p>
              <p className="text-sm text-muted-foreground">
                话术正文：
                {seed.length
                  ? `${selectedScript?.title} · ${seed.length} 句 / ${seedScript.replace(/\s/g, '').length} 字`
                  : '未选择或尚无正文'}
              </p>
              {selectedScript && (
                <p className="text-sm text-muted-foreground">
                  随话术保存的商品资料：
                  {(selectedScript.productIntro ?? '').length +
                    (selectedScript.referenceText ?? '').length}{' '}
                  字
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                后续：结合所选话术的商品要素持续生成，每段字数参照正文。
              </p>
              {topicConflict && (
                <p className="text-sm text-destructive" role="alert">
                  《{selectedScript.title}》的正文多次提到《{topicConflict.title}
                  》的主题。请在下方编辑区打开这份话术，修改正文并保存后再播报。
                </p>
              )}
              {runtime.accountId === accountId &&
                (runtime.running || runtime.preparing) &&
                runtime.mode !== 'preview' && (
                  <p className="text-sm font-medium text-primary" role="status">
                    当前正在{runtime.preparing ? '准备' : '播报'}：{runtime.activeScriptTitle}
                  </p>
                )}
              {runtime.accountId === accountId && runtime.continuation.status !== 'idle' && (
                <p className="text-xs text-muted-foreground" role="status">
                  {runtime.continuation.error ||
                    `已生成 ${runtime.continuation.generatedSegments} 段 · ${runtime.continuation.status === 'generating' || runtime.continuation.status === 'retrying' ? '正在准备下一段' : '等待合适字数继续供稿'}`}
                </p>
              )}
              {runtime.accountId === accountId &&
                (runtime.preparing || runtime.preparationError) && (
                  <p className="text-xs text-muted-foreground" role="status">
                    {runtime.preparationError ||
                      `正在预备语音：${runtime.preparedSeconds.toFixed(1)} / 约 ${runtime.preparationTargetSeconds} 秒`}
                  </p>
                )}
            </div>
            <div className="space-y-2">
              <Button
                className="w-full"
                size="lg"
                disabled={
                  !selectedScript ||
                  Boolean(topicConflict) ||
                  ((runtime.running || runtime.preparing) &&
                    runtime.mode !== 'preview' &&
                    !(runtime.mode === 'local' && runtime.phase === 'idle'))
                }
                onClick={() =>
                  run(() => startVoiceSession(accountId, connected ? 'live' : 'local'))
                }
              >
                <Play className="h-4 w-4" />
                开始播报
              </Button>
              {runtime.accountId === accountId && runtime.preparing && (
                <Button
                  className="w-full"
                  variant="outline"
                  onClick={() => stopVoiceSession(accountId)}
                >
                  取消准备
                </Button>
              )}
              <p className="text-xs text-muted-foreground">
                {connected
                  ? '已连接中控台：播报将关联直播问答。'
                  : '未连接中控台：开始后在本机试听。'}
                修改并保存话术后会在下一次开始时生效；切换话术会先停止旧播报。
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>开场介绍</CardTitle>
            <CardDescription>开始后按顺序朗读一次，共 {opening.length} 句</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Label htmlFor="opening-script">开场介绍</Label>
            <Textarea
              id="opening-script"
              value={config.openingScript}
              maxLength={20000}
              className="min-h-48"
              placeholder="欢迎来到直播间。今天给大家介绍……"
              onChange={event => update(accountId, { openingScript: event.target.value })}
            />
            <Button
              variant="outline"
              disabled={!opening.length}
              onClick={() => run(() => previewVoice(accountId, config.openingScript))}
            >
              <Volume2 className="h-4 w-4" />
              试听开场
            </Button>
          </CardContent>
        </Card>
      </div>
      <ScriptGenerator />
      <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground space-y-1">
        <p>
          开场和所选话术各播放一次，后续新段落由 AI 持续生成；无需开真实直播间，也能在本机试听。
        </p>
        <p>
          观众问答需先连接中控台，再到{' '}
          <Link to="/auto-reply/settings" className="text-primary underline">
            自动回复设置
          </Link>{' '}
          启用 AI、自动发送及语音方式，并开始评论监听和回复任务。
        </p>
      </div>
    </div>
  )
}
