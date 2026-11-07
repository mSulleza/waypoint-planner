import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrast, deltaE, luminance } from './contrast'
import { COLORS, FONT_FAMILIES, IDENTITY, IDENTITY_GREY, PICKED, RADII, STATUS_ICON, STATUS_TONES, TEXT_ROLES, UNPICKED, WEB_FONT_FAMILY, WORD_TONE, fontFace, fontWeightOf, identityColor, minTarget, typeRoles, type Palette, type Scheme } from './tokens'

const round = (ratio: number) => Math.round(ratio * 100) / 100

const SCHEMES: readonly Scheme[] = ['light', 'dark']
const TEXTS: readonly (keyof Palette)[] = ['text', 'text2', 'text3', 'brandText']
const STATUSES: readonly (keyof Palette)[] = ['positive', 'caution', 'negative']
const FILLS: readonly (keyof Palette)[] = ['positiveFill', 'cautionFill', 'negativeFill']
const SURFACES: readonly (keyof Palette)[] = ['bg', 'surface', 'surface2']
// Every background text or a status word can sit on.
const GROUNDS: readonly (keyof Palette)[] = [...SURFACES, ...FILLS, 'brandSoft']

interface Pair {
  fg: keyof Palette
  on: keyof Palette
  min: 4.5 | 3
  ratio: Record<Scheme, number>
}

const pair = (fg: keyof Palette, on: keyof Palette, min: 4.5 | 3, light: number, dark: number): Pair => ({ fg, on, min, ratio: { light, dark } })

// Every pair the Vivid mockup's contrast table names (text at 4.5 to 1, controls and graphics at 3 to 1), with its ratio in light and dark.
const PAIRS: readonly Pair[] = [
  pair('text', 'bg', 4.5, 16.24, 16.94),
  pair('text', 'surface', 4.5, 18.03, 14.37),
  pair('text', 'surface2', 4.5, 15.11, 11.75),
  pair('text2', 'bg', 4.5, 8.7, 11.62),
  pair('text2', 'surface', 4.5, 9.66, 9.86),
  pair('text2', 'surface2', 4.5, 8.09, 8.06),
  pair('text3', 'bg', 4.5, 5.99, 8.23),
  pair('text3', 'surface', 4.5, 6.65, 6.98),
  pair('text3', 'surface2', 4.5, 5.58, 5.71),
  pair('brandText', 'bg', 4.5, 6.56, 9.32),
  pair('brandText', 'surface', 4.5, 7.28, 7.91),
  pair('brandText', 'surface2', 4.5, 6.1, 6.46),
  pair('brandText', 'brandSoft', 4.5, 5.93, 5.76),
  // Also the hero's focus ring, since a brand-text ring would vanish on the brand card.
  pair('onBrand', 'brand', 4.5, 7.28, 5.82),
  pair('onBrand2', 'brand', 4.5, 5.67, 4.74),
  // The hero's one button: white with a light Cobalt label in both themes.
  pair('heroButtonText', 'onBrand', 4.5, 7.28, 7.28),
  pair('positive', 'surface', 4.5, 5.87, 8.59),
  pair('positive', 'positiveFill', 4.5, 5.11, 6.41),
  pair('caution', 'surface', 4.5, 6.33, 9.88),
  pair('caution', 'cautionFill', 4.5, 5.58, 7.78),
  pair('negative', 'surface', 4.5, 5.52, 6.88),
  pair('negative', 'negativeFill', 4.5, 4.63, 5.77),
  pair('text', 'positiveFill', 4.5, 15.68, 10.72),
  pair('text', 'cautionFill', 4.5, 15.91, 11.33),
  pair('text', 'negativeFill', 4.5, 15.11, 12.06),
  pair('text2', 'negativeFill', 4.5, 8.1, 8.27),
  pair('controlBorder', 'surface', 3, 4.68, 4.86),
  pair('controlBorder', 'bg', 3, 4.22, 5.73),
  pair('brand', 'bg', 3, 6.56, 3.2),
  pair('tabInd', 'surface', 3, 7.28, 7.91),
  // The active tab's icon, and the sidebar's active label, so text.
  pair('onTabInd', 'tabInd', 4.5, 7.28, 9.32),
  // A budget bar's fill on its track while spending fast; on pace it is brand-text on surface-2, above.
  pair('caution', 'surface2', 3, 5.31, 8.07),
  pair('focusRing', 'surface', 3, 7.28, 7.91),
]

