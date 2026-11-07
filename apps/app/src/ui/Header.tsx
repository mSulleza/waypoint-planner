import { useRouter } from 'expo-router'
import { Fragment, useEffect, useMemo } from 'react'
import { View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useSnapshot } from '@/data/hooks'
import { shortDay } from '@/data/status'
import { loadMonths } from '@/screens/months/load'
import { chrome, fxPairs, householdCurrencies, type FxPair, type ScreenKind } from '@/shell/shell.model'
import { useBack } from '@/shell/useBack'
import { AccountTile } from './AccountTile'
import { Button } from './Button'

import { FxRate } from './Money'
import { Text } from './Text'
import { MIN_TARGET, useLocale, useMask, useTheme } from './theme'
import { useIdentity } from './useIdentity'
import { CONTENT_MAX_WIDTH, GUTTER, SPACE, WIDE_MAX_WIDTH } from './tokens'

export interface HeaderProps {
  title: string
  kind: ScreenKind
  // The settings pages leave out their own Settings button.
  onSettings?: boolean
  // Lines up with a wide page's column.
  wide?: boolean
  // An account's own page: its 40 pt tile before the title, as its rows show it.
  accountId?: string
}

// One row: Back on pages, the title (the view's h1), then the eye, + on the tabs, and Settings wherever the sidebar is not showing it.
export function Header({ title, kind, onSettings = false, wide = false, accountId }: HeaderProps) {
  const { colors } = useTheme()
  const { width } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { masked, setMasked } = useMask()
  const c = chrome(kind, width, onSettings)
  // Fetches the chunk with the Add sheet, Months and Money once the screen has drawn, so none waits for it.
  useEffect(() => {
    if (!c.add) return
    const timer = setTimeout(() => void loadMonths().catch(() => undefined), 1000)
    return () => clearTimeout(timer)
  }, [c.add])
  const back = useBack()
  const accounts = useSnapshot().snapshot?.doc.accounts
  const colourOf = useIdentity()
  const tile = accountId && accounts?.some((a) => a.id === accountId) ? colourOf(accountId) : null
  return (
    <View style={{ backgroundColor: colors.bg, paddingTop: insets.top + SPACE[2], paddingHorizontal: GUTTER, paddingBottom: SPACE[2] }}>
      <View style={{ width: '100%', maxWidth: wide ? WIDE_MAX_WIDTH : CONTENT_MAX_WIDTH, alignSelf: 'center', flexDirection: 'row', alignItems: 'flex-start', gap: SPACE[1] }}>
        {c.back ? (
          <View style={{ marginLeft: -SPACE[3] }}>
            <Button label="Back" icon="arrow-left" iconOnly variant="icon" onPress={back} />
          </View>
        ) : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ minHeight: MIN_TARGET, flexDirection: 'row', alignItems: 'center', gap: SPACE[3] }}>
            {tile !== null ? <AccountTile name={title} colour={tile} size="large" /> : null}
            <Text variant="display" level={1} style={{ flexShrink: 1 }}>
              {title}
            </Text>
          </View>
          {c.fx ? <FxLine /> : null}
        </View>
        <View style={{ flexDirection: 'row', gap: SPACE[1], marginRight: c.settings ? -SPACE[3] : 0 }}>
          <Button label={masked ? 'Show amounts' : 'Hide amounts'} icon={masked ? 'eye-off' : 'eye'} iconOnly variant="icon" onPress={() => setMasked(!masked)} />
          {/* + is one of the few Cobalt fills (spec §8); the tools beside it are ink. */}
          {c.add ? <Button label="Add" icon="plus" iconOnly variant="primary" round onPress={() => router.push({ pathname: '/add', params: { mode: 'out' } })} /> : null}
          {c.settings ? <Button label="Settings" icon="settings" iconOnly variant="icon" onPress={() => router.push('/settings')} /> : null}
        </View>
      </View>
    </View>
  )
}

interface Fx {
  pairs: FxPair[]
  day: string | null
}

export function useFx(): Fx | null {
  const { household } = useSnapshot()
  const locale = useLocale()
  return useMemo(() => {
    if (!household) return null
    const { snapshot, rates } = household
    const pairs = fxPairs(snapshot.doc.household.base_currency, householdCurrencies(snapshot.doc), snapshot.rates)
    return pairs.length === 0 ? null : { pairs, day: rates.day ? shortDay(rates.day, locale) : null }
  }, [household, locale])
}

const CHIP_TEXT = { fontWeight: '600' } as const

// The FX rate, '€1 = ₱70.20 · 7 Oct', in a household holding two or more currencies: a neutral chip in text-2, since it is read, not tapped, and each part wraps whole at large text instead of clipping.
export function FxLine() {
  const { colors } = useTheme()
  const fx = useFx()
  if (!fx) return null
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        flexDirection: 'row',
        flexWrap: 'wrap',
        columnGap: SPACE[1],
        marginTop: SPACE[1],
        paddingVertical: SPACE[1],
        paddingHorizontal: CHIP_SIDE,
        borderRadius: CHIP_RADIUS,
        backgroundColor: colors.surface2,
      }}
    >
      {fx.pairs.map((p, i) => (
        <Fragment key={`${p.from}-${p.to}`}>
          {i > 0 ? <Dot /> : null}
          <FxRate from={p.from} to={p.to} unitMinor={p.unit_minor} quoteMinor={p.quote_minor} tone="text2" style={CHIP_TEXT} />
        </Fragment>
      ))}
      {fx.day ? (
        <>
          <Dot />
          <Text variant="footnote" tone="text2" style={CHIP_TEXT}>
            {fx.day}
          </Text>
        </>
      ) : null}
    </View>
  )
}

// A one-line chip is 26 tall and fully round; a wrapped one keeps the same corners.
const CHIP_RADIUS = 13
const CHIP_SIDE = 10

function Dot() {
  return (
    <Text variant="footnote" tone="text2" style={CHIP_TEXT} aria-hidden>
      ·
    </Text>
  )
}
