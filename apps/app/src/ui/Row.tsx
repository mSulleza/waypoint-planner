import type { ReactNode } from 'react'
import { Pressable, View, type PressableStateCallbackType, type ViewStyle } from 'react-native'
import { Icon, type IconName } from './icons'
import { Text } from './Text'
import { MIN_TARGET, useFocusRing, useTheme } from './theme'
import { GUTTER, LINE_WIDTH, ROW_MIN_HEIGHT, SPACE, TEXT_GAP } from './tokens'

export interface RowProps {
  title: string
  detail?: string
  // Usually a <Money>; it keeps its width up to 60% of the row and the title wraps instead.
  trailing?: ReactNode
  icon?: IconName
  // Before the title, in place of an icon: an account's lettered tile.
  leading?: ReactNode
  onPress?: () => void
  // A hairline above the row, inset from the leading edge, for every row after the first.
  divider?: boolean
  accessibilityLabel?: string
}

export function Row({ title, detail, trailing, icon, leading, onPress, divider = false, accessibilityLabel }: RowProps) {
  const { colors } = useTheme()
  const { ring, onFocus, onBlur } = useFocusRing()
  const base: ViewStyle = {
    minHeight: Math.max(ROW_MIN_HEIGHT, MIN_TARGET),
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[3],
    paddingHorizontal: GUTTER,
    paddingVertical: SPACE[3],
  }
  const content = (
    <>
      {divider ? <View style={{ position: 'absolute', top: 0, left: GUTTER, right: 0, height: LINE_WIDTH, backgroundColor: colors.line }} /> : null}
      {icon ? <Icon name={icon} size={20} color={colors.text2} /> : null}
      {leading}
      {/* One row scale on every screen: the name in headline, as Today's and Debts' rows set it. */}
      <View style={{ flex: 1, minWidth: 0, gap: TEXT_GAP }}>
        <Text variant="headline">{title}</Text>
        {detail ? (
          <Text variant="footnote" tone="text2">
            {detail}
          </Text>
        ) : null}
      </View>
      {trailing ? <View style={{ flexShrink: 0, maxWidth: '60%', alignItems: 'flex-end' }}>{trailing}</View> : null}
      {onPress ? <Icon name="chevron-right" size={18} color={colors.text3} /> : null}
    </>
  )
  if (!onPress) return <View style={base}>{content}</View>
  const state = ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }): ViewStyle | null => (pressed || hovered ? { backgroundColor: colors.surface2 } : null)
  return (
    <Pressable role="button" aria-label={accessibilityLabel} onPress={onPress} onFocus={onFocus} onBlur={onBlur} style={(s) => [base, state(s), ring && { ...ring, outlineOffset: -2 }]}>
      {content}
    </Pressable>
  )
}
