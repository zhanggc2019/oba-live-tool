import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { app, dialog } from 'electron'

/** 将新软件的本地数据与旧项目隔离，首次安装从空白配置启动。 */
function configureApplicationIdentity() {
  const userDataPath = path.join(app.getPath('appData'), 'xinghe-ai-live')
  mkdirSync(userDataPath, { recursive: true })
  app.setPath('userData', userDataPath)
  app.setName('星河AI直播')
}

if (typeof process.setSourceMapsEnabled === 'function') {
  process.setSourceMapsEnabled(true)
}

configureApplicationIdentity()

/** 主进程依赖加载失败时明确退出并显示原因，避免残留一个无窗口的后台进程。 */
async function startApplication() {
  try {
    await import('./app')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('星河AI直播启动失败', `程序文件不完整或无法加载：\n${message}`)
    app.exit(1)
  }
}

void startApplication()
