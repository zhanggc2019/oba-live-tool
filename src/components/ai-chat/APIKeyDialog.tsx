import { CheckIcon, Eye, EyeOff, SettingsIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { normalizeChatBaseURL } from 'shared/providers'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { type AIConfigType, useAIProvider } from '@/hooks/useAIProvider'
import { useProviders } from '@/hooks/useProviders'
import { useToast } from '@/hooks/useToast'

interface APIKeyDialogProps {
  type?: AIConfigType
}

/** 配置文本模型，支持厂商预设和任意 OpenAI Chat Completions 兼容服务。 */
export function APIKeyDialog({ type = 'chat' }: APIKeyDialogProps) {
  const { config, apiKeys, customBaseURL, setConfig, setApiKey, setCustomBaseURL } =
    useAIProvider(type)
  const providers = useProviders()
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [tempKeys, setTempKeys] = useState(apiKeys)
  const [tempConfig, setTempConfig] = useState(config)
  const [tempURL, setTempURL] = useState(customBaseURL || '')
  const [showPassword, setShowPassword] = useState(false)
  const [testLoading, setTestLoading] = useState(false)
  const [testSuccess, setTestSuccess] = useState(false)
  const testVersion = useRef(0)
  const provider = providers[tempConfig.provider]
  const models = provider?.models ?? []
  const isCustom = tempConfig.provider === 'custom'
  const isVolcengine = tempConfig.provider === 'volcengine'
  const prefix = `ai-${type}`

  /** 配置改动后使旧连接测试失效，避免把旧密钥测试结果显示给新配置。 */
  function resetTest() {
    testVersion.current += 1
    setTestSuccess(false)
    setTestLoading(false)
  }

  /** 每次打开读取已保存设置，关闭后丢弃尚未保存的更改。 */
  function changeOpen(nextOpen: boolean) {
    resetTest()
    if (nextOpen) {
      setTempKeys(apiKeys)
      setTempConfig(config)
      setTempURL(customBaseURL || '')
      setShowPassword(false)
    }
    setOpen(nextOpen)
  }

  /** 切换厂商时恢复原模型；旧配置缺少新厂商偏好时使用首个预设。 */
  function changeProvider(value: string) {
    resetTest()
    setTempConfig(previous => ({
      ...previous,
      provider: value,
      model: previous.modelPreferences[value] ?? providers[value]?.models[0] ?? '',
    }))
  }

  /** 预设选择和手动输入共用模型 ID，并保留各厂商的编辑偏好。 */
  function changeModel(model: string) {
    resetTest()
    setTempConfig(previous => ({
      ...previous,
      model,
      modelPreferences: { ...previous.modelPreferences, [previous.provider]: model },
    }))
  }

  /** 验证必填项后保存；不替换其他功能的模型和密钥配置。 */
  function save() {
    try {
      const model = tempConfig.model.trim()
      const key = tempKeys[tempConfig.provider]?.trim()
      if (!model) throw new Error('请填写模型 ID 或选择预设模型')
      if (!key) throw new Error('请填写 API Key')
      const url = isCustom ? normalizeChatBaseURL(tempURL) : customBaseURL
      setConfig({ ...tempConfig, model })
      setCustomBaseURL(url)
      for (const [name, value] of Object.entries(tempKeys)) setApiKey(name, value.trim())
      changeOpen(false)
      toast.success('文本模型配置已保存')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    }
  }

  /** 使用模型列表接口检查地址和密钥；不支持该接口的平台仍可保存后实际调用。 */
  async function testConnection() {
    const version = ++testVersion.current
    setTestLoading(true)
    setTestSuccess(false)
    try {
      const apiKey = tempKeys[tempConfig.provider]?.trim()
      if (!apiKey) throw new Error('请先输入 API Key')
      const result = await window.ipcRenderer.invoke(IPC_CHANNELS.tasks.aiChat.testApiKey, {
        apiKey,
        provider: tempConfig.provider,
        customBaseURL: isCustom ? normalizeChatBaseURL(tempURL) : undefined,
      })
      if (version !== testVersion.current) return
      if (!result.success) throw new Error(result.error ?? '测试连接失败')
      setTestSuccess(true)
    } catch (error) {
      if (version === testVersion.current)
        toast.error(error instanceof Error ? error.message : '测试连接失败')
    } finally {
      if (version === testVersion.current) setTestLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <SettingsIcon className="mr-2 h-4 w-4" />
          配置文本模型
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>文本模型配置</DialogTitle>
          <DialogDescription>
            {type === 'chat' ? '用于 AI 助手与直播话术生成。' : '用于直播评论的 AI 自动回复。'}
            支持硅基流动及其他 OpenAI 兼容服务。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-provider`}>选择提供商</Label>
            <Select value={tempConfig.provider} onValueChange={changeProvider}>
              <SelectTrigger id={`${prefix}-provider`}>
                <SelectValue placeholder="选择服务商" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(providers).map(([key, info]) => (
                  <SelectItem key={key} value={key}>
                    {info.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {isCustom ? (
            <div className="space-y-2">
              <Label htmlFor={`${prefix}-url`}>接口地址（Base URL）</Label>
              <Input
                id={`${prefix}-url`}
                value={tempURL}
                placeholder="https://api.example.com/v1"
                onChange={event => {
                  resetTest()
                  setTempURL(event.target.value)
                }}
              />
              <p className="text-xs text-muted-foreground">
                填写服务商提供的基础地址，通常以 /v1 结尾；粘贴完整的 /chat/completions
                地址也可自动识别。支持本机模型服务。
              </p>
            </div>
          ) : (
            <p className="break-all text-xs text-muted-foreground">接口地址：{provider?.baseURL}</p>
          )}
          {models.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor={`${prefix}-preset`}>预设模型</Label>
              <Select
                value={models.includes(tempConfig.model) ? tempConfig.model : '__manual__'}
                onValueChange={value => {
                  if (value !== '__manual__') changeModel(value)
                  else document.getElementById(`${prefix}-model`)?.focus()
                }}
              >
                <SelectTrigger id={`${prefix}-preset`}>
                  <SelectValue placeholder="选择模型" />
                </SelectTrigger>
                <SelectContent>
                  {models.map(model => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                  <SelectItem value="__manual__">手动填写模型 ID</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-model`}>
              {isVolcengine ? '模型或接入点 ID' : '模型 ID'}
            </Label>
            <Input
              id={`${prefix}-model`}
              value={tempConfig.model}
              onChange={event => changeModel(event.target.value)}
              placeholder={isVolcengine ? '请输入模型 ID 或接入点 ID' : '例如 Qwen/Qwen3-8B'}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              可直接填写服务商支持的模型 ID，不受预设列表限制。
            </p>
          </div>
          {tempConfig.provider === 'siliconflow' && (
            <p className="text-xs text-muted-foreground">
              Qwen/Qwen3-8B 默认直接生成回答，减少直播等待。可用额度和计费以硅基流动控制台为准。
            </p>
          )}
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-key`}>API Key</Label>
            <div className="relative">
              <Input
                id={`${prefix}-key`}
                type={showPassword ? 'text' : 'password'}
                value={tempKeys[tempConfig.provider] || ''}
                placeholder="请输入服务商提供的 API Key"
                className="font-mono pr-10"
                onChange={event => {
                  resetTest()
                  setTempKeys(previous => ({
                    ...previous,
                    [tempConfig.provider]: event.target.value,
                  }))
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={showPassword ? '隐藏密钥' : '显示密钥'}
                className="absolute right-1 top-1/2 -translate-y-1/2"
                onClick={() => setShowPassword(value => !value)}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
            {provider?.apiUrl && (
              <a
                href={provider.apiUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-primary hover:underline"
              >
                前往{provider.name}获取 API Key
              </a>
            )}
          </div>
          {!isVolcengine && (
            <div className="space-y-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!tempKeys[tempConfig.provider]?.trim() || testLoading}
                onClick={testConnection}
              >
                {testLoading ? '测试中…' : '测试连接'}
              </Button>
              {testSuccess && (
                <p role="status" className="flex items-center gap-1 text-xs text-green-600">
                  <CheckIcon className="h-4 w-4" />
                  密钥检查通过，模型可用性以实际生成结果为准。
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                若服务商未开放模型列表接口，可以保存后直接试用。
              </p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => changeOpen(false)}>
            取消
          </Button>
          <Button onClick={save}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
