import { Loader2, Save, Sparkles, Square } from 'lucide-react'
import { countScriptCharacters, saveLiveScript } from 'shared/liveScript'
import AIModelInfo from '@/components/ai-chat/AIModelInfo'
import { APIKeyDialog } from '@/components/ai-chat/APIKeyDialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
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
import { getVoiceConfig, useVoiceConfigStore } from '@/hooks/useVoiceConfig'
import {
  cancelScriptGeneration,
  generateScriptDraft,
  useScriptGeneration,
} from '@/services/voice/scriptGeneration'

/** 生成可编辑的长话术，支持命名保存、另存及下次开播选用。 */
export function ScriptGenerator() {
  const accountId = useAccounts(state => state.currentAccountId)
  useVoiceConfigStore(state => state.contexts[accountId])
  const config = getVoiceConfig(accountId)
  const update = useVoiceConfigStore(state => state.update)
  const generation = useScriptGeneration(state => state.contexts[accountId])
  const busy = Boolean(generation && generation.status !== 'idle')
  const draft = busy ? (generation?.text ?? '') : config.generatedScript
  const { toast } = useToast()

  /** 启动请求并显示缺少产品资料或模型配置的错误。 */
  async function generate() {
    try {
      await generateScriptDraft(accountId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '生成失败')
    }
  }

  /** 将编辑区里的正文和商品资料一起保存为同一个话术版本。 */
  function save(asNew: boolean) {
    try {
      const current = getVoiceConfig(accountId)
      const savedScripts = saveLiveScript(current.savedScripts, {
        id: asNew ? undefined : current.scriptDraftId || undefined,
        title: current.scriptDraftTitle,
        content: current.generatedScript,
        productIntro: current.productIntro,
        referenceText: current.referenceText,
        scriptRequirements: current.scriptRequirements,
      })
      update(accountId, {
        savedScripts,
        scriptDraftId: savedScripts[0].id,
        scriptDraftTitle: savedScripts[0].title,
        generatedScript: savedScripts[0].content,
      })
      toast.success('话术与商品资料已保存，请到页面顶部选择本次播报话术')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    }
  }

  /** 载入已保存条目的正文与商品资料，不改变本次播报选择。 */
  function load(id: string) {
    const script = config.savedScripts.find(item => item.id === id)
    if (script)
      update(accountId, {
        scriptDraftId: id,
        scriptDraftTitle: script.title,
        generatedScript: script.content,
        productIntro: script.productIntro ?? '',
        referenceText: script.referenceText ?? '',
        scriptRequirements: script.scriptRequirements ?? '',
      })
  }

  /** 新建独立草稿，清空上一份话术的产品资料以防串稿。 */
  function newDraft() {
    update(accountId, {
      scriptDraftId: '',
      scriptDraftTitle: '',
      generatedScript: '',
      productIntro: '',
      referenceText: '',
      scriptRequirements: '',
    })
  }

  /** 删除库中选中的版本，保留编辑草稿及其商品资料。 */
  function removeSavedScript() {
    const current = getVoiceConfig(accountId)
    update(accountId, {
      savedScripts: current.savedScripts.filter(script => script.id !== current.scriptDraftId),
      scriptDraftId: '',
      ...(current.selectedScriptId === current.scriptDraftId ? { selectedScriptId: '' } : {}),
    })
    toast.success('已从话术库删除，当前编辑正文仍保留')
  }

  const selected = config.savedScripts.find(script => script.id === config.scriptDraftId)
  const hasUnsavedChanges = Boolean(
    selected &&
      (selected.content !== config.generatedScript ||
        selected.title !== config.scriptDraftTitle ||
        (selected.productIntro ?? '') !== config.productIntro ||
        (selected.referenceText ?? '') !== config.referenceText ||
        (selected.scriptRequirements ?? '') !== config.scriptRequirements),
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5" />
          AI 话术与商品资料 · 编辑区
        </CardTitle>
        <CardDescription>
          每份话术独立保存正文、商品要素与参考资料。这里打开话术仅供编辑，不会切换本次播报。
          文案模型支持 DeepSeek 和第三方 OpenAI 兼容服务，可在「配置文本模型」中填写接口地址、模型
          ID 和 API Key。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="script-product-intro">简短产品介绍</Label>
            <Textarea
              id="script-product-intro"
              value={config.productIntro}
              maxLength={8000}
              disabled={busy}
              className="min-h-32"
              placeholder="例如：500 毫升水杯，适合上班通勤，杯盖可拆洗。请补充已确认的规格、卖点和适用人群。"
              onChange={event => update(accountId, { productIntro: event.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="script-requirements">补充要求（选填）</Label>
            <Textarea
              id="script-requirements"
              value={config.scriptRequirements}
              maxLength={1000}
              disabled={busy}
              className="min-h-32"
              placeholder="例如：亲切自然、不喊麦，重点讲解日常使用场景，适当穿插互动问题。"
              onChange={event => update(accountId, { scriptRequirements: event.target.value })}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="script-reference-text">商品要素与参考资料</Label>
          <Textarea
            id="script-reference-text"
            aria-label="商品要素与参考资料"
            value={config.referenceText}
            maxLength={12000}
            disabled={busy}
            className="min-h-36"
            placeholder="产品名称、规格与适用人群、已确认的价格和优惠、常见问题与参考回答……"
            onChange={event => update(accountId, { referenceText: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            与本话术一起保存；续稿和已启用资料引用的 AI 回复会使用这份资料，不会直接朗读。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <APIKeyDialog type="chat" />
          <AIModelInfo type="chat" />
          {busy ? (
            <Button
              variant="outline"
              disabled={generation?.status === 'cancelling'}
              onClick={() => void cancelScriptGeneration(accountId)}
            >
              <Square className="h-4 w-4" />
              {generation?.status === 'cancelling' ? '正在停止…' : '停止生成'}
            </Button>
          ) : (
            <Button disabled={!config.productIntro.trim()} onClick={generate}>
              <Sparkles className="h-4 w-4" />
              生成约 3000 字话术
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          使用 AI 助手的文本模型配置。文字生成与 TTS
          配音分别配置；生成稿不会自动覆盖已保存话术或开始播放。
        </p>
        <div className="flex flex-wrap items-end gap-3">
          {config.savedScripts.length > 0 && (
            <div className="min-w-64 flex-1 space-y-2">
              <Label htmlFor="script-library">打开已保存话术进行编辑（不改变本次播报）</Label>
              <Select
                disabled={busy}
                value={config.scriptDraftId || undefined}
                onValueChange={load}
              >
                <SelectTrigger id="script-library">
                  <SelectValue placeholder="选择一份话术载入编辑器" />
                </SelectTrigger>
                <SelectContent>
                  {config.savedScripts.map(script => (
                    <SelectItem key={script.id} value={script.id}>
                      {script.title} · {countScriptCharacters(script.content)} 字
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <Button variant="outline" disabled={busy} onClick={newDraft}>
            新建话术
          </Button>
        </div>
        <div className="space-y-2">
          <Label htmlFor="script-draft-title">话术名称</Label>
          <Input
            id="script-draft-title"
            value={config.scriptDraftTitle}
            maxLength={60}
            disabled={busy}
            placeholder="例如：水杯日常讲解版"
            onChange={event => update(accountId, { scriptDraftTitle: event.target.value })}
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="generated-script">话术正文（可编辑）</Label>
            <span className="text-xs text-muted-foreground">
              {countScriptCharacters(draft)} 字（不含空白）
              {hasUnsavedChanges ? ' · 有未保存修改' : ''}
            </span>
          </div>
          <Textarea
            id="generated-script"
            value={draft}
            readOnly={busy}
            maxLength={20000}
            className="min-h-64"
            placeholder="AI 生成的正文会逐步显示在这里，也可以直接粘贴或编辑已有话术。"
            onChange={event => update(accountId, { generatedScript: event.target.value })}
          />
          {busy && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在生成话术，可以切换页面；已生成 {countScriptCharacters(draft)} 字。
            </p>
          )}
          {generation?.error && (
            <p role="alert" className="text-sm text-destructive">
              {generation.error}
            </p>
          )}
          {!busy && generation?.notice && (
            <p className="text-sm text-muted-foreground">{generation.notice}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy || !draft.trim() || !config.scriptDraftTitle.trim()}
            onClick={() => save(false)}
          >
            <Save className="h-4 w-4" />
            {config.scriptDraftId ? '保存修改' : '保存话术'}
          </Button>
          {config.scriptDraftId && (
            <Button
              variant="outline"
              disabled={busy || !draft.trim() || !config.scriptDraftTitle.trim()}
              onClick={() => save(true)}
            >
              另存为新话术
            </Button>
          )}
          {selected && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" disabled={busy}>
                  删除已保存版本
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>删除“{selected.title}”？</AlertDialogTitle>
                  <AlertDialogDescription>
                    将从当前账号的话术库移除该版本，编辑草稿及已载入的讲解正文仍然保留。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction onClick={removeSavedScript}>删除版本</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          编辑草稿会自动保留；点击保存后才更新话术库。已保存 {config.savedScripts.length} / 50
          份，每份最多 20000 字，按当前直播账号保存。
        </p>
      </CardContent>
    </Card>
  )
}
