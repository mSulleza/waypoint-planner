import { View } from 'react-native'
import { Button } from '../Button'
import { Text } from '../Text'
import { SPACE } from '../tokens'
import { isZoomed, minWidth, rangeEnds, ZOOM_STEP, type ChartDays, type DayRange } from './zoom'

export interface ZoomBarProps {
  days: ChartDays
  range: DayRange
  locale: string
  onZoom: (factor: number) => void
  onReset: () => void
}

// Once above a chart's panes: the days in view, and buttons that zoom around their middle or show every day again.
export function ZoomBar({ days, range, locale, onZoom, onReset }: ZoomBarProps) {
  const zoomed = isZoomed(range, days.last)
  const [first, last] = rangeEnds(days, range, locale)
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE[1] }}>
      <View style={{ flex: 1 }} aria-live="polite">
        <Text variant="footnote" tone="text2" numbers>
          {`${first} – ${last}`}
        </Text>
      </View>
      <Button label="Zoom out" icon="minus" iconOnly variant="plain" disabled={!zoomed} onPress={() => onZoom(1 / ZOOM_STEP)} />
      <Button label="Zoom in" icon="plus" iconOnly variant="plain" disabled={range.to - range.from <= minWidth(days.last)} onPress={() => onZoom(ZOOM_STEP)} />
      <Button label="Reset" variant="plain" size="small" disabled={!zoomed} onPress={onReset} />
    </View>
  )
}
