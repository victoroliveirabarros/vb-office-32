import Phaser from 'phaser'
import './style.css'
import './avatar/swatches.gen.css'
import { formatAppearance } from './avatar/appearance'
import { avatarPrefs } from './avatar/prefs'
import type { TypingGate } from './chat/keys'
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
import { createAvatarEditor } from './ui/avatar'
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

// Avatar names are drawn into canvas textures once, so the face must be
// there first; a slow font only costs the fallback.
function fontReady(): Promise<void> {
  const load = document.fonts.load('700 11px "Montserrat"').then(
    () => undefined,
    () => undefined,
  )
  return Promise.race([load, new Promise<void>((resolve) => setTimeout(resolve, 1500))])
}

const prefs = avatarPrefs()

// The saved look goes in the URL of every attempt, so the server shows it
// from the welcome on.
function savedLook(): string | null {
  const look = prefs.load()
  return look ? formatAppearance(look) : null
}

async function start(hud: Hud, connection: Connection, font: Promise<void>): Promise<void> {
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

  // The chat and the avatar editor take the keyboard from the scene, which
  // opens the chat on a click on someone's avatar.
  const gate: TypingGate = { setTyping: (owner, on) => office.setTyping(owner, on) }
  const chat = createChat(connection, gate)
  createAvatarEditor(connection, prefs, gate)
  const office = new OfficeScene(connection, hud, {
    speakers: media,
    zonesLoaded: (zones) => chat.setZones(zones),
    picked: (id) => chat.openDirect(id),
  })

  await font
  new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    transparent: true,
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
  const font = fontReady()
  const hud = createHud()
  const session = await loadSession(hud)
  if (session.status === 'authenticated') {
    showLogout(() => {
      void logout().finally(() => location.assign('/'))
    })
    await start(hud, new Connection(() => wsUrl(undefined, savedLook()), sessionAlive), font)
    return
  }
  if (session.auth === 'oidc') {
    showLogin()
    return
  }
  const name = await askName()
  await start(hud, new Connection(() => wsUrl(name, savedLook())), font)
}

void boot()
