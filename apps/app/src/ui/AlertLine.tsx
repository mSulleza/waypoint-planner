import type { ReactNode } from 'react'
import { Pressable, View, type PressableStateCallbackType, type ViewStyle } from 'react-native'
import { Icon } from './icons'
import { Text } from './Text'
import { TYPE, useFocusRing, useTheme } from './theme'
import { Button } from './Button'
import { GUTTER, iconNudge, LINE_WIDTH, RADII, ROW_MIN_HEIGHT, SPACE, STATUS_FILL, STATUS_ICON, TEXT_GAP, type StatusTone } from './tokens'

export interface AlertLineProps {
  tone: StatusTone | 'neutral'
  // The alert's own words, which name the state, so colour is never the only signal.
  title: string
  // What it is about and how many more there are, under the title, such as 'Pesos · 2 more'; To-do passes the alert's whole sentence, amounts in <Money>.
  detail?: ReactNode
  onPress: () => void
  // Left out, the title and detail as drawn are its name, so a masked amount stays masked.
  accessibilityLabel?: string
}

// One alert on its status fill, its words first and the count of the rest under them; it opens the list it heads.
export function AlertLine({ tone, title, detail, onPress, accessibilityLabel }: AlertLineProps) {
  const { colors } = useTheme()
  const { ring, onFocus, onBlur } = useFocusRing()
  const ink = tone === 'neutral' ? colors.text2 : colors[tone]
  // A neutral alert is a white card; a status alert sits on its own fill.
  const fill = tone === 'neutral' ? colors.surface : colors[STATUS_FILL[tone]]
  const edge: ViewStyle = tone === 'neutral' ? { borderWidth: LINE_WIDTH, borderColor: colors.line } : {}
  const base: ViewStyle = { minHeight: ROW_MIN_HEIGHT, flexDirection: 'row', alignItems: 'center', gap: SPACE[3], paddingHorizontal: SPACE[4], paddingVertical: SPACE[2], borderRadius: RADII.card, backgroundColor: fill, ...edge }
  const pressed = ({ pressed: down, hovered }: PressableStateCallbackType & { hovered?: boolean }): ViewStyle | null => (down || hovered ? { opacity: 0.85 } : null)
  return (
    <Pressable role="button" aria-label={accessibilityLabel} onPress={onPress} onFocus={onFocus} onBlur={onBlur} style={(s) => [base, pressed(s), ring]}>
      <Icon name={tone === 'neutral' ? 'info' : STATUS_ICON[tone]} size={20} color={ink} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="subhead" style={{ fontWeight: '600' }}>
          {title}
        </Text>
        {detail ? (
          <Text variant="footnote" tone="text2">
            {detail}
          </Text>
        ) : null}
      </View>
      <Icon name="chevron-right" size={18} color={colors.text3} />
    </Pressable>
  )
}

export interface AlertRowProps {
  tone: StatusTone | 'neutral'
  title: string
  // The alert's sentence, amounts in <Money>.
  body: ReactNode
  onPress: () => void
  // A hairline above every row after the first.
  divider: boolean
  // One way to act on it, under its words, such as 'Compare a change'.
  action?: { label: string; accessibilityLabel?: string; onPress: () => void } | null
}

// One alert in a flush card of alerts: status colour on its icon only, its title in text colour and its sentence in text-2, so a list of them stays quiet.
export function AlertRow({ tone, title, body, onPress, divider, action }: AlertRowProps) {
  const { colors } = useTheme()
  const { ring, onFocus, onBlur } = useFocusRing()
  const ink = tone === 'neutral' ? colors.text2 : colors[tone]
  const hover = ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }): ViewStyle | null => (pressed || hovered ? { backgroundColor: colors.surface2 } : null)
  return (
    <View>
      {divider ? <View style={{ position: 'absolute', top: 0, left: GUTTER, right: 0, height: LINE_WIDTH, backgroundColor: colors.line, zIndex: 1 }} /> : null}
      <Pressable
        role="button"
        onPress={onPress}
        onFocus={onFocus}
        onBlur={onBlur}
        style={(s) => [{ minHeight: ROW_MIN_HEIGHT, flexDirection: 'row', alignItems: 'flex-start', gap: SPACE[3], paddingHorizontal: GUTTER, paddingTop: SPACE[3], paddingBottom: action ? SPACE[1] : SPACE[3] }, hover(s), ring && { ...ring, outlineOffset: -2 }]}
      >
        <View style={{ paddingTop: iconNudge(TYPE.subhead.lineHeight, 18) }}>
          <Icon name={tone === 'neutral' ? 'info' : STATUS_ICON[tone]} size={18} color={ink} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: TEXT_GAP }}>
          <Text variant="subhead" style={{ fontWeight: '600' }}>
            {title}
          </Text>
          <Text variant="footnote" tone="text2">
            {body}
          </Text>
        </View>
        <Icon name="chevron-right" size={18} color={colors.text3} />
      </Pressable>
      {action ? (
        // Lined up under the words, its padding pulled back so the label starts where they do.
        <View style={{ flexDirection: 'row', paddingLeft: GUTTER + 18 + SPACE[3] - SPACE[3], paddingBottom: SPACE[1] }}>
          <Button label={action.label} accessibilityLabel={action.accessibilityLabel} variant="plain" size="small" onPress={action.onPress} />
        </View>
      ) : null}
    </View>
  )
}
