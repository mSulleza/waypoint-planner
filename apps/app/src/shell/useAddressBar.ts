import { usePathname } from 'expo-router'
import { useEffect, useRef } from 'react'
import { Platform } from 'react-native'

// Only the first screen after a page load checks; later moves keep the address bar right themselves.
let checked = false

// On a first load the gate may draw an open route in place of a closed one, and the router then writes the asked-for address; this puts the drawn route back.
export function useAddressBar() {
  const drawn = useRef(usePathname())
  useEffect(() => {
    if (Platform.OS !== 'web' || checked) return
    // Claimed when the timer runs, so a development double mount still checks once.
    const timer = setTimeout(() => {
      if (checked) return
      checked = true
      if (globalThis.location.pathname !== drawn.current) globalThis.history.replaceState(globalThis.history.state, '', drawn.current)
    }, 0)
    return () => clearTimeout(timer)
  }, [])
}
