import { Pause, Play, Square, Volume2 } from 'lucide-react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { useAccounts } from '@/hooks/useAccounts'
import { pauseVoiceSession, stopVoiceSession, useVoiceRuntime } from '@/services/voice/runtime'

const phases = {
  idle: '等待回复',
  synthesizing: '正在合成',
  playing: '正在播放',
  waiting: '句间停顿',
  paused: '已暂停',
  error: '播报失败',
}

/** 全局显示播报账号与停止按钮，切页或切账号后仍可立即停止声音。 */
export function VoiceStatusBar() {
  const state = useVoiceRuntime()
  const name = useAccounts(s => s.accounts.find(account => account.id === state.accountId)?.name)
  if (!state.running && !state.preparing && !state.error && !state.preparationError) return null
  return (
    <div
      className="flex flex-wrap items-center gap-3 border-b bg-primary/5 px-6 py-2 text-sm"
      role="status"
    >
      <Volume2 className="h-4 w-4 shrink-0" />
      <span className="font-medium">
        {name ?? '语音播报'} ·{' '}
        {state.preparing
          ? '准备开播语音'
          : state.preparationError
            ? '语音准备失败'
            : state.continuation.status === 'error'
              ? '续稿失败'
              : state.phase === 'idle' && state.continuation.status !== 'idle'
                ? '等待新文案'
                : state.mode === 'local' && state.phase === 'idle'
                  ? '本轮播放完成'
                  : phases[state.phase]}
      </span>
      {state.mode === 'local' && <span className="text-xs text-muted-foreground">本地试听</span>}
      {state.activeScriptTitle && state.mode !== 'preview' && (
        <span
          className="max-w-44 truncate text-xs text-muted-foreground"
          title={`当前话术：${state.activeScriptTitle}`}
        >
          话术：{state.activeScriptTitle}
        </span>
      )}
      {state.currentRate !== null && (
        <span className="shrink-0 text-xs text-muted-foreground" title={state.rateReason}>
          本句 {state.currentRate.toFixed(2)}×
        </span>
      )}
      <span className="min-w-0 flex-1 truncate" title={state.currentText}>
        {state.preparing
          ? `已预备 ${state.preparedSeconds.toFixed(1)} / 约 ${state.preparationTargetSeconds} 秒${state.continuation.status === 'generating' ? ' · 正在生成后续文案' : ''}`
          : state.preparationError ||
            state.error ||
            state.continuation.error ||
            state.currentText ||
            (state.continuation.status === 'generating' || state.continuation.status === 'retrying'
              ? `正在生成：${state.continuation.theme}`
              : `待播 ${state.pending} 句`)}
      </span>
      {state.running && (
        <span className="text-xs text-muted-foreground" title="播放时提前合成后两句，减少句间等待">
          已预备 {state.buffered} 句
          {state.lastSynthesisMs > 0
            ? ` · 最近合成 ${(state.lastSynthesisMs / 1000).toFixed(1)} 秒`
            : ''}
        </span>
      )}
      <Link to="/live-speech" className="text-primary underline">
        直播话术
      </Link>
      {state.running && (
        <Button size="sm" variant="outline" onClick={() => pauseVoiceSession(!state.paused)}>
          {state.paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
          {state.paused ? '继续' : '句末暂停'}
        </Button>
      )}
      <Button size="sm" variant="destructive" onClick={() => stopVoiceSession()}>
        <Square className="h-3 w-3" />
        {state.preparing ? '取消准备' : '停止语音'}
      </Button>
    </div>
  )
}
