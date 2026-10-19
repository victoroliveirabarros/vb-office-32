import type { DeviceError, DeviceState, LinkState, MediaControls, MediaView, ScreenState } from '../media/client'
import { requireElement } from './dom'

const LINK_TEXT: Record<LinkState, string> = {
  idle: '',
  connecting: 'Conectando áudio…',
  connected: '',
  reconnecting: 'Reconectando áudio…',
  retrying: 'Reconectando áudio…',
  waiting: 'Reconectando áudio…',
  stopped: 'Áudio desconectado',
}

const MIC_ERROR: Record<DeviceError, string> = {
  denied: 'Microfone bloqueado no navegador',
  'not-found': 'Nenhum microfone encontrado',
  'in-use': 'Microfone em uso por outro app',
  other: 'Falha ao abrir o microfone',
}

const CAMERA_ERROR: Record<DeviceError, string> = {
  denied: 'Câmera bloqueada no navegador',
  'not-found': 'Nenhuma câmera encontrada',
  'in-use': 'Câmera em uso por outro app',
  other: 'Falha ao abrir a câmera',
}

const SCREEN_ERROR: Record<DeviceError, string> = {
  denied: 'Compartilhamento de tela bloqueado',
  'not-found': 'Nenhuma tela disponível',
  'in-use': 'Tela em uso por outro app',
  other: 'Falha ao compartilhar a tela',
}

const SELF = ''

export type BoundMediaView = MediaView & { bind(controls: MediaControls): void }

export function createMediaView(): BoundMediaView {
  const bar = requireElement('media-bar', HTMLDivElement)
  const micButton = requireElement('media-mic', HTMLButtonElement)
  const cameraButton = requireElement('media-camera', HTMLButtonElement)
  const screenButtonEl = requireElement('media-screen', HTMLButtonElement)
  const unlockButton = requireElement('media-unlock', HTMLButtonElement)
  const note = requireElement('media-note', HTMLSpanElement)
  const tiles = requireElement('media-tiles', HTMLDivElement)
  const audio = requireElement('media-audio', HTMLDivElement)
  const stage = requireElement('media-stage', HTMLDivElement)
  const stageLabel = requireElement('media-stage-label', HTMLSpanElement)
  const tileById = new Map<string, HTMLElement>()
  let stageId: string | null = null

  let link: LinkState = 'idle'
  let mic: DeviceState = { on: false, busy: false, error: null }
  let camera: DeviceState = { on: false, busy: false, error: null }
  let screen: ScreenState = { on: false, busy: false, error: null, meeting: false, taken: false }

  const render = () => {
    bar.hidden = link === 'idle'
    bar.dataset.link = link
    const stopped = link === 'stopped'
    renderButton(micButton, mic, stopped, 'microfone')
    renderButton(cameraButton, camera, stopped, 'câmera')
    const share = screenButton(screen, link)
    screenButtonEl.hidden = share.hidden
    screenButtonEl.disabled = share.disabled
    screenButtonEl.textContent = share.text
    screenButtonEl.title = share.title
    screenButtonEl.setAttribute('aria-pressed', String(screen.on))
    note.textContent =
      LINK_TEXT[link] ||
      (mic.error && MIC_ERROR[mic.error]) ||
      (camera.error && CAMERA_ERROR[camera.error]) ||
      (screen.error && SCREEN_ERROR[screen.error]) ||
      ''
    note.hidden = note.textContent === ''
  }

  const hideScreen = () => {
    stage.querySelector('video')?.remove()
    stage.hidden = true
    stageId = null
  }

  const removeTile = (id: string) => {
    tileById.get(id)?.remove()
    tileById.delete(id)
    tiles.hidden = tileById.size === 0
  }

  const addTile = (id: string, name: string, el: HTMLMediaElement) => {
    removeTile(id)
    const tile = document.createElement('div')
    tile.className = id === SELF ? 'tile self' : 'tile'
    const label = document.createElement('span')
    label.textContent = name
    tile.append(el, label)
    if (id === SELF) tiles.prepend(tile)
    else tiles.append(tile)
    tileById.set(id, tile)
    tiles.hidden = false
  }

  return {
    bind(controls) {
      micButton.addEventListener('click', () => controls.toggleMic())
      cameraButton.addEventListener('click', () => controls.toggleCamera())
      screenButtonEl.addEventListener('click', () => controls.toggleScreen())
      unlockButton.addEventListener('click', () => controls.startAudio())
    },
    setLink(state) {
      link = state
      render()
    },
    setMic(state) {
      mic = state
      render()
    },
    setCamera(state) {
      camera = state
      render()
    },
    setScreen(state) {
      screen = state
      render()
    },
    setPlaybackBlocked(blocked) {
      unlockButton.hidden = !blocked
    },
    addAudio(el) {
      audio.append(el)
    },
    showVideo: addTile,
    hideVideo: removeTile,
    showSelfVideo(el) {
      if (el) addTile(SELF, 'Você', el)
      else removeTile(SELF)
    },
    showScreen(identity, name, el) {
      hideScreen()
      stage.prepend(el)
      stageLabel.textContent = `Tela de ${name}`
      stage.hidden = false
      stageId = identity
    },
    hideScreen(identity) {
      if (identity === stageId) hideScreen()
    },
    clear() {
      for (const id of [...tileById.keys()]) removeTile(id)
      hideScreen()
      audio.replaceChildren()
    },
  }
}

export type DeviceButton = { pressed: boolean; disabled: boolean; error: boolean; label: string }

// A stopped link carries nothing, so its buttons show the devices off.
export function deviceButton(state: DeviceState, stopped: boolean, device: string): DeviceButton {
  const on = state.on && !stopped
  return {
    pressed: on,
    disabled: state.busy || stopped,
    error: state.error !== null,
    label: `${on ? 'Desligar' : 'Ligar'} ${device}`,
  }
}

export type ShareButton = { hidden: boolean; disabled: boolean; text: string; title: string }

// The share button shows only in a meeting room, or while sharing so it can
// always be stopped.
export function screenButton(state: ScreenState, link: LinkState): ShareButton {
  const stopped = link === 'stopped'
  if (state.on && !stopped) return { hidden: false, disabled: state.busy, text: 'Parar', title: 'Parar de compartilhar a tela' }
  const hidden = !state.meeting || stopped
  if (state.taken) return { hidden, disabled: true, text: 'Compartilhar tela', title: 'Alguém da sala já está compartilhando' }
  return {
    hidden,
    disabled: state.busy || link !== 'connected',
    text: 'Compartilhar tela',
    title: 'Compartilhar tela com quem está na sala',
  }
}

function renderButton(button: HTMLButtonElement, state: DeviceState, stopped: boolean, device: string): void {
  const view = deviceButton(state, stopped, device)
  button.setAttribute('aria-pressed', String(view.pressed))
  button.classList.toggle('error', view.error)
  button.disabled = view.disabled
  button.title = view.label
  button.setAttribute('aria-label', view.label)
}
