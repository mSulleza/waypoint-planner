export type Scheme = 'light' | 'dark'

export interface Palette {
  bg: string
  surface: string
  surface2: string
  line: string
  controlBorder: string
  text: string
  text2: string
  text3: string
  // Cobalt as a fill: the answer card, the + button, a primary button.
  brand: string
  brandSoft: string
  // Cobalt as text and thin marks: links, the picked segment, a chart dot.
  brandText: string
  onBrand: string
  onBrand2: string
  // The label on the hero's one button, white (onBrand) with light Cobalt in both themes, as the mockup draws it.
  heroButtonText: string
  // Cobalt as a small fill on a surface (the active tab, a ticked box): brand in light, brandText in dark, where brand would sit under 3 to 1.
  tabInd: string
  onTabInd: string
  // A divider inside the hero: decorative, as every line is.
  heroLine: string
  // The letters on an account's identity tile.
  onId: string
  positive: string
  caution: string
  negative: string
  positiveFill: string
  cautionFill: string
  negativeFill: string
  focusRing: string
  scrim: string
}

// The Vivid palette (Mark, 10 Oct 2026): white cards on a cool blue-white page in light. Dark is a blue-black ink rather than navy, so Cobalt, the status colours and the identity colours carry the hue, and its three surfaces step up in lightness.
export const COLORS: Record<Scheme, Palette> = {
  light: {
    bg: '#f0f3fb',
    surface: '#ffffff',
    surface2: '#e6ebf8',
    line: '#d3d9ea',
    controlBorder: '#6b7391',
    text: '#0d1433',
    text2: '#3a4366',
    text3: '#525b7e',
    brand: '#2440e0',
    brandSoft: '#e2e7ff',
    brandText: '#2440e0',
    onBrand: '#ffffff',
    onBrand2: '#dce2ff',
    heroButtonText: '#2440e0',
    tabInd: '#2440e0',
    onTabInd: '#ffffff',
    heroLine: 'rgba(255, 255, 255, 0.3)',
    onId: '#ffffff',
    positive: '#12734a',
    caution: '#8a5300',
    negative: '#be3a10',
    positiveFill: '#dcf5e8',
    cautionFill: '#ffefd2',
    negativeFill: '#ffe6dc',
    focusRing: '#2440e0',
    // The ink, so a sheet's backdrop keeps the page's cool blue.
    scrim: 'rgba(13, 20, 51, 0.32)',
  },
  dark: {
    bg: '#0e1221',
    surface: '#1b2236',
    surface2: '#283149',
    line: '#38425f',
    controlBorder: '#838eaf',
    text: '#f2f4fa',
    text2: '#c7ccdc',
    text3: '#a4acc4',
    brand: '#3352f0',
    brandSoft: '#28356e',
    brandText: '#a2b4ff',
    onBrand: '#ffffff',
    onBrand2: '#e2e7ff',
    heroButtonText: '#2440e0',
    tabInd: '#a2b4ff',
    onTabInd: '#0e1221',
    heroLine: 'rgba(255, 255, 255, 0.3)',
    onId: '#0e1221',
    positive: '#4ed69a',
    caution: '#ffc25c',
    negative: '#ff8b66',
    positiveFill: '#123f31',
    cautionFill: '#403216',
    negativeFill: '#4b251f',
    focusRing: '#a2b4ff',
    // A deeper ink than the page, so it never turns black behind a sheet.
    scrim: 'rgba(7, 9, 18, 0.64)',
  },
}

// One look for a picked choice on every control (segments, chips, the month strip): a brand-soft fill inside a brand-text edge, with a check and the label in ink at 600, so it never reads quieter than the choices beside it.
export const PICKED = { fill: 'brandSoft', edge: 'brandText', label: 'text', check: 'brandText' } as const satisfies Record<string, keyof Palette>
// An unpicked chip: a white fill inside a decorative line, its label in ink; its words name it, so its edge needs no 3 to 1.
export const UNPICKED = { fill: 'surface', edge: 'line', label: 'text' } as const satisfies Record<string, keyof Palette>

export type StatusTone = 'positive' | 'caution' | 'negative'

export const STATUS_TONES: readonly StatusTone[] = ['positive', 'caution', 'negative']

// Each status colour has its own icon, so a state never rests on colour alone.
export const STATUS_ICON = { positive: 'circle-check', caution: 'triangle-alert', negative: 'circle-alert' } as const satisfies Record<StatusTone, string>

export const STATUS_FILL = { positive: 'positiveFill', caution: 'cautionFill', negative: 'negativeFill' } as const satisfies Record<StatusTone, keyof Palette>

export type AccountWord = 'OK' | 'Tight' | 'Short'

// The one status scale for a cash account, on every screen and the month strip: a pill with its icon and word, OK positive, Tight caution, Short negative.
export const WORD_TONE = { OK: 'positive', Tight: 'caution', Short: 'negative' } as const satisfies Record<AccountWord, StatusTone>

// Account identity colours on the Okabe-Ito hues, taken in account order: a lettered tile, a 10 px swatch or a chart series, always beside the name; never a status.
// Ordered so the first four differ most by eye (CIELAB ΔE ≥ 50 in both themes), since every light one holds white letters and so they share a lightness; the first is far from Cobalt, and sky, Cobalt's neighbour, comes late.
export const IDENTITY = [
  { name: 'teal', light: '#0b7275', dark: '#45cfcb' },
  { name: 'orange', light: '#a04e00', dark: '#ffae5e' },
  { name: 'violet', light: '#6b3fd0', dark: '#b7a0ff' },
  { name: 'green', light: '#2d7a1f', dark: '#8ed870' },
  { name: 'raspberry', light: '#b0245f', dark: '#ff8ab8' },
  { name: 'sky', light: '#1e6bb0', dark: '#6cb4f5' },
  { name: 'slate', light: '#56607e', dark: '#a7b0cc' },
] as const

