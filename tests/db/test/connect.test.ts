import { createClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_PUBLISHABLE_KEY

describe.skipIf(!url || !key)('local database', () => {
  it('answers the auth health check', async () => {
    const db = createClient(url!, key!, { db: { schema: 'waypoint' } })
    const { error } = await db.auth.getSession()
    expect(error).toBeNull()
  })
})
