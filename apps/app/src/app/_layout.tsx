import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { Platform } from 'react-native'
import { readAppearance, readMaskAtOpen } from '@/data/device'
import { HouseholdLocale, useSnapshot } from '@/data/hooks'
import { DataProvider, useDataSource } from '@/data/source'
import { gate, PAGE_ROUTES, SHEET_ROUTES } from '@/shell/gate.model'
import { useNoteRoute } from '@/shell/useBack'
import { MIN_TARGET, MaskProvider, ThemeProvider, useAppFont, useTheme } from '@/ui/theme'

// A deep link to a page or a sheet still has the tabs beneath it, so Back and closing land on them.
export const unstable_settings = { anchor: '(tabs)' }

export default function RootLayout() {
  const fontReady = useAppFont()
  useEffect(() => {
    // Folded away in a production build, so the audit's code never ships.
    if (__DEV__ && Platform.OS === 'web') void import('@/dev/audit').then((m) => m.installAudit(MIN_TARGET))
  }, [])
  return (
    <ThemeProvider initial={readAppearance}>
      <MaskProvider initial={readMaskAtOpen}>
        <DataProvider>
          <HouseholdLocale>
            {/* The snapshot loads while Instrument Sans does; the page keeps the theme's background (public/index.html) until the font is ready. */}
            {fontReady ? <Screens /> : null}
          </HouseholdLocale>
        </DataProvider>
      </MaskProvider>
    </ThemeProvider>
  )
}

// Signed out with no sample: Welcome. Signed in without a household: onboarding. Otherwise the tabs; delete-account and the dev pages stay open to all.
function Screens() {
  const { scheme, colors } = useTheme()
  const { owner, source } = useDataSource()
  const { phase } = useSnapshot()
  const open = gate({ owner, sample: source.kind === 'sample', phase })
  useNoteRoute()
  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        {/* Declared first, so a closed route falls back to Welcome, then onboarding. */}
        <Stack.Protected guard={open.welcome}>
          <Stack.Screen name="welcome" />
        </Stack.Protected>
        <Stack.Protected guard={open.onboarding}>
          <Stack.Screen name="onboarding" />
        </Stack.Protected>
        <Stack.Protected guard={open.app}>
          <Stack.Screen name="(tabs)" />
          {SHEET_ROUTES.map((name) => (
            <Stack.Screen key={name} name={name} options={{ presentation: 'transparentModal', animation: 'none', contentStyle: { backgroundColor: 'transparent' } }} />
          ))}
          {PAGE_ROUTES.map((name) => (
            <Stack.Screen key={name} name={name} />
          ))}
        </Stack.Protected>
      </Stack>
    </>
  )
}
