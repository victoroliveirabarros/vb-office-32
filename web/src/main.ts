import Phaser from 'phaser'
import './style.css'
import { toRoom } from './game/zones'
import { MediaClient } from './media/client'
import type { MediaRoom, RoomListener } from './media/client'
import { storagePrefs } from './media/prefs'
import { backoffDelay, Connection, wsUrl } from './net/connection'
import type { ConnectionStatus } from './net/connection'
import { fetchSession, logout, sessionAlive } from './net/session'
import type { Session } from './net/session'
import { BootScene } from './scenes/BootScene'
import { OfficeScene } from './scenes/OfficeScene'
import { createHud } from './ui/hud'
import type { Hud } from './ui/hud'
import { createChat } from './ui/chat'
import { askName } from './ui/join'
import { showLogin, showLogout } from './ui/login'
import { createMediaView } from './ui/media'

const STATUS_TEXT: Record<ConnectionStatus, string | null> = {
  connecting: 'Conectando…',
  open: null,
  reconnecting: 'Conexão perdida, reconectando…',
  replaced: 'Sessão aberta em outra aba',
  expired: 'Sessão expirada',
}

// The SDK loads only once the server hands out a media grant.
async function createRoom(listener: RoomListener): Promise<MediaRoom> {
  const { createLiveKitRoom } = await import('./media/livekit')
  return createLiveKitRoom(listener)
}

function start(hud: Hud, connection: Connection): void {
  const view = createMediaView()
  const media = new MediaClient({ createRoom, view, prefs: storagePrefs })
  view.bind(media)
  connection.onMessage((msg) => media.handle(msg))
  connection.onStatus((status) => {
    hud.setStatus(STATUS_TEXT[status])
    media.setConnectionStatus(status)
    if (status === 'expired') location.assign('/')
  })

  connection.onMessage((msg) => {
    if (msg.t === 'zone') hud.setZone(toRoom(msg.d))
  })

  // The chat takes the keyboard from the scene, which opens the chat on a
  // click on someone's avatar.
  const chat = createChat(connection, { setTyping: (on) => office.setTyping(on) })
  const office = new OfficeScene(connection, hud, {
    speakers: media,
    zonesLoaded: (zones) => chat.setZones(zones),
    picked: (id) => chat.openDirect(id),
  })

  new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: '#1d1f27',
    pixelArt: true,
    roundPixels: true,
    scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
    scene: [new BootScene(hud), office],
  })
}

async function loadSession(hud: Hud): Promise<Session> {
  for (let attempt = 0; ; attempt++) {
    try {
      const session = await fetchSession()
      if (session) {
        hud.setStatus(null)
        return session
      }
    } catch {
      // network error; retry below
    }
    hud.setStatus('Servidor indisponível, tentando de novo…')
    await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt)))
  }
}

async function boot(): Promise<void> {
  const hud = createHud()
  const session = await loadSession(hud)
  if (session.status === 'authenticated') {
    showLogout(() => {
      void logout().finally(() => location.assign('/'))
    })
    start(hud, new Connection(wsUrl(), sessionAlive))
    return
  }
  if (session.auth === 'oidc') {
    showLogin()
    return
  }
  start(hud, new Connection(wsUrl(await askName())))
}

void boot()
