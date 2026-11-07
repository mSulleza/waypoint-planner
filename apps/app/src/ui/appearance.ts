import type { Scheme } from './tokens'

// Settings' Appearance on this device: follow the device's light or dark setting, or keep one.
export type Appearance = 'system' | 'light' | 'dark'

export const APPEARANCES: readonly Appearance[] = ['system', 'light', 'dark']

// The web page's root carries a pinned scheme here; public/index.html sets it before the app loads.
export const ROOT_THEME_ATTRIBUTE = 'data-theme'

// System takes the device's scheme, light when it reports none; Light and Dark keep their own.
export function resolveScheme(appearance: Appearance, device: string | null | undefined): Scheme {
  if (appearance !== 'system') return appearance
  return device === 'dark' ? 'dark' : 'light'
}

// What Appearance.setColorScheme takes on phones, so the status bar, keyboard and alerts match; 'unspecified' hands it back to the device.
export function nativeScheme(appearance: Appearance): Scheme | 'unspecified' {
  return appearance === 'system' ? 'unspecified' : appearance
}

// The root's mark on the web; none for System, so the page's prefers-color-scheme rule decides.
export function rootTheme(appearance: Appearance): Scheme | null {
  return appearance === 'system' ? null : appearance
}
