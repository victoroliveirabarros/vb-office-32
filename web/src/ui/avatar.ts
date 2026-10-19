import { DEFAULT_APPEARANCE } from '../avatar/appearance'
import type { Appearance } from '../avatar/appearance'
import { CATEGORIES, FRAME_WIDTH } from '../avatar/catalog.gen'
import type { Category, Field } from '../avatar/catalog.gen'
import { composeStrip, drawFrame } from '../avatar/compose'
import { describe, EditorState } from '../avatar/editor'
import { frameFor, frameIndex } from '../avatar/frames'
import type { AvatarPrefs } from '../avatar/prefs'
import type { TypingGate } from '../chat/keys'
import type { Connection } from '../net/connection'
import type { Dir, ServerMessage } from '../net/protocol'
import { AVATAR_PARTS_URL } from '../scenes/assets'
import { requireElement } from './dom'

export type AvatarLink = Pick<Connection, 'send' | 'onMessage'>

const PREVIEW_SCALE = 4
const PREVIEW_TICK_MS = 150
// Four steps in each direction, then a quarter turn.
const TICKS_PER_DIR = 8
const TURN: readonly Dir[] = ['down', 'left', 'up', 'right']
// Thumbnails show the head: the top rows of the idle front frame.
const THUMB_HEIGHT = 13

type Choice = { field: Field; index: number; input: HTMLInputElement; thumb: HTMLCanvasElement | null }