// The letters on each identity tile (onId on the colour), light and dark.
const TILE_LETTERS: Record<string, [number, number]> = {
  sky: [5.55, 8.41],
  slate: [6.23, 8.63],
  teal: [5.71, 9.8],
  violet: [6.47, 8.42],
  raspberry: [6.43, 8.5],
  orange: [5.86, 10.17],
  green: [5.36, 10.83],
  grey: [4.67, 5.4],
}

function below(scheme: Scheme, fgs: readonly (keyof Palette)[], grounds: readonly (keyof Palette)[], min: number) {
  const p = COLORS[scheme]
  const pairs = fgs.flatMap((fg) => grounds.map((g) => ({ fg, g, ratio: contrast(p[fg], p[g]) })))
  return { count: pairs.length, failing: pairs.filter((x) => x.ratio < min).map((x) => `${scheme} ${x.fg} on ${x.g} ${x.ratio.toFixed(4)}`) }
}

describe('contrast formula', () => {
  it('gives 21 for black on white and 4.48 for #777777 on white', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2)
  })
})

describe.each(SCHEMES)('%s theme', (scheme) => {
  const p = COLORS[scheme]
  const side = scheme === 'light' ? 0 : 1

  it.each(PAIRS.map((x) => [`${x.fg} on ${x.on}`, x] as const))('holds %s at its ratio and above its minimum', (_, x) => {
    const ratio = contrast(p[x.fg], p[x.on])
    expect(round(ratio)).toBe(x.ratio[scheme])
    expect(ratio).toBeGreaterThanOrEqual(x.min)
  })

  it('holds 4.5 to 1 for every text role on every background', () => {
    const r = below(scheme, TEXTS, GROUNDS, 4.5)
    expect(r.count).toBe(28)
    expect(r.failing).toEqual([])
  })

  it('holds 4.5 to 1 for every status colour on bg, the surfaces, the status fills and brand-soft, but for light negative on brand-soft', () => {
    const r = below(scheme, STATUSES, GROUNDS, 4.5)
    expect(r.count).toBe(21)
    // WCAG does not round, so a status word on a brand-soft fill sits in a pill on its own status fill (the month strip's selected chip).
    expect(r.failing).toEqual(scheme === 'light' ? ['light negative on brandSoft 4.4996'] : [])
  })

  it('holds 3 to 1 for control-border and focus-ring on bg, surface and surface-2', () => {
    const r = below(scheme, ['controlBorder', 'focusRing'], SURFACES, 3)
    expect(r.count).toBe(6)
    expect(r.failing).toEqual([])
  })

  it('draws the focus ring and links in brand text, and the active tab in brand where brand clears 3 to 1 on a surface', () => {
    expect(p.focusRing).toBe(p.brandText)
    expect(p.tabInd).toBe(scheme === 'light' ? p.brand : p.brandText)
    expect(contrast(p.brand, p.surface) >= 3).toBe(scheme === 'light')
  })

  it('holds 4.5 to 1 for the letters on every identity tile', () => {
    const identity = [...IDENTITY, IDENTITY_GREY]
    expect(identity.map((c) => [c.name, round(contrast(p.onId, c[scheme]))])).toEqual(identity.map((c) => [c.name, TILE_LETTERS[c.name]?.[side]]))
    expect(identity.filter((c) => contrast(p.onId, c[scheme]) < 4.5)).toEqual([])
  })

  it('holds 3 to 1 for every identity colour, a tile or chart series, on bg, surface and surface-2', () => {
    const identity = [...IDENTITY, IDENTITY_GREY]
    const failing = identity.flatMap((c) => SURFACES.map((g) => ({ c: c.name, g, ratio: contrast(c[scheme], p[g]) }))).filter((x) => x.ratio < 3)
    expect(failing).toEqual([])
  })

  it('sets a picked choice apart from the ones beside it by 3 to 1 at its edge, and its label as bright as theirs', () => {
    const edge = [round(contrast(p[PICKED.edge], p[UNPICKED.edge])), round(contrast(p[PICKED.edge], p[UNPICKED.fill])), round(contrast(p[PICKED.edge], p[PICKED.fill]))]
    expect(edge).toEqual(scheme === 'light' ? [5.16, 7.28, 5.93] : [4.97, 7.91, 5.76])
    expect(edge.every((r) => r >= 3)).toBe(true)
    // The fill alone is a shade apart (1.23 to 1 light, 1.37 dark), which is why the edge and a check carry the state.
    expect(round(contrast(p[PICKED.fill], p[UNPICKED.fill]))).toBe(scheme === 'light' ? 1.23 : 1.37)
    expect([PICKED.label, UNPICKED.label, round(contrast(p[PICKED.label], p[PICKED.fill]))]).toEqual(['text', 'text', scheme === 'light' ? 14.69 : 10.47])
  })

  it('keeps identity colours apart from status and brand colours', () => {
    const taken = new Set([...STATUS_TONES.map((t) => p[t]), p.brand, p.brandText])
    const identity = [...IDENTITY.map((c) => c[scheme]), IDENTITY_GREY[scheme]]
    expect(identity.filter((c) => taken.has(c))).toEqual([])
    expect(new Set(identity).size).toBe(8)
  })
})

