export const THEMES = ['system', 'light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

const THEME_KEY = 'vb-office-32.theme'

export function isTheme(v: unknown): v is Theme {
  return typeof v === 'string' && (THEMES as readonly string[]).includes(v)
}

export type ThemePrefs = {
  load(): Theme
  save(theme: Theme): void
}

// Storage may be missing or throw on access (private mode, blocked site
// data); the page then follows the system.
export function themePrefs(storage: () => Storage = () => localStorage): ThemePrefs {
  return {
    load() {
      try {
        const saved = storage().getItem(THEME_KEY)
        return isTheme(saved) ? saved : 'system'
      } catch {
        return 'system'
      }
    },
    save(theme) {
      try {
        if (theme === 'system') storage().removeItem(THEME_KEY)
        else storage().setItem(THEME_KEY, theme)
      } catch {
        // see above
      }
    },
  }
}

/** The tokens in style.css follow data-theme on <html>; none follows the system. */
export function applyTheme(root: { dataset: DOMStringMap }, theme: Theme): void {
  if (theme === 'system') delete root.dataset.theme
  else root.dataset.theme = theme
}