function loadParts(): Promise<HTMLImageElement> {
  const img = new Image()
  img.src = AVATAR_PARTS_URL
  return img.decode().then(() => img)
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function choiceFor(cat: Category, index: number): { label: HTMLLabelElement; choice: Choice } {
  const option = cat.options[index]
  const label = el('label', 'choice')
  label.title = option?.label ?? ''
  const input = el('input', 'choice-input')
  input.type = 'radio'
  input.name = `avatar-${cat.field}`
  input.value = String(index)
  const face = el('span', cat.recolor ? `choice-face swatch-chip swatch-${cat.field}-${index}` : 'choice-face choice-style')
  face.setAttribute('aria-hidden', 'true')
  let thumb: HTMLCanvasElement | null = null
  if (!cat.recolor) {
    thumb = el('canvas', 'choice-thumb')
    thumb.width = FRAME_WIDTH
    thumb.height = THUMB_HEIGHT
    face.append(thumb)
  }
  label.append(input, face, el('span', 'sr-only', option?.label ?? ''))
  return { label, choice: { field: cat.field, index, input, thumb } }
}

/**
 * The "Personalizar" button and its dialog: a draft of the look with an
 * animated preview, saved in the browser and sent to the server.
 */
export function createAvatarEditor(link: AvatarLink, prefs: AvatarPrefs, gate: TypingGate): void {
  const button = requireElement('avatar-edit', HTMLButtonElement)
  const dialog = requireElement('avatar-editor', HTMLDialogElement)
  const options = requireElement('avatar-options', HTMLDivElement)
  const preview = requireElement('avatar-preview', HTMLCanvasElement)
  const turn = requireElement('avatar-turn', HTMLButtonElement)
  const random = requireElement('avatar-random', HTMLButtonElement)
  const close = requireElement('avatar-close', HTMLButtonElement)
  const cancel = requireElement('avatar-cancel', HTMLButtonElement)

  const state = new EditorState()
  const choices: Choice[] = []
  const ctx = preview.getContext('2d')
  let parts: HTMLImageElement | null = null
  let strip: HTMLCanvasElement | null = null
  let selfId: string | null = null
  let tick = 0
  let facing = 0
  let timer: number | undefined

  for (const cat of CATEGORIES) {
    const group = el('fieldset', 'editor-group')
    const list = el('div', `editor-choices editor-choices-${cat.recolor ? 'colors' : 'styles'}`)
    group.append(el('legend', 'editor-legend', cat.label), list)
    cat.options.forEach((_, i) => {
      const { label, choice } = choiceFor(cat, i)
      choice.input.addEventListener('change', () => {
        if (!choice.input.checked) return
        state.select(choice.field, choice.index)
        render()
      })
      choices.push(choice)
      list.append(label)
    })
    options.append(group)
  }

  function frame(): number {
    const dir = TURN[facing % TURN.length] ?? 'down'
    if (timer === undefined) return frameIndex(dir, 0)
    // Each tick is half a step: foot forward, then standing.
    return frameFor(dir, Math.floor(tick / 2), (tick % 2) / 2)
  }

  function drawPreview(): void {
    if (!ctx) return
    ctx.clearRect(0, 0, preview.width, preview.height)
    if (strip) drawFrame(ctx, strip, frame(), 0, 0, PREVIEW_SCALE)
  }

  function drawThumbs(look: Appearance): void {
    if (!parts) return
    for (const { field, index, thumb } of choices) {
      const tctx = thumb?.getContext('2d')
      if (!thumb || !tctx) continue
      const head = composeStrip(parts, { ...look, [field]: index })
      tctx.clearRect(0, 0, thumb.width, thumb.height)
      tctx.imageSmoothingEnabled = false
      tctx.drawImage(head, frameIndex('down', 0) * FRAME_WIDTH, 0, FRAME_WIDTH, THUMB_HEIGHT, 0, 0, FRAME_WIDTH, THUMB_HEIGHT)
    }
  }

  function render(): void {
    const look = state.draft
    for (const { field, index, input } of choices) input.checked = look[field] === index
    preview.setAttribute('aria-label', `Prévia do avatar: ${describe(look)}`)
    if (parts) {
      strip = composeStrip(parts, look)
      drawThumbs(look)
    }
    drawPreview()
  }

  function animate(on: boolean): void {
    clearInterval(timer)
    timer = undefined
    if (!on || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    timer = window.setInterval(() => {
      tick++
      if (tick % TICKS_PER_DIR === 0) facing++
      drawPreview()
    }, PREVIEW_TICK_MS)
  }

  function open(): void {
    state.open()
    tick = 0
    facing = 0
    dialog.returnValue = ''
    render()
    dialog.showModal()
    gate.setTyping('editor', true)
    animate(true)
    choices.find((c) => c.input.checked)?.input.focus()
  }

  function handle(msg: ServerMessage): void {
    if (msg.t === 'welcome') {
      selfId = msg.d.selfId
      const self = msg.d.players.find((p) => p.id === selfId)
      state.setCurrent(self?.appearance ?? DEFAULT_APPEARANCE)
      button.disabled = false
    } else if (msg.t === 'appearance' && msg.d.id === selfId) {
      state.setCurrent(msg.d.appearance)
    } else {
      return
    }
    if (dialog.open) render()
  }

  link.onMessage(handle)
  button.hidden = false
  button.addEventListener('click', open)

  turn.addEventListener('click', () => {
    facing++
    drawPreview()
  })
  // Salvar is the form's only submit button, so Enter on a choice saves.
  for (const b of [close, cancel]) b.addEventListener('click', () => dialog.close())
  random.addEventListener('click', () => {
    state.randomize()
    render()
  })

  // The game and the chat listen on window and document; nothing typed in
  // the dialog may reach them. Esc still cancels: that is the dialog's own.
  const keep = (e: KeyboardEvent) => e.stopPropagation()
  dialog.addEventListener('keydown', keep)
  dialog.addEventListener('keyup', keep)

  dialog.addEventListener('close', () => {
    animate(false)
    gate.setTyping('editor', false)
    if (dialog.returnValue === 'save') {
      const look = state.save()
      if (look) {
        prefs.save(look)
        link.send({ t: 'appearance', d: look })
      }
    } else {
      state.cancel()
    }
    button.focus()
  })

  void loadParts().then(
    (img) => {
      parts = img
      if (dialog.open) render()
    },
    () => undefined,
  )
}
