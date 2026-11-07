// The data source's decisions, kept apart from React and the router so tests can run them.

export interface SampleParam {
  // The ?sample= value last seen, so a param left in the URL after exitSample does not open the sample again.
  seen: string | null
  open: string | null
}

// A sample opens when ?sample=<id> appears or changes, and stays open on routes without it.
export function followSampleParam(state: SampleParam, asked: string | null): SampleParam {
  if (asked === state.seen) return state
  return { seen: asked, open: asked ?? state.open }
}

// Where a mount of the data layer starts: what the last mount left, read against the URL now, so the router remounting the app (a pasted link with a new #fragment) keeps a sample open.
export function resumeSampleParam(kept: SampleParam | null, asked: string | null): SampleParam {
  return kept ? followSampleParam(kept, asked) : { seen: asked, open: asked }
}

// The account an auth event leaves signed in, or undefined when it says nothing new: an offline start reports no session but keeps it.
export function ownerAfter(event: string, session: { user: { id: string } } | null): string | null | undefined {
  if (event === 'SIGNED_OUT') return null
  return session ? session.user.id : undefined
}
