import type { DeviceError, DeviceState, LinkState, MediaControls, MediaView } from '../media/client'
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

const SELF = ''

export type BoundMediaView = MediaView & { bind(controls: MediaControls): void }

export function createMediaView(): BoundMediaView {
  const bar = requireElement('media-bar', HTMLDivElement)
  const micButton = requireElement('media-mic', HTMLButtonElement)
  const cameraButton = requireElement('media-camera', HTMLButtonElement)
  const unlockButton = requireElement('media-unlock', HTMLButtonElement)
  const note = requireElement('media-note', HTMLSpanElement)
  const tiles = requireElement('media-tiles', HTMLDivElement)
  const audio = requireElement('media-audio', HTMLDivElement)
  const tileById = new Map<string, HTMLElement>()

  let link: LinkState = 'idle'
  let mic: DeviceState = { on: false, busy: false, error: null }
  let camera: DeviceState = { on: false, busy: false, error: null }

  const render = () => {
    bar.hidden = link === 'idle'
    bar.dataset.link = link
    const stopped = link === 'stopped'
    renderButton(micButton, mic, stopped, 'microfone')
    renderButton(cameraButton, camera, stopped, 'câmera')
    note.textContent =
      LINK_TEXT[link] || (mic.error && MIC_ERROR[mic.error]) || (camera.error && CAMERA_ERROR[camera.error]) || ''
    note.hidden = note.textContent === ''
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
    clear() {
      for (const id of [...tileById.keys()]) removeTile(id)
      audio.replaceChildren()
    },
  }
}

function renderButton(button: HTMLButtonElement, state: DeviceState, stopped: boolean, device: string): void {
  button.setAttribute('aria-pressed', String(state.on))
  button.classList.toggle('error', state.error !== null)
  button.disabled = state.busy || stopped
  const label = `${state.on ? 'Desligar' : 'Ligar'} ${device}`
  button.title = label
  button.setAttribute('aria-label', label)
}