describe('tokens', () => {
  it('paints the light page blue-white under white cards and the dark page a blue-black ink with three stepped surfaces', () => {
    expect([COLORS.light.bg, COLORS.light.surface, COLORS.light.surface2]).toEqual(['#f0f3fb', '#ffffff', '#e6ebf8'])
    expect([COLORS.dark.bg, COLORS.dark.surface, COLORS.dark.surface2]).toEqual(['#0e1221', '#1b2236', '#283149'])
    const steps = [COLORS.dark.bg, COLORS.dark.surface, COLORS.dark.surface2].map(luminance)
    expect(steps).toEqual([...steps].sort((a, b) => a - b))
    expect(luminance(COLORS.dark.bg)).toBeGreaterThan(luminance('#0d0e11'))
  })

  it('tints the sheets’ scrim with the palette: the ink in light, an ink deeper than the dark page, never black', () => {
    expect([COLORS.light.scrim, COLORS.dark.scrim]).toEqual(['rgba(13, 20, 51, 0.32)', 'rgba(7, 9, 18, 0.64)'])
    const rgb = (c: string) => `#${(c.match(/\d+/g) ?? []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`
    expect([rgb(COLORS.light.scrim), rgb(COLORS.dark.scrim)]).toEqual([COLORS.light.text, '#070912'])
    expect(luminance(rgb(COLORS.dark.scrim))).toBeGreaterThan(luminance('#000000'))
  })

  it('makes Cobalt the brand: #2440e0 in light, #3352f0 in dark with #a2b4ff as text, and the hero button label #2440e0 in both', () => {
    expect([COLORS.light.brand, COLORS.light.brandText, COLORS.dark.brand, COLORS.dark.brandText]).toEqual(['#2440e0', '#2440e0', '#3352f0', '#a2b4ff'])
    expect([COLORS.light.heroButtonText, COLORS.dark.heroButtonText]).toEqual(['#2440e0', '#2440e0'])
  })

  it('gives every status colour its own icon', () => {
    const icons = STATUS_TONES.map((t) => STATUS_ICON[t])
    expect(icons).toEqual(['circle-check', 'triangle-alert', 'circle-alert'])
    expect(new Set(icons).size).toBe(STATUS_TONES.length)
  })

  it('takes the seven identity colours in account order, then grey for every account after', () => {
    expect(IDENTITY.map((c) => c.name)).toEqual(['teal', 'orange', 'violet', 'green', 'raspberry', 'sky', 'slate'])
    expect(identityColor(0, 'light')).toBe('#0b7275')
    expect(identityColor(6, 'dark')).toBe('#a7b0cc')
    expect([identityColor(7, 'light'), identityColor(12, 'dark')]).toEqual(['#747474', '#8a8a8a'])
  })

  it('orders the identity colours so the first four look far apart and the first is no Cobalt look-alike', () => {
    const d = (scheme: Scheme, i: number, j: number) => deltaE((IDENTITY[i] ?? IDENTITY_GREY)[scheme], (IDENTITY[j] ?? IDENTITY_GREY)[scheme])
    const pairs = [0, 1, 2, 3].flatMap((i) => [0, 1, 2, 3].filter((j) => j > i).map((j) => [i, j] as const))
    // Light identity colours all hold white letters, so they share a lightness (1.03 to 1 sky to teal); hue has to tell them apart.
    expect(SCHEMES.map((s) => Math.round(Math.min(...pairs.map(([i, j]) => d(s, i, j)))))).toEqual([53, 53])
    expect(SCHEMES.map((s) => Math.round(Math.min(...IDENTITY.slice(1).map((_, k) => d(s, k, k + 1)))))).toEqual([25, 25])
    expect([Math.round(deltaE(IDENTITY[0].light, COLORS.light.brand)), Math.round(deltaE(IDENTITY[0].dark, COLORS.dark.brandText))]).toEqual([104, 57])
  })

  it('sizes the type roles from the mockup, bold and tracked in where it is large', () => {
    const t = typeRoles('ios')
    expect(TEXT_ROLES).toEqual(['heroFigure', 'display', 'title1', 'amount', 'title2', 'headline', 'body', 'subhead', 'footnote', 'caption', 'axis'])
    expect(t.heroFigure).toEqual({ fontSize: 44, lineHeight: 50, fontWeight: '700', letterSpacing: -1.1 })
    expect(t.display).toEqual({ fontSize: 34, lineHeight: 40, fontWeight: '700', letterSpacing: -0.68 })
    expect(t.title2).toEqual({ fontSize: 20, lineHeight: 26, fontWeight: '700', letterSpacing: -0.2 })
    expect(t.amount).toEqual({ fontSize: 26, lineHeight: 32, fontWeight: '700', letterSpacing: -0.39 })
    expect(t.caption).toEqual({ fontSize: 12, lineHeight: 16, fontWeight: '600' })
    expect([t.body, typeRoles('android').body]).toEqual([
      { fontSize: 17, lineHeight: 22, fontWeight: '400' },
      { fontSize: 16, lineHeight: 24, fontWeight: '400' },
    ])
  })

  it('names one Instrument Sans file per weight, as the font package ships them', () => {
    const pkg = dirname(createRequire(import.meta.url).resolve('@expo-google-fonts/instrument-sans/package.json'))
    const files = Object.entries(FONT_FAMILIES).map(([weight, family]) => [weight, existsSync(join(pkg, family.replace('InstrumentSans_', ''), `${family}.ttf`))])
    expect(files).toEqual([
      ['400', true],
      ['500', true],
      ['600', true],
      ['700', true],
    ])
  })

  it('reads a style weight as one of the four files', () => {
    expect([undefined, 'normal', 300, '400', '500', '600', 650, 'bold', '700', 900].map(fontWeightOf)).toEqual(['400', '400', '400', '400', '500', '600', '600', '700', '700', '700'])
  })

  it('picks the weight’s own file once loaded, unsetting the weight on phones and keeping it on the web', () => {
    expect(fontFace('600', 'ios', true)).toEqual({ fontFamily: 'InstrumentSans_600SemiBold', fontWeight: undefined })
    expect(fontFace('700', 'android', true)).toEqual({ fontFamily: 'InstrumentSans_700Bold', fontWeight: undefined })
    expect(fontFace('400', 'web', true)).toEqual({ fontFamily: `"InstrumentSans_400Regular", ${WEB_FONT_FAMILY}`, fontWeight: '400' })
  })

  it('falls back to the platform font at the same weight when Instrument Sans did not load', () => {
    expect(fontFace('600', 'ios', false)).toEqual({ fontFamily: undefined, fontWeight: '600' })
    expect(fontFace('700', 'web', false)).toEqual({ fontFamily: WEB_FONT_FAMILY, fontWeight: '700' })
  })

  it('gives every account word its own status tone, OK included, so each is a pill', () => {
    expect(WORD_TONE).toEqual({ OK: 'positive', Tight: 'caution', Short: 'negative' })
  })

  it('rounds tiles 10, controls 14, cards 20, the hero 24 and sheets 28', () => {
    expect(RADII).toEqual({ chip: 8, tile: 10, control: 14, card: 20, hero: 24, sheet: 28, pill: 999 })
  })

  it('sizes touch targets 48 on Android and 44 elsewhere', () => {
    expect([minTarget('android'), minTarget('ios'), minTarget('web')]).toEqual([48, 44, 44])
  })
})
