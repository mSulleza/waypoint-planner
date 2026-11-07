import { planItemRow, statementRow } from '@waypoint/core'
import { describe, expect, it } from 'vitest'
import { allowedValues, issuesByField, plainIssue } from './useZodForm'

describe('useZodForm helpers', () => {
  it('lists the values an enum field allows, through its default', () => {
    expect(allowedValues(planItemRow, 'every')).toEqual(['once', 'week', '2weeks', 'month', 'quarter', 'year'])
    expect(allowedValues(planItemRow, 'roll')).toEqual(['none', 'following', 'preceding'])
    expect(allowedValues(planItemRow, 'confidence')).toEqual(['committed', 'estimated', 'upside'])
    expect(allowedValues(planItemRow, 'kind')).toEqual(['income', 'bill', 'allowance', 'transfer', 'installment'])
    // A field that is not an enum, and one the schema lacks, allow no listed values.
    expect(allowedValues(planItemRow, 'name')).toEqual([])
    expect(allowedValues(statementRow, 'nothing')).toEqual([])
  })

  it('puts the first issue of each field beside it, in a sentence that names other fields', () => {
    const parsed = planItemRow.safeParse({ id: 'x', kind: 'bill', name: '', from_account_id: 'main', amount_minor: 0, starts_on: '2026-10-07', ends_on: '2026-10-01' })
    if (parsed.success) throw new Error('the row should not pass')
    expect(issuesByField(parsed.error.issues, { starts_on: 'the first date' })).toEqual({
      name: 'Must not be empty.',
      amount_minor: 'Must be more than 0; only an allowance may be negative.',
      ends_on: 'Must not be before the first date.',
    })
    // An issue on the whole row goes to the field named for it.
    expect(issuesByField([{ path: [], message: 'something is off' }], {}, 'name')).toEqual({ name: 'Something is off.' })
    expect(plainIssue('already a sentence.')).toBe('Already a sentence.')
  })
})
