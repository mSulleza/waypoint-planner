import { SAMPLE_LIST } from '@waypoint/core/fixtures/sample-list'
import { useRouter } from 'expo-router'
import { View } from 'react-native'
import type { SnapshotState } from '@/data/hooks'
import { useDataSource } from '@/data/source'
import { Banner } from '@/ui/Banner'
import { Card } from '@/ui/Card'
import { Row } from '@/ui/Row'
import { SPACE } from '@/ui/tokens'

// The data layer's notices as banners at the top of a screen, above the figures they qualify.
export function Notices({ state }: { state: SnapshotState }) {
  const { exitSample } = useDataSource()
  const router = useRouter()
  if (state.notices.length === 0) return null
  return (
    <View style={{ gap: SPACE[2] }}>
      {state.notices.map((n) => {
        const action =
          n.action === 'retry'
            ? { label: 'Retry', icon: 'rotate-cw' as const, onPress: state.refetch }
            : n.action === 'sign_in'
              ? { label: 'Sign in', onPress: () => router.replace('/welcome') }
              : n.action === 'leave_sample'
                ? { label: 'Exit', onPress: exitSample }
                : undefined
        return (
          <View key={n.id} style={{ gap: SPACE[2] }}>
            <Banner tone={n.tone} title={n.title} body={n.body} detail={n.detail} action={action} />
            {n.action === 'samples' ? (
              <Card flush>
                {SAMPLE_LIST.map((s, i) => (
                  <Row key={s.id} divider={i > 0} title={s.title} onPress={() => router.setParams({ sample: s.id })} />
                ))}
              </Card>
            ) : null}
          </View>
        )
      })}
    </View>
  )
}
