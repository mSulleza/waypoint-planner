import { InstrumentSans_400Regular } from '@expo-google-fonts/instrument-sans/400Regular'
import { InstrumentSans_500Medium } from '@expo-google-fonts/instrument-sans/500Medium'
import { InstrumentSans_600SemiBold } from '@expo-google-fonts/instrument-sans/600SemiBold'
import { InstrumentSans_700Bold } from '@expo-google-fonts/instrument-sans/700Bold'
import { loadAsync } from 'expo-font'
import { FONT_FAMILIES } from './tokens'

// Instrument Sans in the four weights the type roles use, each under its own family name; theme.tsx imports this lazily, so the loader stays out of the first script.
export function loadInstrumentSans(): Promise<void> {
  return loadAsync({
    [FONT_FAMILIES['400']]: InstrumentSans_400Regular,
    [FONT_FAMILIES['500']]: InstrumentSans_500Medium,
    [FONT_FAMILIES['600']]: InstrumentSans_600SemiBold,
    [FONT_FAMILIES['700']]: InstrumentSans_700Bold,
  })
}
