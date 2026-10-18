import Phaser from 'phaser'
import { Connection, wsUrl } from './net/connection'
import type { ConnectionStatus } from './net/connection'
import { BootScene } from './scenes/BootScene'
import { OfficeScene } from './scenes/OfficeScene'
import { createHud } from './ui/hud'
import { askName } from './ui/join'

const STATUS_TEXT: Record<ConnectionStatus, string | null> = {
  connecting: 'Conectando…',
  open: null,
  reconnecting: 'Conexão perdida, reconectando…',
  replaced: 'Sessão aberta em outra aba',
}

function start(name: string): void {
  const hud = createHud()
  const connection = new Connection(wsUrl(name))
  connection.onStatus((status) => hud.setStatus(STATUS_TEXT[status]))

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

askName().then(start)
