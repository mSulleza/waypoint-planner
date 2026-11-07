import { lazy, Suspense } from 'react'

// Development only: the samples load apart, so a production build ships neither them nor intl-samples.
const FormatSamples = __DEV__ ? lazy(() => import('@/dev/FormatSamples')) : () => null

export default function FormatRoute() {
  if (!__DEV__) return null
  return (
    <Suspense fallback={null}>
      <FormatSamples />
    </Suspense>
  )
}
