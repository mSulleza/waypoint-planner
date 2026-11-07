import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react'
import { AccessibilityInfo, Platform, Appearance as SystemAppearance, useColorScheme, type HostInstance, type NativeSyntheticEvent, type View, type ViewStyle } from 'react-native'
import { nativeScheme, resolveScheme, ROOT_THEME_ATTRIBUTE, rootTheme, type Appearance } from './appearance'
import { COLORS, FOCUS_RING_WIDTH, fontFace, fontWeightOf, minTarget, typeRoles, type FontFace, type Palette, type Scheme } from './tokens'

export const MIN_TARGET = minTarget(Platform.OS)
export const TYPE = typeRoles(Platform.OS)

// A web font slower than this leaves the session on the platform font rather than a blank page.
const FONT_WAIT_MS = 3000

// Settled once, before the first screen renders, so every text in a session uses one font.
let font: 'waiting' | 'instrument' | 'platform' = 'waiting'
let settling: Promise<void> | null = null

function settleFont(): Promise<void> {
  if (settling) return settling
  const late = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), FONT_WAIT_MS))
  const loaded = import('./fonts').then((m) => m.loadInstrumentSans()).then(() => true)
  settling = Promise.race([loaded, late])
    .catch(() => false)
    .then((ok) => {
      font = ok ? 'instrument' : 'platform'
    })
  return settling
}

// Holds the first screen until Instrument Sans loads, fails or runs past FONT_WAIT_MS; true once the app may render.
export function useAppFont(): boolean {
  const [ready, setReady] = useState(font !== 'waiting')
  useEffect(() => {
    if (font !== 'waiting') return
    let live = true
    void settleFont().then(() => {
      if (live) setReady(true)
    })
    return () => {
      live = false
    }
  }, [])
  return ready
}

// The family and weight a text weight takes: Instrument Sans once loaded, else the platform font.
export function fontFor(weight: string | number | undefined): FontFace {
  return fontFace(fontWeightOf(weight), Platform.OS, font === 'instrument')
}

export interface Theme {
  scheme: Scheme
  colors: Palette
}

const THEMES: Record<Scheme, Theme> = { light: { scheme: 'light', colors: COLORS.light }, dark: { scheme: 'dark', colors: COLORS.dark } }

const ThemeContext = createContext<Theme>(THEMES.light)

export interface AppearanceSetting {
  appearance: Appearance
  setAppearance: (next: Appearance) => void
}

const AppearanceContext = createContext<AppearanceSetting>({ appearance: 'system', setAppearance: () => undefined })

// The appearance as last picked, so the router remounting the whole app keeps it where storage is blocked.
let lastAppearance: Appearance | null = null

// Marks the web page's root as the inline script in public/index.html does, so scrollbars and the page behind the app follow.
function markRoot(theme: Scheme | null) {
  const root = globalThis.document?.documentElement
  if (!root) return
  if (theme) root.setAttribute(ROOT_THEME_ATTRIBUTE, theme)
  else root.removeAttribute(ROOT_THEME_ATTRIBUTE)
}

// Settings' Appearance: System follows the device's light or dark setting, Light and Dark keep one. initial is read once when the app opens.
export function ThemeProvider({ initial = 'system', children }: { initial?: Appearance | (() => Appearance); children: ReactNode }) {
  const [appearance, setShown] = useState<Appearance>(() => lastAppearance ?? (typeof initial === 'function' ? initial() : initial))
  const scheme = resolveScheme(appearance, useColorScheme())
  useEffect(() => {
    if (Platform.OS === 'web') markRoot(rootTheme(appearance))
    else SystemAppearance.setColorScheme(nativeScheme(appearance))
  }, [appearance])
  const setAppearance = useCallback((next: Appearance) => {
    lastAppearance = next
    setShown(next)
  }, [])
  const setting = useMemo(() => ({ appearance, setAppearance }), [appearance, setAppearance])
  return (
    <AppearanceContext value={setting}>
      <ThemeContext value={THEMES[scheme]}>{children}</ThemeContext>
    </AppearanceContext>
  )
}

export function useTheme(): Theme {
  return useContext(ThemeContext)
}

export function useAppearance(): AppearanceSetting {
  return useContext(AppearanceContext)
}

export interface Mask {
  masked: boolean
  setMasked: (masked: boolean) => void
}

export const MaskContext = createContext<Mask>({ masked: false, setMasked: () => undefined })

// The eye as the person left it, so the router remounting the whole app (a pasted link with a new #fragment) keeps it.
let lastMasked: boolean | null = null

// initial may be a function, read once when the app opens (Settings' 'Mask amounts when the app opens').
export function MaskProvider({ initial = false, children }: { initial?: boolean | (() => boolean); children: ReactNode }) {
  const [masked, setShown] = useState(() => lastMasked ?? (typeof initial === 'function' ? initial() : initial))
  const setMasked = useCallback((next: boolean) => {
    lastMasked = next
    setShown(next)
  }, [])
  const value = useMemo(() => ({ masked, setMasked }), [masked, setMasked])
  return <MaskContext value={value}>{children}</MaskContext>
}

export function useMask(): Mask {
  return useContext(MaskContext)
}

// The household locale; until a household loads, the device's.
export const LocaleContext = createContext<string | undefined>(undefined)

export function useLocale(): string {
  return useContext(LocaleContext) ?? new Intl.NumberFormat().resolvedOptions().locale
}

export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    let live = true
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => {
      if (live) setReduce(on)
    })
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce)
    return () => {
      live = false
      sub?.remove()
    }
  }, [])
  return reduce
}

function keyboardFocus(e: NativeSyntheticEvent<unknown>): boolean {
  if (Platform.OS !== 'web') return true
  const target = e.nativeEvent && (e.nativeEvent as { target?: unknown }).target
  // A mouse or touch focus is not :focus-visible, so the ring shows only for the keyboard.
  return target instanceof Element ? target.matches(':focus-visible') : true
}

export function useFocusRing() {
  const { colors } = useTheme()
  const [visible, setVisible] = useState(false)
  const onFocus = useCallback((e: NativeSyntheticEvent<unknown>) => setVisible(keyboardFocus(e)), [])
  const onBlur = useCallback(() => setVisible(false), [])
  const ring: ViewStyle | null = visible ? { outlineColor: colors.focusRing, outlineStyle: 'solid', outlineWidth: FOCUS_RING_WIDTH, outlineOffset: FOCUS_RING_WIDTH } : null
  return { ring, onFocus, onBlur }
}

// A control that takes the focus when it appears, such as Cancel in a destructive confirm: keyboard focus on the web, the screen reader's on phones.
export function useFocusOnMount(ref: RefObject<View | null>) {
  useEffect(() => {
    if (Platform.OS !== 'web') {
      if (ref.current) AccessibilityInfo.sendAccessibilityEvent(ref.current as unknown as HostInstance, 'focus')
      return
    }
    const frame = requestAnimationFrame(() => ref.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [ref])
}
