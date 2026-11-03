import { useId } from 'react'
import { Link } from 'react-router'
import AIModelInfo from '@/components/ai-chat/AIModelInfo'
import { APIKeyDialog } from '@/components/ai-chat/APIKeyDialog'
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
import { useAutoReplyConfig } from '@/hooks/useAutoReplyConfig'

/** 配置 AI 回复输出方式，并复用直播话术中的参考资料。 */
export function AIReplySetting() {
  const { config, updateAIReplySettings } = useAutoReplyConfig()
  const aiReplyEnabled = config.comment.aiReply.enable
  const autoSend = config.comment.aiReply.autoSend
  // 处理AI自动回复开关
  const handleAiReplyChange = (checked: boolean) => {
    updateAIReplySettings({ enable: checked })
  }

  const handleAutoSendChange = (checked: boolean) => {
    updateAIReplySettings({ autoSend: checked })
  }

  const aiReplyId = useId()
  const autoSendId = useId()

  return (
    <>
      <div className="flex flex-col space-y-4">
        <div className="flex items-center space-x-2">
          <Switch id={aiReplyId} checked={aiReplyEnabled} onCheckedChange={handleAiReplyChange} />
          <Label htmlFor={aiReplyId}>启用AI自动回复</Label>
        </div>
        <div>
          <div className="flex items-center space-x-2">
            <Switch id={autoSendId} checked={autoSend} onCheckedChange={handleAutoSendChange} />
            <Label htmlFor={autoSendId}>自动发送</Label>
          </div>
          <div className="text-xs text-muted-foreground mt-2 pl-2">
            <p>
              请注意：开启自动发送后，AI生成的所有回复都会自动发送到直播间，这可能会带来以下
              <strong>风险</strong>：
            </p>
            <ul className="list-disc pl-6 mt-1">
              <li>
                AI可能会生成<strong>不恰当或不相关</strong>的回复
              </li>
              <li>
                回复内容可能会<strong>违反平台规则</strong>
              </li>
              <li>可能会影响与观众的真实互动体验</li>
            </ul>
            <p className="font-medium mt-1">
              ※ 建议在开启自动发送前，先观察一段时间AI的回复质量。您也可以通过点击每条回复预览旁边的
              <strong>小飞机按钮</strong>来手动发送。
            </p>
          </div>
        </div>
      </div>
      {aiReplyEnabled && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ai-output-mode">回复方式</Label>
            <Select
              value={config.comment.aiReply.outputMode}
              onValueChange={value =>
                updateAIReplySettings({ outputMode: value as 'text' | 'voice' | 'both' })
              }
            >
              <SelectTrigger id="ai-output-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="text">文字回复</SelectItem>
                <SelectItem value="voice">语音播报</SelectItem>
                <SelectItem value="both">文字 + 语音</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              自动发送控制上述输出方式。语音需先在「直播话术」开始播报；关闭自动发送时仍可在回复预览中手动播放。关键词规则仍优先按文字回复。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="ai-use-reference"
              checked={config.comment.aiReply.useReference}
              onCheckedChange={checked => updateAIReplySettings({ useReference: checked })}
            />
            <Label htmlFor="ai-use-reference">使用产品资料与参考话术回答</Label>
            <Link className="text-sm text-primary underline" to="/live-speech">
              编辑资料
            </Link>
          </div>
          <div className="flex items-center space-x-2">提示词配置</div>
          <Textarea
            placeholder="输入AI提示词..."
            value={config.comment.aiReply.prompt}
            onChange={e => updateAIReplySettings({ prompt: e.target.value })}
            className="min-h-[120px]"
          />
          <p className="text-xs text-muted-foreground">提示词将指导AI如何回复用户评论</p>
          <div className="flex justify-between items-center space-x-2">
            <APIKeyDialog type="autoReply" />
            <AIModelInfo type="autoReply" />
          </div>
        </div>
      )}
    </>
  )
}
