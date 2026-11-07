// Money, the ledger and Reconcile load apart from the first screen (the web's 500 kB first-load budget), in one chunk with Months; tabs fetch it once they have drawn.
export const loadMoney = () => import('../tabs')
