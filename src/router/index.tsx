import { createHashRouter } from 'react-router'
import AIChat from '@/pages/AIChat'
import AutoMessage from '@/pages/AutoMessage'
import AutoPopUp from '@/pages/AutoPopUp'
import AutoReply from '@/pages/AutoReply'
import AutoReplySettings from '@/pages/AutoReply/AutoReplySettings'
import LiveControl from '@/pages/LiveControl'
import LiveSpeech from '@/pages/LiveSpeech'
import RedPacket from '@/pages/RedPacket'
import Settings from '@/pages/SettingsPage'
import TtsSettingsPage from '@/pages/TtsSettings'
import App from '../App'

export const router = createHashRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { path: '/live-speech', element: <LiveSpeech /> },
      { path: '/tts-settings', element: <TtsSettingsPage /> },
      {
        path: '/',
        element: <LiveControl />,
      },
      {
        path: '/auto-message',
        element: <AutoMessage />,
      },
      {
        path: '/auto-popup',
        element: <AutoPopUp />,
      },
      {
        path: '/settings',
        element: <Settings />,
      },
      {
        path: '/ai-chat',
        element: <AIChat />,
      },
      {
        path: 'auto-reply',
        element: <AutoReply />,
      },
      {
        path: '/auto-reply/settings',
        element: <AutoReplySettings />,
      },
      {
        path: '/red-packet',
        element: <RedPacket />,
      },
    ],
  },
])
