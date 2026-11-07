import { usePathname, useRouter } from 'expo-router'
import { useSnapshot } from '@/data/hooks'
import { useDataSource } from '@/data/source'
import { gate, homeOf } from './gate.model'
import { followRoute, landedHere, NO_LANDING, parentOf, type Landing } from './shell.model'

let landing: Landing = NO_LANDING

// The root layout reports each route it draws, so a page knows whether the app opened on it.
export function useNoteRoute() {
  landing = followRoute(landing, usePathname())
}

// Back from a page: its list when a link opened the app on it, else the screen under it, else its list or a route the gate has open.
export function useBack(): () => void {
  const router = useRouter()
  const path = usePathname()
  const { owner, source } = useDataSource()
  const { phase } = useSnapshot()
  return () => {
    const parent = parentOf(path)
    if (parent && landedHere(landing, path)) router.dismissTo(parent)
    else if (router.canGoBack()) router.back()
    else router.replace(parent ?? homeOf(gate({ owner, sample: source.kind === 'sample', phase })))
  }
}
