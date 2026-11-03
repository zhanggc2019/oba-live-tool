import { setupAIChatIpcHandlers } from './aichat'
import { setupAppIpcHandlers } from './app'
import { setupAutoMessageIpcHandlers } from './autoMessage'
import { setupAutoPopUpIpcHandlers } from './autoPopUp'
import { setupBrowserIpcHandlers } from './browser'
import { setupAutoReplyIpcHandlers } from './commentListener'
import { setupLiveControlIpcHandlers } from './connection'
import { setupLiveScriptIpcHandlers } from './liveScript'
import { setupPinCommentIpcHandler } from './pinComment'
import { setupRedPacketIpcHandlers } from './redPacket'
import { setupTtsIpcHandlers } from './tts'

setupLiveControlIpcHandlers()
setupAIChatIpcHandlers()
setupAutoPopUpIpcHandlers()
setupAutoReplyIpcHandlers()
setupAutoMessageIpcHandlers()
setupBrowserIpcHandlers()
setupAppIpcHandlers()
setupPinCommentIpcHandler()
setupRedPacketIpcHandlers()
setupTtsIpcHandlers()
setupLiveScriptIpcHandlers()
