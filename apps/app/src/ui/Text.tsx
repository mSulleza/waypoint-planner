import { Text as RNText, StyleSheet, View, type StyleProp, type TextProps as RNTextProps, type TextStyle } from 'react-native'
import { Icon } from './icons'
import { fontFor, TYPE, useTheme } from './theme'
import { SPACE, STATUS_ICON, type FontWeight, type StatusTone, type TextRole } from './tokens'

export type TextTone = 'text' | 'text2' | 'text3' | 'brandText' | 'onBrand' | 'onBrand2'

export interface TextProps extends RNTextProps {
  variant?: TextRole
  tone?: TextTone
  // Tabular figures, so digits line up in columns and do not jitter when they change.
  numbers?: boolean
  // A heading level; one level 1 per view.
  level?: 1 | 2 | 3 | 4
}

export function textStyle(variant: TextRole, color: string, numbers = false, weight?: FontWeight): TextStyle {
  const t = TYPE[variant]
  return { ...fontFor(weight ?? t.fontWeight), fontSize: t.fontSize, lineHeight: t.lineHeight, letterSpacing: t.letterSpacing, color, fontVariant: numbers ? ['tabular-nums'] : undefined }
}

// A weight set in a style takes its own font file, unless the style names its own family.
export function weightFace(style: StyleProp<TextStyle>): TextStyle | null {
  if (!style) return null
  const s = StyleSheet.flatten(style)
  return s.fontWeight === undefined || s.fontFamily !== undefined ? null : fontFor(s.fontWeight)
}

export function Text({ variant = 'body', tone = 'text', numbers, level, style, ...rest }: TextProps) {
  const { colors } = useTheme()
  const heading = level === undefined ? {} : ({ role: 'heading', 'aria-level': level } as RNTextProps)
  return <RNText {...heading} {...rest} style={[textStyle(variant, colors[tone], numbers), style, weightFace(style)]} />
}

export interface StatusTextProps {
  tone: StatusTone
  children: string
  variant?: TextRole
}

// A status colour always comes with its icon and a word.
export function StatusText({ tone, children, variant = 'subhead' }: StatusTextProps) {
  const { colors } = useTheme()
  const t = TYPE[variant]
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: SPACE[1] }}>
      {/* Centred on the first line, so a word that wraps keeps its icon beside its start. */}
      <View style={{ height: t.lineHeight, justifyContent: 'center' }}>
        <Icon name={STATUS_ICON[tone]} size={Math.round(t.fontSize * 1.05)} color={colors[tone]} />
      </View>
      <RNText style={[textStyle(variant, colors[tone], false, '600'), { flexShrink: 1 }]}>{children}</RNText>
    </View>
  )
}

export interface QuietStatusProps {
  children: string
  variant?: TextRole
}

// A healthy or finished state: its icon and word in text-3, so status colour stays for what needs attention.
export function QuietStatus({ children, variant = 'subhead' }: QuietStatusProps) {
  const { colors } = useTheme()
  const t = TYPE[variant]
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: SPACE[1] }}>
      <View style={{ height: t.lineHeight, justifyContent: 'center' }}>
        <Icon name={STATUS_ICON.positive} size={Math.round(t.fontSize * 1.05)} color={colors.text3} />
      </View>
      <RNText style={[textStyle(variant, colors.text3), { flexShrink: 1 }]}>{children}</RNText>
    </View>
  )
}
