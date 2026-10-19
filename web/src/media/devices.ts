export const DEVICE_KINDS = ['audioinput', 'videoinput', 'audiooutput'] as const
export type DeviceKind = (typeof DEVICE_KINDS)[number]

export type DeviceInfo = { deviceId: string; kind: string; label: string }
export type DeviceOption = { id: string; label: string }

const NAMES: Record<DeviceKind, string> = { audioinput: 'Microfone', videoinput: 'Câmera', audiooutput: 'Saída de áudio' }

export function isDeviceKind(v: unknown): v is DeviceKind {
  return typeof v === 'string' && (DEVICE_KINDS as readonly string[]).includes(v)
}

/**
 * The devices of a kind to choose from. Before the page may use a device
 * the browser hides the labels (and on some, the ids): those get a number.
 */
export function deviceOptions(devices: readonly DeviceInfo[], kind: DeviceKind): DeviceOption[] {
  const seen = new Set<string>()
  const out: DeviceOption[] = []
  for (const d of devices) {
    if (d.kind !== kind || d.deviceId === '' || seen.has(d.deviceId)) continue
    seen.add(d.deviceId)
    out.push({ id: d.deviceId, label: d.label.trim() || `${NAMES[kind]} ${out.length + 1}` })
  }
  return out
}

/** Whether the browser still hides the names of this kind of device. */
export function namesHidden(devices: readonly DeviceInfo[], kind: DeviceKind): boolean {
  const ofKind = devices.filter((d) => d.kind === kind)
  return ofKind.length > 0 && ofKind.every((d) => d.label.trim() === '')
}

/** The option to show as chosen: the saved one, else the one in use, else the first. */
export function chosenDevice(options: readonly DeviceOption[], saved: string | undefined, active: string | undefined): string | null {
  for (const id of [saved, active]) if (id !== undefined && options.some((o) => o.id === id)) return id
  return options[0]?.id ?? null
}

export type Devices = Partial<Record<DeviceKind, string>>

const DEVICES_KEY = 'vb-office-32.devices'

export type DevicePrefs = {
  load(): Devices
  save(kind: DeviceKind, id: string): void
}

// Storage may be missing or throw on access (private mode, blocked site
// data); the browser's default devices are used then.
export function devicePrefs(storage: () => Storage = () => localStorage): DevicePrefs {
  const load = (): Devices => {
    try {
      const raw = storage().getItem(DEVICES_KEY)
      const saved: unknown = raw === null ? null : JSON.parse(raw)
      if (typeof saved !== 'object' || saved === null) return {}
      const out: Devices = {}
      for (const [kind, id] of Object.entries(saved)) if (isDeviceKind(kind) && typeof id === 'string' && id !== '') out[kind] = id
      return out
    } catch {
      return {}
    }
  }
  return {
    load,
    save(kind, id) {
      try {
        storage().setItem(DEVICES_KEY, JSON.stringify({ ...load(), [kind]: id }))
      } catch {
        // see above
      }
    },
  }
}