// Every account after the seventh: a neutral grey, kept apart from slate's blue.
export const IDENTITY_GREY = { name: 'grey', light: '#747474', dark: '#8a8a8a' } as const

export function identityColor(index: number, scheme: Scheme): string {
  return (IDENTITY[index] ?? IDENTITY_GREY)[scheme]
}

export type TextRole = 'heroFigure' | 'display' | 'title1' | 'amount' | 'title2' | 'headline' | 'body' | 'subhead' | 'footnote' | 'caption' | 'axis'

export type FontWeight = '400' | '500' | '600' | '700'

export interface TypeStyle {
  fontSize: number
  lineHeight: number
  fontWeight: FontWeight
  letterSpacing?: number
}

export const TEXT_ROLES: readonly TextRole[] = ['heroFigure', 'display', 'title1', 'amount', 'title2', 'headline', 'body', 'subhead', 'footnote', 'caption', 'axis']

// Sizes in pt (dp on Android, CSS px on the web); body follows each platform's default. Large bold roles track in as the mockup does.
export function typeRoles(os: string): Record<TextRole, TypeStyle> {
  return {
    heroFigure: { fontSize: 44, lineHeight: 50, fontWeight: '700', letterSpacing: -1.1 },
    display: { fontSize: 34, lineHeight: 40, fontWeight: '700', letterSpacing: -0.68 },
    title1: { fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.42 },
    amount: { fontSize: 26, lineHeight: 32, fontWeight: '700', letterSpacing: -0.39 },
    title2: { fontSize: 20, lineHeight: 26, fontWeight: '700', letterSpacing: -0.2 },
    headline: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
    body: os === 'ios' ? { fontSize: 17, lineHeight: 22, fontWeight: '400' } : { fontSize: 16, lineHeight: 24, fontWeight: '400' },
    subhead: { fontSize: 15, lineHeight: 20, fontWeight: '400' },
    footnote: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
    caption: { fontSize: 12, lineHeight: 16, fontWeight: '600' },
    axis: { fontSize: 11, lineHeight: 13, fontWeight: '500' },
  }
}

// Instrument Sans (SIL OFL 1.1): expo-font in SDK 57 registers one family name per file, so each weight is its own family.
export const FONT_FAMILIES: Record<FontWeight, string> = {
  '400': 'InstrumentSans_400Regular',
  '500': 'InstrumentSans_500Medium',
  '600': 'InstrumentSans_600SemiBold',
  '700': 'InstrumentSans_700Bold',
}

export const WEB_FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

// A style's weight as one of the four files: normal and lighter take Regular, bold and heavier Bold.
export function fontWeightOf(weight: string | number | undefined): FontWeight {
  const n = weight === 'bold' ? 700 : Number(weight) || 400
  return n >= 700 ? '700' : n >= 600 ? '600' : n >= 500 ? '500' : '400'
}

export interface FontFace {
  fontFamily: string | undefined
  fontWeight: FontWeight | undefined
}

// Phones unset the weight, since iOS would pick a face by it and Android would embolden a bold file; the web keeps it, so a glyph the font lacks (₱) falls back at that weight.
export function fontFace(weight: FontWeight, os: string, loaded: boolean): FontFace {
  if (!loaded) return { fontFamily: os === 'web' ? WEB_FONT_FAMILY : undefined, fontWeight: weight }
  if (os === 'web') return { fontFamily: `"${FONT_FAMILIES[weight]}", ${WEB_FONT_FAMILY}`, fontWeight: weight }
  return { fontFamily: FONT_FAMILIES[weight], fontWeight: undefined }
}

export const SPACE = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48, 16: 64 } as const

// A title and its detail line sit this close: their line heights already carry the leading, so a 4-point step would read loose.
export const TEXT_GAP = 2

// Centres an icon on the first line of the text beside it.
export function iconNudge(lineHeight: number, size: number): number {
  return Math.max(0, (lineHeight - size) / 2)
}

// A segmented control's selected segment sits this far inside its line, as iOS draws it; its radius steps in by the same amount.
export const SEGMENT_INSET = 2

export const GUTTER = 16
export const CARD_PADDING = 16
// The reading column screens centre on wide windows, and the sidebar that holds the tabs from 1,024 px.
export const CONTENT_MAX_WIDTH = 720
// A page that lays out a wide table, such as Compare from 1,024 px.
export const WIDE_MAX_WIDTH = 1200
export const SIDEBAR_WIDTH = 240
export const ROW_MIN_HEIGHT = 52
export const LINE_WIDTH = 1
export const FOCUS_RING_WIDTH = 2

// A pill is fully round; a hero is the one filled answer card on a screen; chip is only a checkbox's press area and a neutral tag, which must not read as a pill.
export const RADII = { chip: 8, tile: 10, control: 14, card: 20, hero: 24, sheet: 28, pill: 999 } as const

// A status pill: 24 tall, a 14 pt icon, and a little less room on the icon's side than the word's, as the mockup draws it.
export const PILL = { height: 24, icon: 14, iconSide: 7, wordSide: 10 } as const

// An account's lettered tile: 36 in a row, 40 at the head of a debt card or an account's page.
export const TILE = { row: 36, large: 40 } as const

// An account's identity swatch beside its name: in Next 30 days, a chart's legend and a sheet's account choices.
export const SWATCH = { size: 10, radius: 3 } as const

export const SHEET_SHADOW = '0 8px 24px rgba(0, 0, 0, 0.12)'

export function minTarget(os: string): number {
  return os === 'android' ? 48 : 44
}
