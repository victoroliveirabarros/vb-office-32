const MIC_MUTED_KEY = 'vb-office-32.mic-muted'

export type MediaPrefs = {
  micMuted(): boolean
  setMicMuted(muted: boolean): void
}

export const storagePrefs: MediaPrefs = {
  micMuted() {
    try {
      return localStorage.getItem(MIC_MUTED_KEY) === '1'
    } catch {
      return false
    }
  },
  setMicMuted(muted) {
    try {
      if (muted) localStorage.setItem(MIC_MUTED_KEY, '1')
      else localStorage.removeItem(MIC_MUTED_KEY)
    } catch {
      // storage unavailable (private mode); the mic just starts on next time
    }
  },
}
