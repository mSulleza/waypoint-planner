import { createClient } from '@supabase/supabase-js'

// supabase-js on the waypoint schema, where every Waypoint table and function lives (spec §14), with no saved session.
export const waypointClient = (url: string, key: string) => createClient(url, key, { db: { schema: 'waypoint' }, auth: { persistSession: false, autoRefreshToken: false } })

// Its type: the plain SupabaseClient type names public.
export type Db = ReturnType<typeof waypointClient>
