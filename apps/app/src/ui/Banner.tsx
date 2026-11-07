import { useState } from 'react'
import { View } from 'react-native'
import { Button } from './Button'
import { Icon, type IconName } from './icons'
import { Text } from './Text'
import { TYPE, useTheme } from './theme'
import { iconNudge, LINE_WIDTH, RADII, SPACE, STATUS_FILL, STATUS_ICON, TEXT_GAP, type StatusTone } from './tokens'

export interface BannerProps {
  tone: StatusTone | 'neutral'
  // The word that names the state, so colour is never the only signal.
  title: string
  body?: string
  action?: { label: string; onPress: () => void; icon?: IconName }
  // The technical words behind an error (the server's message), shown under the body only when asked for.
  detail?: string
}

// An error is a negative banner with Retry, shown above the figures it invalidates and never as a zero.
export function Banner({ tone, title, body, action, detail }: BannerProps) {
  const { colors } = useTheme()
  const [showDetail, setShowDetail] = useState(false)
  const neutral = tone === 'neutral'
  // A neutral banner is a white card like any other, not a grey panel; a status banner sits on its own fill.
  const fill = neutral ? colors.surface : colors[STATUS_FILL[tone]]
  const ink = neutral ? colors.text2 : colors[tone]
  return (
    <View
      role={tone === 'negative' ? 'alert' : 'status'}
      style={{
        backgroundColor: fill,
        borderWidth: neutral ? LINE_WIDTH : 0,
        borderColor: colors.line,
        borderRadius: RADII.card,
        padding: SPACE[3],
        paddingLeft: SPACE[4],
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: SPACE[3],
        rowGap: SPACE[2],
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: SPACE[3], flexGrow: 1, flexBasis: 200 }}>
        <View style={{ paddingTop: iconNudge(TYPE.headline.lineHeight, 20) }}>
          <Icon name={tone === 'neutral' ? 'info' : STATUS_ICON[tone]} size={20} color={ink} />
        </View>
        <View style={{ flex: 1, gap: TEXT_GAP }}>
          <Text variant="headline">{title}</Text>
          {body ? (
            <Text variant="subhead" tone="text2">
              {body}
            </Text>
          ) : null}
          {detail && showDetail ? (
            <Text variant="footnote" tone="text2" selectable>
              {detail}
            </Text>
          ) : null}
        </View>
      </View>
      {action || detail ? (
        <View style={{ marginLeft: 'auto', flexDirection: 'row', gap: SPACE[2] }}>
          {detail ? <Button label={showDetail ? 'Hide details' : 'Details'} variant="plain" size="small" onPress={() => setShowDetail((v) => !v)} /> : null}
          {/* On a status fill the button is white with a brand-text label, as the hero's is on Cobalt; on a white card it is tonal. */}
          {action ? <Button label={action.label} onPress={action.onPress} size="small" icon={action.icon} variant={neutral ? 'tonal' : 'secondary'} /> : null}
        </View>
      ) : null}
    </View>
  )
}
