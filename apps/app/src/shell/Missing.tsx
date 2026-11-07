import { useRouter, type Href } from 'expo-router'
import { EmptyState } from '@/ui/EmptyState'

// A link to a row this household does not have: say so, and offer the list it would be in.
export function Missing({ what, list, listTitle }: { what: string; list: Href; listTitle: string }) {
  const router = useRouter()
  return <EmptyState title={`No such ${what}`} body={`This household has no ${what} at this link.`} action={{ label: `Open ${listTitle}`, onPress: () => router.replace(list) }} />
}
