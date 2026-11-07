import { formatMoney } from '@waypoint/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Animated, Easing, Platform, View, type TextProps as RNTextProps, type TextStyle } from 'react-native'
import { DURATION, EASING } from './motion'
import { Text, textStyle, weightFace, type TextTone } from './Text'
import { TYPE, useLocale, useMask, useTheme } from './theme'
import { SPACE, type TextRole } from './tokens'

export interface MoneyProps {
  minor: number
  currency: string
  // An amount owed, positive while owed: shown without a sign and followed by 'owed'.
  owed?: boolean
  // A change rather than a balance: money in reads '+€40.00'.
  signed?: boolean
  variant?: TextRole
  tone?: TextTone
  style?: TextStyle
}

const MONEY_MARK = (Platform.OS === 'web' ? { dataSet: { money: '' } } : {}) as RNTextProps
const EASE = Easing.bezier(...EASING.standard)
const useNativeDriver = Platform.OS !== 'web'

// Fades through over 150 ms: the old figure out, the new one in. Never counts up.
function useFadeThrough(text: string): { shown: string; opacity: Animated.Value } {
  const [shown, setShown] = useState(text)
  const opacity = useRef(new Animated.Value(1)).current
  const running = useRef<Animated.CompositeAnimation | null>(null)
  useEffect(() => {
    running.current?.stop()
    const to = text === shown ? 1 : 0
    running.current = Animated.timing(opacity, { toValue: to, duration: DURATION.fade / 2, easing: EASE, useNativeDriver })
    running.current.start(({ finished }) => {
      if (finished && to === 0) setShown(text)
    })
  }, [text, shown, opacity])
  useEffect(() => () => running.current?.stop(), [])
  return { shown, opacity }
}

// Masked, a figure is read as hidden rather than as its bullets.
function Figure({ text, variant, tone, style, hidden = 'Amount hidden' }: { text: string; variant: TextRole; tone: TextTone; style?: TextStyle; hidden?: string }) {
  const { colors } = useTheme()
  const { masked } = useMask()
  const { shown, opacity } = useFadeThrough(text)
  return (
    <Animated.Text {...MONEY_MARK} aria-label={masked ? hidden : undefined} style={[textStyle(variant, colors[tone], true), style, weightFace(style), { opacity }]}>
      {shown}
    </Animated.Text>
  )
}

// An amount as words for a screen reader's label, through the same formatter: 'amount hidden' under the eye.
export function useSpokenMoney(): (minor: number, currency: string, signed?: boolean) => string {
  const { masked } = useMask()
  const locale = useLocale()
  return useCallback(
    (minor, currency, signed = false) => {
      if (masked) return 'amount hidden'
      const plain = formatMoney(minor, currency, locale)
      return signed && minor > 0 ? `+${plain}` : plain
    },
    [masked, locale],
  )
}

// An amount as text inside a line of words, through the same formatter and the same mask as <Money>.
export function useMoneyText(): (minor: number, currency: string) => string {
  const { masked } = useMask()
  const locale = useLocale()
  return useCallback((minor, currency) => formatMoney(minor, currency, locale, { mask: masked }), [masked, locale])
}

export function Money({ minor, currency, owed = false, signed = false, variant = 'body', tone = 'text', style }: MoneyProps) {
  const { masked } = useMask()
  const locale = useLocale()
  const plain = formatMoney(owed ? Math.abs(minor) : minor, currency, locale, { mask: masked })
  const amount = signed && minor > 0 && !masked ? `+${plain}` : plain
  // A negative amount owed is a credit, which 'owed' would misstate. The word is a state, like Short, so it stays under the eye; the amount does not.
  const text = owed ? `${amount} ${minor < 0 ? 'in credit' : 'owed'}` : amount
  return <Figure text={text} variant={variant} tone={tone} style={style} />
}

export interface FxRateProps {
  from: string
  to: string
  // One unit of `from` in minor units, and what it buys of `to`.
  unitMinor: number
  quoteMinor: number
  variant?: TextRole
  tone?: TextTone
  style?: TextStyle
}

// An exchange rate as the FX chip shows it, '€1 = ₱70.20': the unit is whole, the price has the currency's decimals, and the eye masks both.
export function FxRate({ from, to, unitMinor, quoteMinor, variant = 'footnote', tone = 'text2', style }: FxRateProps) {
  const { masked } = useMask()
  const locale = useLocale()
  const text = `${formatMoney(unitMinor, from, locale, { mask: masked, compact: true })} = ${formatMoney(quoteMinor, to, locale, { mask: masked })}`
  return <Figure text={text} variant={variant} tone={tone} style={style} hidden="Exchange rate hidden" />
}

// An amount's width in tabular figures, unmasked, so the eye never moves a column: digits a little over half an em, separators a little over a quarter.
export function figureWidth(text: string, fontSize: number): number {
  let em = 0
  for (const ch of text) em += /[0-9]/.test(ch) ? 0.6 : /[.,'\u00a0\u202f ]/.test(ch) ? 0.3 : 0.65
  return Math.ceil(em * fontSize)
}

// The widest of a column's amounts, unmasked, so the figures line up and the eye never moves them.
export function widestFigure(amounts: readonly { minor: number; currency: string }[], locale: string, variant: TextRole = 'body'): number {
  return Math.max(0, ...amounts.map((a) => figureWidth(formatMoney(a.minor, a.currency, locale), TYPE[variant].fontSize)))
}

const END_WEIGHT = { fontWeight: '700' } as const

export interface FromToWidths {
  from: number
  to: number
}

// The widest live and month-end figure of a list of rows, so every row's arrow sits in one column.
export function fromToWidths(rows: readonly { from: number; to: number; currency: string }[], locale: string): FromToWidths {
  let [from, to] = [0, 0]
  for (const r of rows) {
    from = Math.max(from, figureWidth(formatMoney(r.from, r.currency, locale), TYPE.subhead.fontSize))
    to = Math.max(to, figureWidth(formatMoney(r.to, r.currency, locale), TYPE.body.fontSize))
  }
  return { from, to }
}

// 'Now → month end' as two right-aligned figures in fixed columns: the live one quiet, the month end bold, since that is the figure that matters.
export function FromTo({ from, to, currency, widths }: { from: number; to: number; currency: string; widths: FromToWidths }) {
  return (
    <View style={{ flexShrink: 0, flexDirection: 'row', alignItems: 'baseline', gap: SPACE[2] }}>
      <View style={{ minWidth: widths.from, alignItems: 'flex-end' }}>
        <Money minor={from} currency={currency} variant="subhead" tone="text2" />
      </View>
      <Text variant="subhead" tone="text3" aria-hidden>
        →
      </Text>
      <View style={{ minWidth: widths.to, alignItems: 'flex-end' }}>
        <Money minor={to} currency={currency} style={END_WEIGHT} />
      </View>
    </View>
  )
}
