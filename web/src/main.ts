import Phaser from 'phaser'
import './style.css'
import './avatar/swatches.gen.css'
import { formatAppearance } from './avatar/appearance'
import { avatarPrefs } from './avatar/prefs'
import { rosterFeed } from './chat/feed'
import { TypingOwners } from './chat/keys'
import type { TypingGate } from './chat/keys'
import { sameRoom } from './game/zones'
import type { Room } from './game/zones'
import { MediaClient } from './media/client'
import type { MediaRoom, RoomListener } from './media/client'
import { devicePrefs } from './media/devices'
import { storagePrefs } from './media/prefs'
import { backoffDelay, Connection, wsUrl } from './net/connection'
import type { ConnectionStatus } from './net/connection'
import { fetchSession, logout, sessionAlive } from './net/session'
import type { Session } from './net/session'
import { BootScene } from './scenes/BootScene'
import { OfficeScene } from './scenes/OfficeScene'
import { applyTheme, themePrefs } from './sidebar/prefs'
import { DOCKED_QUERY, sidebarPrefs } from './sidebar/state'
import { createHud } from './ui/hud'
import type { Hud } from './ui/hud'
import { createAvatarEditor } from './ui/avatar'
import { createChat } from './ui/chat'
import { coverOf } from './ui/cover'
import { requireElement } from './ui/dom'
import { createHeads } from './ui/heads'
import { askName } from './ui/join'
import { showLogin } from './ui/login'
import { createMediaView } from './ui/media'
import { createPeople } from './ui/people'
import { createPersonPopover } from './ui/popover'
import { createProfile } from './ui/profile'
import { createRooms } from './ui/rooms'
import { createSettings } from './ui/settings'
import { createSidebar } from './ui/sidebar'
import { createToasts } from './ui/toast'
import { createZoomControls } from './ui/zoom'

const themes = themePrefs()
applyTheme(document.documentElement, themes.load())

const STATUS_TEXT: Record<ConnectionStatus, string | null> = {
  connecting: 'Conectando…',
  open: null,
  reconnecting: 'Conexão perdida, reconectando…',
  replaced: 'Sessão aberta em outra aba',
  expired: 'Sessão expirada',
}

const devices = devicePrefs()

// The SDK loads only once the server hands out a media grant.
async function createRoom(listener: RoomListener): Promise<MediaRoom> {
  const { createLiveKitRoom } = await import('./media/livekit')
  return createLiveKitRoom(listener, devices.load())
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

async function start(hud: Hud, connection: Connection, font: Promise<void>, onLogout?: () => void): Promise<void> {
  const view = createMediaView()
  const media = new MediaClient({ createRoom, view, prefs: storagePrefs, devices })
  view.bind(media)
  connection.onMessage((msg) => media.handle(msg))
  connection.onStatus((status) => {
    hud.setStatus(STATUS_TEXT[status])
    media.setConnectionStatus(status)
    if (status === 'expired') location.assign('/')
  })

  // The chat, the avatar editor and the panels' fields take the keyboard
  // from the scene, which opens the chat on a click on someone's avatar.
  const owners = new TypingOwners()
  const gate: TypingGate = {
    setTyping: (owner, on) => {
      owners.set(owner, on)
      office.setTyping(owner, on)
    },
  }
  // Before the chat and the panels, which read it on the same messages.
  const feed = rosterFeed(connection)
  // The strip names a desk after its owner, which the roster knows.
  let strip: Room | null = null
  feed.onChange(() => {
    const room = feed.roster.room
    if (sameRoom(room, strip)) return
    strip = room
    hud.setZone(room)
  })
  const heads = createHeads()
  const editor = createAvatarEditor(connection, prefs, gate)
  const sidebar = createSidebar(sidebarPrefs(), gate, {
    editAvatar: () => editor.open(),
    // A field of the sidebar keeps its shortcuts; the chat and the editor do not.
    keyboardFree: () => !owners.holds('chat') && !owners.holds('editor'),
  })
  const chat = createChat(connection, gate, feed, {
    show: () => sidebar.open('chat'),
    unread: (n) => sidebar.setCount('chat', n),
  })
  const showOnMap = (show: () => void) => {
    sidebar.revealMap()
    show()
  }
  const invite = (id: string, on: boolean) => connection.send({ t: on ? 'deskInvite' : 'deskRevoke', d: { target: id } })
  createPeople(
    feed,
    heads,
    media,
    {
      message: (id) => chat.openDirect(id),
      locate: (id) => showOnMap(() => office.showPerson(id)),
      invite,
    },
    (n) => sidebar.setCount('people', n),
  )
  const popover = createPersonPopover(feed, heads, { message: (id) => chat.openDirect(id), invite })
  createToasts(connection)
  const rooms = createRooms(feed, heads, (tiles) => showOnMap(() => office.showPlace(tiles)), (id) => invite(id, false))
  createProfile(feed, heads)
  const settings = createSettings(themes, devices, { resetZoom: () => office.resetZoom(), logout: onLogout })
  settings.bindMedia(media)
  sidebar.onShown((panel) => {
    chat.setShown(panel === 'chat')
    if (panel === 'settings') settings.refresh()
  })

  const game = requireElement('game', HTMLDivElement)
  const office = new OfficeScene(connection, hud, {
    speakers: media,
    zonesLoaded: (zones) => {
      feed.setZones(zones)
      rooms.setZones(zones)
    },
    // With a desk of ours the click also offers an invite.
    picked: (id) => (feed.roster.desks.mine() ? popover.open(id) : chat.openDirect(id)),
    desks: feed.roster.desks,
    zoom: createZoomControls(),
    cover: coverOf(requireElement('panel', HTMLElement), game, window.matchMedia(DOCKED_QUERY)),
  })
  sidebar.start()

  await font
  const phaser = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    transparent: true,
    pixelArt: true,
    roundPixels: true,
    // The wheel over the map zooms; ui/zoom.ts cancels its default there.
    input: { mouse: { preventDefaultWheel: false } },
    scale: { mode: Phaser.Scale.RESIZE, width: game.clientWidth, height: game.clientHeight },
    scene: [new BootScene(hud), office],
  })
  // The map's box also changes with the sidebar, not only the window.
  new ResizeObserver(() => {
    phaser.scale.dirty = true
  }).observe(game)
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
    const signOut = () => {
      void logout().finally(() => location.assign('/'))
    }
    await start(hud, new Connection(() => wsUrl(undefined, savedLook()), sessionAlive), font, signOut)
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
