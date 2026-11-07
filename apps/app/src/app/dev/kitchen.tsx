import { lazy, Suspense, useRef, useState, type ReactNode } from 'react'
import { ScrollView, View } from 'react-native'
import { AccountTile } from '@/ui/AccountTile'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { EmptyState } from '@/ui/EmptyState'
import { ICON_NAMES, Icon } from '@/ui/icons'
import { Money } from '@/ui/Money'
import { Pill } from '@/ui/Pill'
import { Row } from '@/ui/Row'
import { Segmented } from '@/ui/Segmented'
import { Sheet } from '@/ui/Sheet'
import { Text } from '@/ui/Text'
import { TYPE, useMask, useTheme } from '@/ui/theme'
import { GUTTER, IDENTITY, IDENTITY_GREY, LINE_WIDTH, RADII, SPACE, TEXT_GAP, TEXT_ROLES, type Palette } from '@/ui/tokens'

// Rendered in development, and in an exported build made with EXPO_PUBLIC_PERF_SAMPLES=1 so perf.ts can measure it.
export default function KitchenRoute() {
  if (!__DEV__ && process.env.EXPO_PUBLIC_PERF_SAMPLES !== '1') return null
  return <Kitchen />
}

// Loaded apart, as screens load the chart kit; folded away in a production build without the perf samples, so it adds no shared chunk there.
const KitchenCharts = __DEV__ || process.env.EXPO_PUBLIC_PERF_SAMPLES === '1' ? lazy(() => import('@/dev/KitchenCharts')) : () => null

const AMOUNTS = [
  { title: 'Everyday account', detail: 'EUR', minor: [642150, 618990], currency: 'EUR' },
  { title: 'Savings', detail: 'PHP', minor: [18240075, 18315000], currency: 'PHP' },
  { title: 'Visa card', detail: 'Owed, PHP', minor: [4582033, 4120000], currency: 'PHP', owed: true },
  { title: 'Overpaid card', detail: 'In credit, EUR', minor: [-12000, -12000], currency: 'EUR', owed: true },
  { title: 'Travel cash', detail: 'JPY, no decimals', minor: [1250000, 980000], currency: 'JPY' },
  { title: 'Deposit', detail: 'KWD, three decimals', minor: [1234567, 1234567], currency: 'KWD' },
  { title: 'Refund due', detail: 'USD, negative', minor: [-2599, -2599], currency: 'USD' },
] as const

const SAMPLES: Record<string, string> = {
  heroFigure: 'Mar 2028',
  display: 'Debt-free by June 2029',
  title1: 'Today',
  amount: '₱238,400.00',
  title2: 'Cash accounts',
  headline: 'Next 30 days',
  body: 'Pay the card statement before the due date.',
  subhead: 'Lowest balance 4 Nov',
  footnote: 'Updated 07:42',
  caption: 'Provisional',
  axis: 'Jan  Apr  Jul  Oct',
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <View style={{ gap: SPACE[3] }}>
      <View style={{ gap: SPACE[1] }}>
        <Text variant="title2" level={2}>
          {title}
        </Text>
        {note ? (
          <Text variant="footnote" tone="text2">
            {note}
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  )
}

function Swatch({ color, label, detail }: { color: string; label: string; detail?: string }) {
  const { colors } = useTheme()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE[2], width: 168 }}>
      <View style={{ width: 28, height: 28, borderRadius: RADII.chip, backgroundColor: color, borderWidth: LINE_WIDTH, borderColor: colors.line }} />
      <View>
        <Text variant="footnote" tone="text2">
          {label}
        </Text>
        {detail ? (
          <Text variant="caption" tone="text3" numbers>
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  )
}

