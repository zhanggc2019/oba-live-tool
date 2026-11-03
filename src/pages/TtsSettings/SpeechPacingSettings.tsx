import type { SpeechPacingSettings as PacingConfig } from 'shared/speechPacing'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

interface Props {
  settings: PacingConfig
  onChange: (patch: Partial<PacingConfig>) => void
}

/** 配置逐句动态语速，调整边界时同步约束另一端，保证保存的范围始终有效。 */
export function SpeechPacingSettings({ settings, onChange }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>播报节奏</CardTitle>
        <CardDescription>开场、循环讲解、AI 回复和试听共用，修改后下次开始生效</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="tts-dynamic-rate">动态语速</Label>
          <Switch
            id="tts-dynamic-rate"
            checked={settings.enabled}
            onCheckedChange={enabled => onChange({ enabled })}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          数字、价格与注意事项放慢，欢迎和互动句稍快。按内容和要求中的关键词逐句判断，不增加大模型等待。
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="tts-rate-min">最低语速：{settings.minRate.toFixed(2)}×</Label>
            <input
              id="tts-rate-min"
              aria-label="最低语速"
              className="w-full"
              type="range"
              min={0.5}
              max={2}
              step={0.01}
              disabled={!settings.enabled}
              value={settings.minRate}
              onChange={event => {
                const minRate = Number(event.target.value)
                onChange({ minRate, maxRate: Math.max(minRate, settings.maxRate) })
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tts-rate-max">最高语速：{settings.maxRate.toFixed(2)}×</Label>
            <input
              id="tts-rate-max"
              aria-label="最高语速"
              className="w-full"
              type="range"
              min={0.5}
              max={2}
              step={0.01}
              disabled={!settings.enabled}
              value={settings.maxRate}
              onChange={event => {
                const maxRate = Number(event.target.value)
                onChange({ maxRate, minRate: Math.min(maxRate, settings.minRate) })
              }}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="tts-pacing-style">整体节奏</Label>
          <Select
            value={settings.style}
            disabled={!settings.enabled}
            onValueChange={value => onChange({ style: value as PacingConfig['style'] })}
          >
            <SelectTrigger id="tts-pacing-style">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="natural">自然讲解</SelectItem>
              <SelectItem value="calm">舒缓陪伴</SelectItem>
              <SelectItem value="energetic">轻快互动</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="tts-pacing-requirements">直播间播报要求（选填）</Label>
          <Textarea
            id="tts-pacing-requirements"
            disabled={!settings.enabled}
            value={settings.requirements}
            maxLength={1000}
            placeholder="例如：自习室介绍，安静舒缓，价格和注意事项讲清楚。"
            onChange={event => onChange({ requirements: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            支持“舒缓、慢一点、不要太快”或“轻快、活泼、快一点”等节奏关键词；留空时参考生成话术的补充要求。更复杂的风格可在厂商的朗读风格或情感描述中设置。
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          {settings.enabled
            ? '蓝云在合成时调速；MiMo 和兼容厂商在播放时保音高调速。倍率相对音色的原始节奏，不会叠加两次。'
            : '已使用固定语速：蓝云使用左侧语速倍率，MiMo 和兼容厂商按原始音频播放。'}
        </p>
      </CardContent>
    </Card>
  )
}
