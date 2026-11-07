// The Welcome samples by id and title only, so a screen can list them without loading their households.
export const SAMPLE_LIST = [
  { id: 'abroad', title: 'EUR income paying PHP debts' },
  { id: 'us-cards-car', title: 'USD with two cards and a car loan' },
  { id: 'mortgage', title: 'GBP with a mortgage' },
] as const

export type SampleId = (typeof SAMPLE_LIST)[number]['id']
