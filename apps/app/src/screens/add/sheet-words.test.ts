import { abroad } from '@waypoint/core/fixtures'
import { describe, expect, it } from 'vitest'
import { sheetWords } from './sheet-words'

const doc = abroad('2026-10-16').doc

describe('Add sheet words', () => {
  it('carry the words the person tapped into the sheet: Record payment, Record transfer or Record an item', () => {
    expect(sheetWords(doc, { mode: 'move', to: 'rewards-card' })).toEqual({ title: 'Record payment to Rewards card', save: 'Save payment' })
    expect(sheetWords(doc, { mode: 'move', from: 'main', to: 'pesos' })).toEqual({ title: 'Record transfer', save: 'Save transfer' })
    expect(sheetWords(doc, { plan_item_id: 'mobile' })).toEqual({ title: 'Record Mobile plan', save: 'Save' })
  })

  it('keep Add for the + button, and for a move with no accounts named', () => {
    expect([sheetWords(doc, { mode: 'out' }), sheetWords(doc, { mode: 'move' }), sheetWords(doc, { mode: 'move', to: 'pesos' }), sheetWords(undefined, { mode: 'move', to: 'rewards-card' })]).toEqual([
      { title: 'Add', save: 'Save' },
      { title: 'Add', save: 'Save' },
      { title: 'Add', save: 'Save' },
      { title: 'Add', save: 'Save' },
    ])
  })
})
