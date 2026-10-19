import { chosenDevice, DEVICE_KINDS, deviceOptions, namesHidden } from '../media/devices'
import type { DeviceInfo, DeviceKind, DevicePrefs } from '../media/devices'
import type { LinkState } from '../media/client'
import { applyTheme, isTheme } from '../sidebar/prefs'
import type { ThemePrefs } from '../sidebar/prefs'
import { requireElement } from './dom'

/** What the settings drive of the media client; null without media. */
export type DeviceControl = {
  onLink(fn: (state: LinkState) => void): () => void
  selectDevice(kind: DeviceKind, id: string): Promise<boolean>
  activeDevice(kind: DeviceKind): string | undefined
}

export type SettingsHooks = {
  resetZoom(): void
  /** Present only with a login to end (OIDC). */
  logout?: () => void
}

// Output switching needs setSinkId, which not every browser has.
const canPickOutput = () => typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

/** Theme and devices, saved in this browser; the zoom default; signing out. */
export function createSettings(themes: ThemePrefs, devices: DevicePrefs, hooks: SettingsHooks): { bindMedia(media: DeviceControl): void; refresh(): void } {
  const themeInputs = [...requireElement('theme-choices', HTMLDivElement).querySelectorAll<HTMLInputElement>('input[name="theme"]')]
  const devicesGroup = requireElement('settings-devices', HTMLElement)
  const note = requireElement('settings-devices-note', HTMLParagraphElement)
  const zoomReset = requireElement('settings-zoom-reset', HTMLButtonElement)
  const account = requireElement('settings-account', HTMLElement)
  const logout = requireElement('logout', HTMLButtonElement)
  const selects = new Map<DeviceKind, { row: HTMLDivElement; select: HTMLSelectElement }>()
  for (const kind of DEVICE_KINDS) {
    selects.set(kind, { row: requireElement(`device-${kind}-row`, HTMLDivElement), select: requireElement(`device-${kind}`, HTMLSelectElement) })
  }

  const theme = themes.load()
  for (const input of themeInputs) {
    input.checked = input.value === theme
    input.addEventListener('change', () => {
      if (!input.checked || !isTheme(input.value)) return
      themes.save(input.value)
      applyTheme(document.documentElement, input.value)
    })
  }

  zoomReset.addEventListener('click', () => hooks.resetZoom())

  const { logout: onLogout } = hooks
  account.hidden = onLogout === undefined
  if (onLogout) {
    logout.addEventListener('click', () => {
      logout.disabled = true
      onLogout()
    })
  }

  let refresh = () => {}

  return {
    refresh: () => refresh(),
    bindMedia(media) {
      let live = false
      let busy = false

      const fill = async () => {
        if (!live || busy || !navigator.mediaDevices?.enumerateDevices) return
        busy = true
        let found: DeviceInfo[] = []
        try {
          found = await navigator.mediaDevices.enumerateDevices()
        } catch {
          // no devices to list
        }
        busy = false
        const saved = devices.load()
        let hidden = false
        for (const [kind, { row, select }] of selects) {
          const options = deviceOptions(found, kind)
          row.hidden = options.length === 0 || (kind === 'audiooutput' && !canPickOutput())
          if (row.hidden) continue
          hidden ||= namesHidden(found, kind)
          const chosen = chosenDevice(options, saved[kind], media.activeDevice(kind))
          select.replaceChildren(
            ...options.map((o) => {
              const option = document.createElement('option')
              option.value = o.id
              option.textContent = o.label
              return option
            }),
          )
          if (chosen !== null) select.value = chosen
        }
        note.textContent = hidden ? 'Os nomes dos aparelhos aparecem depois que o navegador libera o microfone ou a câmera.' : 'A escolha fica salva neste navegador.'
      }

      refresh = () => void fill()
      for (const [kind, { select }] of selects) {
        select.addEventListener('change', () => {
          void media.selectDevice(kind, select.value).then((ok) => {
            if (!ok && live) note.textContent = 'Não deu para trocar agora; a escolha vale na próxima conexão.'
          })
        })
      }

      media.onLink((state) => {
        live = state !== 'idle' && state !== 'stopped'
        devicesGroup.hidden = !live
        // The labels come once a device opens, a moment after connecting.
        if (state === 'connected') setTimeout(() => void fill(), 1500)
        void fill()
      })
      navigator.mediaDevices?.addEventListener?.('devicechange', () => void fill())
    },
  }
}
