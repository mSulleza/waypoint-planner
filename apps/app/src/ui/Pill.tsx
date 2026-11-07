import { Text as RNText, View } from 'react-native'
import { Icon, type IconName } from './icons'
import { textStyle } from './Text'
import { useTheme } from './theme'
import { PILL, RADII, SPACE, STATUS_FILL, STATUS_ICON, TEXT_GAP, type StatusTone } from './tokens'

export type PillTone = StatusTone | 'neutral'

export interface PillProps {
  tone: PillTone
  children: string
  // A neutral pill's own icon, such as Total only's page; a status pill always takes its tone's.
  icon?: IconName
}

// A state as a round pill, its icon and word on the tone's own fill, so a status colour never stands alone (spec §8).
export function Pill({ tone, children, icon }: PillProps) {
  const { colors } = useTheme()
  const ink = tone === 'neutral' ? colors.text2 : colors[tone]
  const name = tone === 'neutral' ? icon : STATUS_ICON[tone]
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        flexShrink: 1,
        gap: SPACE[1],
        minHeight: PILL.height,
        paddingVertical: TEXT_GAP,
        paddingLeft: name ? PILL.iconSide : PILL.wordSide,
        paddingRight: PILL.wordSide,
        borderRadius: RADII.pill,
        backgroundColor: tone === 'neutral' ? colors.surface2 : colors[STATUS_FILL[tone]],
      }}
    >
      {name ? <Icon name={name} size={PILL.icon} color={ink} strokeWidth={2.4} /> : null}
      <RNText style={[textStyle('caption', ink), { flexShrink: 1 }]}>{children}</RNText>
    </View>
  )
}
