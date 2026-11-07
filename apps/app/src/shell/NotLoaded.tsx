import { Banner } from '@/ui/Banner'

// A part whose code did not arrive: a failed read shows Retry (spec §7), never a blank.
export function NotLoaded({ what, retry }: { what: string; retry: () => void }) {
  return <Banner tone="negative" title="Not loaded" body={`${what} could not load. Check the connection, then try again.`} action={{ label: 'Retry', icon: 'rotate-cw', onPress: retry }} />
}
