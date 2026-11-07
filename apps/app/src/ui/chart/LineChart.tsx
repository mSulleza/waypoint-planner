import { lazy, Suspense, useMemo, useState } from 'react'
import { View } from 'react-native'
import { Text } from '../Text'
import { MIN_TARGET } from '../theme'
import { CHART_GAP, chartHeight, plotHeightFor, readoutFit } from './layout'
import { loadLinePlot } from './load'
import type { ChartFloor, ChartSeries } from './scale'
import type { ChartZoom } from './zoom'

export interface LineChartProps {
  // One pane: every series and floor is in minor units of this one currency.
  series: readonly ChartSeries[]
  floors: readonly ChartFloor[]
  startDate: string
  // Today's index in the points; history before it sits on the past band.
  todayIndex: number
  currency: string
  locale: string
  // The takeaway, shown as the chart's heading.
  title: string
  // Read after the title by screen readers.
  summary: string
  height?: number
  level?: 2 | 3 | 4
  // The days in view, shared by every pane of one chart; without it the plot shows all its days and does not zoom.
  zoom?: ChartZoom
}

function NotLoaded() {
  return (
    <Text variant="footnote" tone="text2">
      The chart could not load. Check the connection, then open this screen again.
    </Text>
  )
}

// The heading draws at once; the plot loads apart and its height is held until it arrives.
export function LineChart(props: LineChartProps) {
  const [width, setWidth] = useState(0)
  // Made per mount, so a failed fetch is tried again the next time the chart shows.
  const [Plot] = useState(() => lazy(() => loadLinePlot().then((m) => ({ default: m.LinePlot }), () => ({ default: NotLoaded }))))
  const plotHeight = props.height ?? plotHeightFor(width)
  const fit = useMemo(() => readoutFit(props.series, props.floors, props.currency, props.locale), [props.series, props.floors, props.currency, props.locale])
  const reserved = chartHeight({ width, readout: fit, plotHeight, minTarget: MIN_TARGET })
  return (
    <View style={{ gap: CHART_GAP }}>
      <Text variant="headline" level={props.level ?? 3}>
        {props.title}
      </Text>
      <View onLayout={(e) => setWidth(Math.floor(e.nativeEvent.layout.width))} style={{ minHeight: reserved }}>
        {width > 0 ? (
          <Suspense fallback={null}>
            <Plot {...props} width={width} height={plotHeight} fit={fit} />
          </Suspense>
        ) : null}
      </View>
    </View>
  )
}
