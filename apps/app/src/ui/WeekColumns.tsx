import { View } from 'react-native'
import { Icon } from './icons'
import { Money } from './Money'
import { Text } from './Text'
import { useTheme } from './theme'
import { RADII, SPACE } from './tokens'

export interface WeekColumn {
  key: string
  // The days it covers, such as '19–25'.
  label: string
  // What the column states under its label: spent, or a week to come's budget.
  amount_minor: number
  currency: string
  // The fill from the bottom, 0 to 1; a week to come draws none.
  share: number
  over: boolean
  current: boolean
  future: boolean
  // Everything the column shows, in words, amounts through the spoken formatter so the eye hides them.
  spoken: string
}

// A month's weeks side by side, each filled with what was spent against its own budget; a week past its budget fills in caution with the triangle on it, so the colour never stands alone.
export function WeekColumns({ columns }: { columns: readonly WeekColumn[] }) {
  const { colors } = useTheme()
  return (
    <View style={{ flexDirection: 'row', gap: SPACE[2] }}>
      {columns.map((c) => (
        <View key={c.key} role="img" aria-label={c.spoken} style={{ flex: 1, minWidth: 0, gap: SPACE[1] }}>
          <View style={{ height: COLUMN_HEIGHT, borderRadius: RADII.chip, backgroundColor: colors.surface2, overflow: 'hidden', justifyContent: 'flex-end', borderWidth: c.current ? CURRENT_EDGE : 0, borderColor: colors.brandText }}>
            {c.future ? null : (
              <View style={{ height: `${c.share * 100}%`, backgroundColor: c.over ? colors.caution : colors.brandText, alignItems: 'center', justifyContent: 'center' }}>
                {c.over ? <Icon name="triangle-alert" size={14} color={colors.surface} strokeWidth={2.4} /> : null}
              </View>
            )}
          </View>
          <Text variant="caption" tone={c.current ? 'text' : 'text3'} numbers numberOfLines={1} style={{ textAlign: 'center', fontWeight: c.current ? '600' : '400' }}>
            {c.label}
          </Text>
          <Money minor={c.amount_minor} currency={c.currency} variant="caption" tone={c.future ? 'text3' : 'text2'} style={{ textAlign: 'center' }} />
        </View>
      ))}
    </View>
  )
}

// 40 tall, with the week in progress edged in Cobalt.
const COLUMN_HEIGHT = 40
const CURRENT_EDGE = 2
