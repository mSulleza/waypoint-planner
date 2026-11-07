import { useRouter } from 'expo-router'
import { useState } from 'react'
import type { BottomTabBarProps } from 'expo-router/js-tabs'
import { CommonActions } from 'expo-router/react-navigation'
import { Platform, Pressable, View, type GestureResponderEvent, type PressableProps, type PressableStateCallbackType, type ViewStyle } from 'react-native'
import { TABS, type TabName } from '@/shell/shell.model'
import { FxLine, useFx } from './Header'
import { Icon, type IconName } from './icons'
import { Text } from './Text'
import { MIN_TARGET, useFocusRing, useTheme } from './theme'
import { LINE_WIDTH, RADII, SIDEBAR_WIDTH, SPACE } from './tokens'

const ICONS: Record<TabName, IconName> = { index: 'sun', months: 'calendar', 'money/index': 'wallet', 'debts/index': 'credit-card', 'plan/index': 'route', 'meals/index': 'utensils', 'lending/index': 'gauge' }

const WEB = Platform.OS === 'web'

// On the web each tab is a link (middle-click opens a new tab); a plain click stays in the app, as React Navigation's own tab bar does.
export function plainClick(e: GestureResponderEvent): boolean {
  const m = e as unknown as { metaKey?: boolean; altKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; button?: number; preventDefault?: () => void }
  if (m.metaKey || m.altKey || m.ctrlKey || m.shiftKey || (m.button != null && m.button !== 0)) return false
  m.preventDefault?.()
  return true
}

interface ItemProps {
  label: string
  icon: IconName
  href: string
  active: boolean
  sidebar: boolean
  onPress: () => void
  // Settings sits with the tabs in the sidebar but opens a page, so phones announce it as a button.
  tab?: boolean
}

