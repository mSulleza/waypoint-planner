import { abroad } from './abroad'
import { mortgage } from './mortgage'
import type { Sample } from './relative'
import { SAMPLE_LIST, type SampleId } from './sample-list'
import { usCardsCar } from './us-cards-car'

export interface SampleEntry {
  id: string
  title: string
  build: (asOf: string) => Sample
}

const BUILDS: Record<SampleId, (asOf: string) => Sample> = { abroad, 'us-cards-car': usCardsCar, mortgage }

// The read-only samples on Welcome, in SAMPLE_LIST order; markSize is for the bench and perf runs only.
export const SAMPLES: readonly SampleEntry[] = SAMPLE_LIST.map((s) => ({ ...s, build: BUILDS[s.id] }))
