// Every display threshold, each beside the word it shows: they decide only which word a figure reads, and no engine module imports them.
export const THRESHOLDS = Object.freeze({
  // Days 1 to 7 flag only when spent > budget × (day + 7) ÷ days in month, so one weekly shop does not.
  first_week: Object.freeze({ days: 7, word: 'Spending fast', otherwise: 'On pace' }),
  // From day 8, spent ÷ days elapsed > pace × budget ÷ days in month; 1.1 is an estimate.
  spending_fast: Object.freeze({ pace: 1.1, word: 'Spending fast', otherwise: 'On pace' }),
  // A week flags when spent > the lesser of its budget and its pattern's plan by today plus one usual day, the median of 3 or more days with spending.
  week_pace: Object.freeze({ usual_from_days: 3, word: 'Spending fast', otherwise: 'On pace' }),
  // Modelled interest further from the printed figure than this share of it.
  interest_variance: Object.freeze({ share: 0.1, word: 'Interest differs', otherwise: 'Interest matches' }),
} as const)

export type BudgetWord = (typeof THRESHOLDS)['spending_fast']['word'] | (typeof THRESHOLDS)['spending_fast']['otherwise']
