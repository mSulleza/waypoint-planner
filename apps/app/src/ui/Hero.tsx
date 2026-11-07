import type { Copy } from '@waypoint/core'
import type { ReactNode } from 'react'
import { Platform, Pressable, View, type PressableStateCallbackType, type ViewStyle } from 'react-native'
import { CopyText } from './CopyText'
import { Text, type TextProps } from './Text'
import { MIN_TARGET, useFocusRing, useTheme } from './theme'
import { LINE_WIDTH, RADII, SPACE } from './tokens'

// The one Cobalt-filled card on a screen, holding the thing to do or know first (spec §8): flat, no shadow.
export function Hero({ children }: { children: ReactNode }) {
  const { colors } = useTheme()
  return <View style={{ backgroundColor: colors.brand, borderRadius: RADII.hero, padding: SPACE[5] }}>{children}</View>
}

// The small line above the hero's answer, such as 'Next action'.
export function HeroEyebrow({ children, ...rest }: { children: string } & Omit<TextProps, 'variant' | 'tone' | 'style'>) {
  return (
    <Text {...rest} variant="footnote" tone="onBrand2" style={{ fontWeight: '600' }}>
      {children}
    </Text>
  )
}

// Phones shrink the figure to one line at large text sizes; the web keeps it whole, where browser zoom reflows it.
const ONE_LINE = Platform.OS === 'web' ? {} : { numberOfLines: 1, adjustsFontSizeToFit: true }

// The hero's month in hero figures, short ('Nov 2027') so it fits one line at 320 pt; the heading around it says the month in full.
export function HeroFigure({ copy }: { copy: Copy }) {
  return <CopyText copy={copy} months="short" variant="heroFigure" tone="onBrand" aria-hidden {...ONE_LINE} />
}

export interface HeroButtonProps {
  label: string
  onPress: () => void
  accessibilityLabel?: string
}

// The hero's one button: white with a light Cobalt label in both themes, across the card's width.
export function HeroButton({ label, onPress, accessibilityLabel }: HeroButtonProps) {
  const { colors } = useTheme()
  const { ring, onFocus, onBlur } = useFocusRing()
  const state = ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }): ViewStyle | null => (pressed || hovered ? { opacity: pressed ? 0.85 : 0.92 } : null)
  return (
    <Pressable
      role="button"
      aria-label={accessibilityLabel}
      onPress={onPress}
      onFocus={onFocus}
      onBlur={onBlur}
      // The ring sits on the Cobalt card, so it is drawn in white rather than in Cobalt.
      style={(s) => [{ minHeight: Math.max(MIN_TARGET, 48), borderRadius: RADII.control, backgroundColor: colors.onBrand, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACE[4] }, state(s), ring && { ...ring, outlineColor: colors.onBrand }]}
    >
      <Text variant="headline" style={{ color: colors.heroButtonText, fontWeight: '700', textAlign: 'center' }}>
        {label}
      </Text>
    </Pressable>
  )
}

export interface HeroRowProps {
  label: string
  note?: ReactNode
  children: ReactNode
}

// A fact under the hero's answer: its label and note at the start, its value at the far edge, under a faint line.
export function HeroRow({ label, note, children }: HeroRowProps) {
  const { colors } = useTheme()
  return (
    <View style={{ borderTopWidth: LINE_WIDTH, borderTopColor: colors.heroLine, paddingTop: SPACE[3], flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', columnGap: SPACE[3], rowGap: SPACE[1] }}>
      <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 140 }}>
        <Text variant="headline" tone="onBrand">
          {label}
        </Text>
        {note}
      </View>
      <View style={{ marginLeft: 'auto', alignItems: 'flex-end' }}>{children}</View>
    </View>
  )
}