function Item({ label, icon, href, active, sidebar, onPress, tab = true }: ItemProps) {
  const { colors } = useTheme()
  const { ring, onFocus, onBlur } = useFocusRing()
  // The active tab is a small Cobalt fill on phones: tab-ind, which is brand in light and brand-text in dark, where brand is too dim on a surface.
  const ink = active ? colors.onTabInd : colors.text2
  const semantics = (WEB ? { href, role: 'link', 'aria-current': active ? 'page' : undefined } : tab ? { role: 'tab', 'aria-selected': active } : { role: 'button' }) as PressableProps
  const press = (e: GestureResponderEvent) => {
    if (!WEB || plainClick(e)) onPress()
  }
  const hover = ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }): ViewStyle | null => (!active && (hovered || pressed) ? { backgroundColor: colors.surface2 } : null)
  if (sidebar) {
    // A whole row of solid Cobalt would outshout the hero, so the sidebar marks the active section tonally: brand-soft with brand-text.
    const base: ViewStyle = { minHeight: MIN_TARGET, flexDirection: 'row', alignItems: 'center', gap: SPACE[3], paddingHorizontal: SPACE[3], borderRadius: RADII.control, backgroundColor: active ? colors.brandSoft : 'transparent' }
    return (
      <Pressable {...semantics} onPress={press} onFocus={onFocus} onBlur={onBlur} style={(s) => [base, hover(s), ring]}>
        <Icon name={icon} size={20} color={active ? colors.brandText : colors.text2} />
        <Text style={{ flexShrink: 1, color: active ? colors.brandText : colors.text, fontWeight: active ? '600' : '400' }}>
          {label}
        </Text>
      </Pressable>
    )
  }
  // A pill behind the active icon, so the current tab shows by shape as well as colour.
  return (
    <Pressable {...semantics} onPress={press} onFocus={onFocus} onBlur={onBlur} style={[{ flex: 1, minHeight: MIN_TARGET, alignItems: 'center', paddingTop: SPACE[2], paddingBottom: SPACE[1], gap: SPACE[1], borderRadius: RADII.control }, ring]}>
      {(s) => (
        <>
          <View style={[{ width: '100%', maxWidth: 60, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? colors.tabInd : 'transparent' }, hover(s)]}>
            <Icon name={icon} size={22} color={ink} />
          </View>
          <Text variant="caption" tone={active ? 'brandText' : 'text2'} style={{ fontWeight: active ? '700' : '600', textAlign: 'center' }}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  )
}

export interface TabBarProps extends BottomTabBarProps {
  sidebar: boolean
}

// The tabs: a bottom bar on phones, and from 1,024 px a sidebar that also holds the FX chip and Settings.
export function TabBar({ state, navigation, insets, sidebar }: TabBarProps) {
  const { colors } = useTheme()
  const router = useRouter()
  const fx = useFx()
  const focused = state.routes[state.index]?.name
  const items = TABS.map((tab) => {
    const route = state.routes.find((r) => r.name === tab.name)
    const onPress = () => {
      if (!route) return
      const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true })
      if (route.name !== focused && !event.defaultPrevented) navigation.dispatch({ ...CommonActions.navigate(route), target: state.key })
    }
    return <Item key={tab.name} label={tab.title} icon={ICONS[tab.name]} href={tab.href} active={tab.name === focused} sidebar={sidebar} onPress={onPress} />
  })
  const nav = WEB ? { role: 'navigation' as const, 'aria-label': 'Sections' } : { role: 'tablist' as const }
  if (!sidebar) {
    return (
      <View {...nav} style={{ flexDirection: 'row', backgroundColor: colors.surface, borderTopWidth: LINE_WIDTH, borderTopColor: colors.line, paddingHorizontal: SPACE[1], paddingBottom: Math.max(insets.bottom, SPACE[1]) }}>
        {items}
      </View>
    )
  }
  return (
    <View style={{ width: SIDEBAR_WIDTH, backgroundColor: colors.surface, borderRightWidth: LINE_WIDTH, borderRightColor: colors.line, paddingTop: insets.top + SPACE[2], paddingBottom: insets.bottom + SPACE[4], paddingHorizontal: SPACE[3] }}>
      {WEB ? <SkipLink /> : null}
      <View style={{ minHeight: MIN_TARGET, flexDirection: 'row', alignItems: 'center', gap: SPACE[2], paddingHorizontal: SPACE[3], marginBottom: SPACE[4] }}>
        <Icon name="route" size={20} color={colors.brandText} />
        <Text variant="headline">Waypoint</Text>
      </View>
      <View {...nav} style={{ flex: 1, gap: SPACE[1] }}>
        {items}
        <View style={{ marginTop: 'auto', gap: SPACE[3] }}>
          {fx ? (
            <View style={{ paddingHorizontal: SPACE[3] }}>
              <Text variant="caption" tone="text3">
                Exchange rate
              </Text>
              <FxLine />
            </View>
          ) : null}
          <Item label="Settings" icon="settings" href="/settings" active={false} sidebar tab={false} onPress={() => router.push('/settings')} />
        </View>
      </View>
    </View>
  )
}

// The first stop in the sidebar: hidden until focused, it moves the focus to the screen's heading, past the six section links (WCAG 2.4.1).
function SkipLink() {
  const { colors } = useTheme()
  const [shown, setShown] = useState(false)
  const skip = () => {
    // Pushed screens stay in the page hidden, so the heading taken is the one on show.
    const heading = [...globalThis.document.querySelectorAll<HTMLElement>('main h1')].find((h) => h.offsetParent !== null)
    if (!heading) return
    heading.tabIndex = -1
    heading.focus()
  }
  return (
    <Pressable
      role="button"
      onPress={skip}
      onFocus={() => setShown(true)}
      onBlur={() => setShown(false)}
      style={
        shown
          ? { position: 'absolute', zIndex: 2, top: SPACE[2], left: SPACE[3], minHeight: MIN_TARGET, justifyContent: 'center', paddingHorizontal: SPACE[3], borderRadius: RADII.control, backgroundColor: colors.tabInd, outlineStyle: 'solid', outlineWidth: 2, outlineColor: colors.focusRing, outlineOffset: 2 }
          : { position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 }
      }
    >
      <Text style={{ color: colors.onTabInd, fontWeight: '600' }}>
        Skip to content
      </Text>
    </Pressable>
  )
}