function Kitchen() {
  const { scheme, colors } = useTheme()
  const { masked, setMasked } = useMask()
  const [later, setLater] = useState<0 | 1>(0)
  const [kind, setKind] = useState<'out' | 'in' | 'move'>('out')
  const [sheet, setSheet] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [log, setLog] = useState('Nothing pressed yet')
  const cancelRef = useRef<View>(null)
  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ padding: GUTTER, paddingBottom: SPACE[16], alignItems: 'center' }}>
      <View style={{ width: '100%', maxWidth: 720, gap: SPACE[8] }}>
        <View style={{ gap: SPACE[1] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACE[2] }}>
            <Text variant="title1" level={1}>
              Kitchen
            </Text>
            <Button label={masked ? 'Show amounts' : 'Hide amounts'} icon={masked ? 'eye-off' : 'eye'} iconOnly variant="plain" onPress={() => setMasked(!masked)} />
          </View>
          <Text variant="subhead" tone="text2">
            Every part of the UI kit, in the system {scheme} setting. Development only.
          </Text>
        </View>

        <Section title="Type" note="Instrument Sans, or the platform font if it fails to load. Sizes in pt; the web follows browser zoom.">
          <Card>
            {TEXT_ROLES.map((role) => (
              <View key={role} style={{ gap: TEXT_GAP }}>
                <Text variant="caption" tone="text3" numbers>
                  {role} {TYPE[role].fontSize}/{TYPE[role].lineHeight} {TYPE[role].fontWeight}
                </Text>
                <Text variant={role} numbers={role === 'axis' || role === 'amount' || role === 'heroFigure'}>
                  {SAMPLES[role]}
                </Text>
              </View>
            ))}
          </Card>
        </Section>

        <Section title="Money" note="Tabular figures. Owed amounts show positive with the word. The eye masks every amount.">
          <Card flush>
            {AMOUNTS.map((a, i) => (
              <Row key={a.title} title={a.title} detail={a.detail} divider={i > 0} trailing={<Money minor={a.minor[later]} currency={a.currency} owed={'owed' in a} />} />
            ))}
          </Card>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2] }}>
            <Button label="Change amounts" onPress={() => setLater(later === 0 ? 1 : 0)} />
            <Button label={masked ? 'Show amounts' : 'Hide amounts'} icon={masked ? 'eye-off' : 'eye'} variant="plain" onPress={() => setMasked(!masked)} />
          </View>
          <Card>
            <Text variant="footnote" tone="text2">
              Hero
            </Text>
            <Money minor={AMOUNTS[1].minor[later]} currency="PHP" variant="display" />
          </Card>
        </Section>

        <Suspense fallback={<Text tone="text2">Loading charts…</Text>}>
          <KitchenCharts />
        </Suspense>

        <Section title="Colour" note="Roles, not banks. Status colours always come with an icon and a word.">
          <Card>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[3] }}>
              {(Object.entries(colors) as [keyof Palette, string][]).map(([role, value]) => (
                <Swatch key={role} color={value} label={role.replace(/([A-Z0-9])/g, '-$1').toLowerCase()} detail={value} />
              ))}
            </View>
          </Card>
          <Card>
            <Text variant="footnote" tone="text2">
              Account identity, in account order, then grey
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[3] }}>
              {[...IDENTITY, IDENTITY_GREY].map((c) => (
                <Swatch key={c.name} color={c[scheme]} label={c.name} />
              ))}
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2] }}>
              {['Main', 'Tax', 'Example Bank', 'Sample Card', 'Travel card', 'Store card', 'Wallet card', 'Other card'].map((name, i) => (
                <AccountTile key={name} name={name} colour={i} />
              ))}
            </View>
          </Card>
          <Card>
            <Text variant="footnote" tone="text2">
              A square tile is an account; a round pill with an icon and a word is a status
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2] }}>
              <Pill tone="positive">OK</Pill>
              <Pill tone="caution">Tight</Pill>
              <Pill tone="negative">Short</Pill>
              <Pill tone="positive">Checked</Pill>
              <Pill tone="caution">Provisional</Pill>
              <Pill tone="negative">Over limit</Pill>
              <Pill tone="neutral" icon="file-text">
                Total only
              </Pill>
            </View>
          </Card>
        </Section>

        <Section title="Buttons" note="At least 44 pt tall (48 dp on Android); a small button narrows its padding, never its height.">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2], alignItems: 'center' }}>
            <Button label="Save" variant="primary" onPress={() => setLog('Save')} />
            <Button label="Record payment" variant="tonal" onPress={() => setLog('Record payment')} />
            <Button label="Cancel" onPress={() => setLog('Cancel')} />
            <Button label="Use password" variant="plain" onPress={() => setLog('Use password')} />
            <Button label="Retry" icon="rotate-cw" size="small" onPress={() => setLog('Retry')} />
            <Button label="Add" icon="plus" iconOnly onPress={() => setLog('Add')} />
            <Button label="Settings" icon="settings" iconOnly variant="plain" onPress={() => setLog('Settings')} />
            <Button label="Saving is off" variant="primary" disabled onPress={() => setLog('disabled')} />
          </View>
          <Text variant="footnote" tone="text2">
            Last pressed: {log}
          </Text>
        </Section>

        <Section title="Rows" note="At least 52 tall. Titles wrap; amounts keep their width.">
          <Card flush>
            <Row title="Rent" detail="Every month on the 1st" trailing={<Money minor={135000} currency="EUR" />} onPress={() => setLog('Rent')} />
            <Row title="A bill with a long name that wraps onto a second line at narrow widths" detail="Every month on the 15th" trailing={<Money minor={4999} currency="EUR" />} onPress={() => setLog('Long bill')} divider />
            <Row title="Settings" icon="settings" onPress={() => setLog('Settings row')} divider />
          </Card>
        </Section>

        <Section title="Banners">
          <Banner tone="negative" title="Couldn't load your data" body="Check your connection, then try again." action={{ label: 'Retry', icon: 'rotate-cw', onPress: () => setLog('Retry') }} />
          <Banner tone="caution" title="Offline · updated 07:42" body="Saving is off until you are back online." />
          <Banner tone="positive" title="Balances" body="The statement adds up." />
          <Banner tone="neutral" title="Sample data" body="Nothing you change here is saved." action={{ label: 'Exit', onPress: () => setLog('Exit') }} />
        </Section>

        <Section title="Segmented" note="One tab stop; arrow keys, Home and End move the choice.">
          <Segmented
            label="Kind of entry"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'out', label: 'Out' },
              { value: 'in', label: 'In' },
              { value: 'move', label: 'Move' },
            ]}
          />
          <Text variant="footnote" tone="text2">
            Picked: {kind}
          </Text>
        </Section>

        <Section title="Sheet" note="The only shadow. Focus moves in and returns; Escape closes. With Reduce Motion it only fades.">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2] }}>
            <Button label="Open a sheet" onPress={() => setSheet(true)} />
            <Button label="Delete a payment" onPress={() => setConfirm(true)} />
          </View>
        </Section>

        <Section title="Empty state" note="Why it is empty, what fills it, and one button.">
          <Card>
            <EmptyState title="Nothing to settle in October" body="Bills, income and transfers due this month show here." action={{ label: 'Add a plan item', onPress: () => setLog('Add a plan item') }} />
          </Card>
        </Section>

        <Section title="Icons" note="Lucide, ISC licence. Decorative; the label beside each carries the meaning.">
          <Card>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[3] }}>
              {ICON_NAMES.map((name) => (
                <View key={name} style={{ width: 120, flexDirection: 'row', alignItems: 'center', gap: SPACE[2] }}>
                  <Icon name={name} color={colors.text2} />
                  <Text variant="footnote" tone="text2">
                    {name}
                  </Text>
                </View>
              ))}
            </View>
          </Card>
        </Section>
      </View>

      <Sheet open={sheet} onClose={() => setSheet(false)} title="Add">
        <Segmented
          label="Kind of entry"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'out', label: 'Out' },
            { value: 'in', label: 'In' },
            { value: 'move', label: 'Move' },
          ]}
        />
        <Card flush>
          <Row title="Groceries" detail="Everyday account" trailing={<Money minor={4380} currency="EUR" />} />
        </Card>
        <Button label="Save" variant="primary" onPress={() => setSheet(false)} />
      </Sheet>

      <Sheet open={confirm} onClose={() => setConfirm(false)} title="Delete this payment?" initialFocus={cancelRef}>
        <Text tone="text2">The payment leaves the ledger and the month's figures change. This cannot be undone.</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2], justifyContent: 'flex-end' }}>
          <Button ref={cancelRef} label="Cancel" onPress={() => setConfirm(false)} />
          <Button
            label="Delete"
            variant="primary"
            onPress={() => {
              setLog('Delete')
              setConfirm(false)
            }}
          />
        </View>
      </Sheet>
    </ScrollView>
  )
}
