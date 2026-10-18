import Phaser from 'phaser'
import { backoffDelay, Connection, wsUrl } from './net/connection'
import type { ConnectionStatus } from './net/connection'
import { fetchSession, logout, sessionAlive } from './net/session'
import type { Session } from './net/session'
import { BootScene } from './scenes/BootScene'
import { OfficeScene } from './scenes/OfficeScene'
import { createHud } from './ui/hud'
import type { Hud } from './ui/hud'
import { askName } from './ui/join'
import { showLogin, showLogout } from './ui/login'

const STATUS_TEXT: Record<ConnectionStatus, string | null> = {
  connecting: 'Conectando…',
  open: null,
  reconnecting: 'Conexão perdida, reconectando…',
  replaced: 'Sessão aberta em outra aba',
  expired: 'Sessão expirada',
}

function start(hud: Hud, connection: Connection): void {
  connection.onStatus((status) => {
    hud.setStatus(STATUS_TEXT[status])
    if (status === 'expired') location.assign('/')
  })

  new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: '#1d1f27',
    pixelArt: true,
    roundPixels: true,
    scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
    scene: [new BootScene(hud), new OfficeScene(connection, hud)],
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
