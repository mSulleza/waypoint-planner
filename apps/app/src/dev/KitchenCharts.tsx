import { useMemo, useState } from 'react'
import { View } from 'react-native'
import { Card } from '@/ui/Card'
import { LineChart } from '@/ui/chart/LineChart'
import { Sparkline } from '@/ui/chart/Sparkline'
import { Money } from '@/ui/Money'
import { Row } from '@/ui/Row'
import { Segmented } from '@/ui/Segmented'
import { Text } from '@/ui/Text'
import { useTheme } from '@/ui/theme'
import { identityColor, SPACE } from '@/ui/tokens'
import { chartSample, type SampleSpan } from './chart-sample'

const SPANS = [
  { value: 'month', label: 'December' },
  { value: 'year', label: '12 months' },
  { value: 'plan', label: '5 years' },
] as const

// The kitchen's chart section, loaded apart like the chart kit itself; perf.ts scrubs this chart.
export default function KitchenCharts() {
  const { scheme } = useTheme()
  const [span, setSpan] = useState<SampleSpan>('year')
  const sample = useMemo(() => chartSample(span), [span])
  const series = useMemo(() => sample.lines.map((l, i) => ({ ...l, colour: identityColor(i, scheme) })), [sample, scheme])
  const history = useMemo(() => {
    const plan = chartSample('plan')
    return plan.lines.map((l) => ({ id: l.id, label: l.label, year: l.points.slice(plan.todayIndex - 364, plan.todayIndex + 1), now: l.points[plan.todayIndex] ?? 0 }))
  }, [])
  return (
    <View style={{ gap: SPACE[3] }}>
      <View style={{ gap: SPACE[1] }}>
        <Text variant="title2" level={2}>
          Charts
        </Text>
        <Text variant="footnote" tone="text2">
          One pane per currency. Each line in its account's colour, named at its right end. History sits on the past band; a floor belongs to one account. Drag, hover or use the arrow keys to read a day.
        </Text>
      </View>
      <Segmented label="Span" value={span} onChange={setSpan} options={SPANS} />
      <Card>
        <LineChart series={series} floors={sample.floors} startDate={sample.startDate} todayIndex={sample.todayIndex} currency="EUR" locale="en-GB" title={sample.title} summary={sample.summary} />
      </Card>
      <Card flush>
        {history.map((h, i) => (
          <Row
            key={h.id}
            title={h.label}
            detail="Last 12 months"
            divider={i > 0}
            trailing={
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE[3] }}>
                <Sparkline values={h.year} colour={identityColor(i, scheme)} />
                <Money minor={h.now} currency="EUR" />
              </View>
            }
          />
        ))}
      </Card>
    </View>
  )
}
