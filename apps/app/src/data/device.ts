import type { Appearance } from '../ui/appearance'

// Settings kept on this device only: whether amounts open masked, and the appearance.
export const MASK_AT_OPEN_KEY = 'waypoint:mask-at-open'
// public/index.html reads this key too, so the first paint is already in the chosen theme.
export const APPEARANCE_KEY = 'waypoint:appearance'

// Private windows and blocked site data throw; the app then opens with amounts shown.
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function readMaskAtOpen(): boolean {
  try {
    return storage()?.getItem(MASK_AT_OPEN_KEY) === '1'
  } catch {
    return false
  }
}

// False when the device would not keep it, so Settings can say so.
export function rememberMaskAtOpen(on: boolean): boolean {
  try {
    const store = storage()
    if (!store) return false
    if (on) store.setItem(MASK_AT_OPEN_KEY, '1')
    else store.removeItem(MASK_AT_OPEN_KEY)
    return true
  } catch {
    return false
  }
}

// System unless Light or Dark is kept here; a missing, unknown or unreadable value is System.
export function readAppearance(): Appearance {
  try {
    const kept = storage()?.getItem(APPEARANCE_KEY)
    return kept === 'light' || kept === 'dark' ? kept : 'system'
  } catch {
    return 'system'
  }
}

// System is kept as no value; false when the device would not keep it.
export function rememberAppearance(appearance: Appearance): boolean {
  try {
    const store = storage()
    if (!store) return false
    if (appearance === 'system') store.removeItem(APPEARANCE_KEY)
    else store.setItem(APPEARANCE_KEY, appearance)
    return true
  } catch {
    return false
  }
}
