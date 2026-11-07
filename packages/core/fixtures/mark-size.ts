import { lastDayOfMonth } from '../src/dates'
import { termsFromPreset } from '../src/presets'
import { abroad } from './abroad'
import { link, relativeTo, row, transfer, type AccountInput, type PlanItemInput, type Sample, type StatementInput, type TransactionInput } from './relative'

const TRANSACTIONS = 400
const MAIN_ROWS_THIS_MONTH = 92
const CARDS = ['rewards-card', 'shopping-card', 'travel-card', 'wallet-card'] as const
const BUDGETS = [
  { category: 'cat-transport', from: 'main', amount: 6000 },
  { category: 'cat-health', from: 'main', amount: 4000 },
  { category: 'cat-fun', from: 'wallet', amount: 5000 },
  { category: 'cat-personal', from: 'wallet', amount: 3000 },
  { category: 'cat-gifts', from: 'rewards-card', amount: 150000 },
  { category: 'cat-pets', from: 'pesos', amount: 200000 },
] as const

const pad = (n: number) => String(n).padStart(3, '0')
const pick = <T>(list: readonly T[], i: number): T => list[i % list.length] as T

// abroad grown to the size of a real household for the bench and perf runs; never offered as a sample.
export function markSize(asOf: string): Sample {
  const base = abroad(asOf)
  const { first, on, month } = relativeTo(asOf)
  const history = first(-6)
  const today = Number(asOf.slice(8))

  const accounts: AccountInput[] = [
    ...base.doc.accounts.map((a) => ({ ...a, opening_date: history })),
    {
      id: 'wallet',
      name: 'Wallet',
      kind: 'cash',
      currency: 'EUR',
      opening_balance_minor: 30000,
      opening_date: history,
      funded_from_account_id: 'main',
      floor_windows: [{ from_month: month(0), to_month: null, amount_minor: 5000 }],
      sort_order: 5,
    },
    {
      id: 'travel-card',
      name: 'Travel card',
      kind: 'credit_card',
      currency: 'PHP',
      opening_balance_minor: -2500000,
      opening_date: history,
      funded_from_account_id: 'pesos',
      terms: termsFromPreset('PH-round-off', { cut_day: 8, due: { days_after_cut: 21 }, due_roll: 'following' }),
      sort_order: 6,
    },
    {
      id: 'wallet-card',
      name: 'Wallet card',
      kind: 'credit_card',
      currency: 'PHP',
      opening_balance_minor: -1200000,
      opening_date: history,
      funded_from_account_id: 'pesos',
      terms: termsFromPreset('PH-min-floor', { cut_day: 12, due: { days_after_cut: 20 }, due_roll: 'preceding' }),
      sort_order: 7,
    },
  ]

  const categories = [
    ...base.doc.categories,
    { id: 'cat-fun', name: 'Fun' },
    { id: 'cat-gifts', name: 'Gifts' },
    { id: 'cat-health', name: 'Health' },
    { id: 'cat-personal', name: 'Personal care' },
    { id: 'cat-pets', name: 'Pets' },
    { id: 'cat-transport', name: 'Transport' },
  ]

  const items: PlanItemInput[] = [...base.doc.plan_items]
  for (let i = 0; i < 22; i++) {
    const start = -10 + (i % 12)
    const months = 3 + ((i * 5) % 22)
    items.push({ id: `installment-${pad(i)}`, kind: 'installment', name: `Installment ${i + 1}`, from_account_id: pick(CARDS, i), amount_minor: 50000 + ((i * 37) % 40) * 10000, starts_on: first(start), ends_on: first(start + months - 1) })
  }
  for (const b of BUDGETS) {
    const name = b.category.slice(4)
    items.push({ id: `budget-${name}-old`, kind: 'allowance', name: `Budget ${name}`, from_account_id: b.from, category_id: b.category, amount_minor: b.amount, starts_on: history, ends_on: lastDayOfMonth(first(-1)) })
    items.push({ id: `budget-${name}`, kind: 'allowance', name: `Budget ${name}`, from_account_id: b.from, category_id: b.category, amount_minor: b.amount + b.amount / 10, starts_on: first(0) })
  }
  for (let i = 0; i < 40; i++) {
    const day = 1 + ((i * 3) % 28)
    items.push({
      id: `peso-bill-${pad(i)}`,
      kind: 'bill',
      name: `Peso bill ${i + 1}`,
      from_account_id: 'pesos',
      amount_minor: 20000 + ((i * 13) % 14) * 10000,
      starts_on: on(-6, day),
      ends_on: i % 5 === 4 ? on(-1, day) : null,
      roll: i % 3 === 0 ? 'following' : 'none',
      confidence: i % 4 === 0 ? 'estimated' : 'committed',
    })
  }
  for (let i = 0; i < 20; i++) {
    items.push({ id: `euro-bill-${pad(i)}`, kind: 'bill', name: `Euro bill ${i + 1}`, from_account_id: i % 4 === 0 ? 'wallet' : 'main', amount_minor: 1000 + ((i * 7) % 9) * 1000, every: i % 6 === 0 ? 'year' : 'month', starts_on: on(i % 6 === 0 ? 1 : -2, 2 + i) })
  }
  for (let i = 0; i < 15; i++) {
    items.push({ id: `card-bill-${pad(i)}`, kind: 'bill', name: `Card bill ${i + 1}`, from_account_id: pick(CARDS, i), amount_minor: 10000 + ((i * 11) % 8) * 10000, starts_on: on(-3, 1 + ((i * 5) % 27)) })
  }
  for (let i = 0; i < 12; i++) {
    items.push({ id: `card-extra-${pad(i)}`, kind: 'transfer', name: `Extra to card ${(i % 4) + 1}`, to_account_id: pick(CARDS, i), amount_minor: 100000 + ((i * 3) % 5) * 50000, starts_on: on(Math.floor(i / 4), 10), ends_on: i % 4 === 3 ? null : on(Math.floor(i / 4) + 2, 10) })
  }
  items.push(
    { id: 'side-income', kind: 'income', name: 'Side income', to_account_id: 'main', amount_minor: 150000, starts_on: on(-6, 15) },
    { id: 'bonus', kind: 'income', name: 'Yearly bonus', to_account_id: 'main', amount_minor: 200000, every: 'year', starts_on: on(2, 20) },
    { id: 'upside-bike', kind: 'income', name: 'Sell the bike', to_account_id: 'main', amount_minor: 30000, every: 'once', starts_on: on(1, 5), confidence: 'upside' },
    { id: 'upside-phone', kind: 'income', name: 'Sell the old phone', to_account_id: 'pesos', amount_minor: 800000, every: 'once', starts_on: on(2, 5), confidence: 'upside' },
    { id: 'upside-console', kind: 'income', name: 'Sell the console', to_account_id: 'pesos', amount_minor: 1200000, every: 'once', starts_on: on(3, 5), confidence: 'upside' },
  )
  for (let i = 0; i < 5; i++) items.push({ id: `owed-${pad(i)}`, kind: 'income', name: `Money owed ${i + 1}`, to_account_id: 'pesos', amount_minor: 100000 * (i + 1), every: 'once', starts_on: on(i % 3, 6 + i * 4) })
  items.push(
    { id: 'to-wallet', kind: 'transfer', name: 'Cash for the wallet', from_account_id: 'main', to_account_id: 'wallet', amount_minor: 10000, starts_on: on(-6, 2) },
    { id: 'to-pesos', kind: 'transfer', name: 'Monthly pesos', from_account_id: 'main', to_account_id: 'pesos', amount_minor: 20000, starts_on: on(-6, 26) },
    { id: 'tax-extra', kind: 'transfer', name: 'Extra tax set-aside', from_account_id: 'main', to_account_id: 'tax', amount_minor: 5000, starts_on: on(-6, 28), ends_on: on(-1, 28) },
    { id: 'wallet-back', kind: 'transfer', name: 'Wallet back to Main', from_account_id: 'wallet', to_account_id: 'main', amount_minor: 5000, every: 'once', starts_on: on(1, 3) },
    { id: 'tax-refund', kind: 'transfer', name: 'Tax surplus back', from_account_id: 'tax', to_account_id: 'main', amount_minor: 20000, every: 'year', starts_on: on(4, 30) },
  )

  const statements: StatementInput[] = [
    ...base.doc.statements,
    { id: 'travel-last', account_id: 'travel-card', cut_date: on(-1, 8), due_date: on(-1, 29), total_due_minor: 2500000, minimum_due_minor: 87500 },
    { id: 'wallet-last', account_id: 'wallet-card', cut_date: on(-1, 12), due_date: on(0, 1), total_due_minor: 1200000, minimum_due_minor: 60000 },
  ]

  const rows: TransactionInput[] = [...base.doc.transactions]
  const mainNow = rows.filter((t) => t.account_id === 'main' && t.posted_on.startsWith(month(0))).length
  for (let k = 0; rows.length < base.doc.transactions.length + MAIN_ROWS_THIS_MONTH - mainNow; k++) {
    rows.push(row(`main-now-${pad(k)}`, 'main', on(0, 1 + (k % today)), -(500 + ((k * 37) % 30) * 100), 'expense', `Card spend ${k + 1}`, { category_id: pick(['cat-groceries', 'cat-transport', 'cat-dining', 'cat-health', null], k) }))
  }
  for (let i = 0; i < 10; i++) {
    for (const m of [-3, -2, -1]) {
      const day = 1 + ((i * 3) % 28)
      rows.push(row(`peso-bill-${pad(i)}-${m + 4}`, 'pesos', on(m, day), -(20000 + ((i * 13) % 14) * 10000), 'expense', `Peso bill ${i + 1}`, link(`peso-bill-${pad(i)}`, first(m))))
    }
  }
  for (let j = 0; rows.length < TRANSACTIONS; j++) {
    const cycle = Math.floor(j / 10)
    const [m, day, id, card] = [-6 + ((cycle + j) % 6), 1 + ((j * 7) % 28), `history-${pad(j)}`, pick(CARDS, cycle)]
    const pair = rows.length + 2 <= TRANSACTIONS
    switch (pair ? j % 10 : 0) {
      case 3:
        rows.push(row(id, 'main', on(m, day), 25000, 'income', 'Freelance'))
        break
      case 4:
        rows.push(row(id, 'wallet', on(m, day), -(300 + ((j * 13) % 17) * 100), 'expense', 'Cash spend', { category_id: 'cat-fun' }))
        break
      case 5:
        rows.push(row(id, 'pesos', on(m, day), -(10000 + ((j * 7) % 9) * 10000), 'expense', 'Peso spend'))
        break
      case 6:
        rows.push(row(id, card, on(m, day), -(20000 + ((j * 11) % 10) * 20000), 'expense', 'Card charge', { category_id: 'cat-home' }))
        break
      case 7:
        rows.push(...transfer(id, 'Top-up', ['main', on(m, day), 8000], ['pesos', on(m, day), 556000]))
        break
      case 8:
        rows.push(...transfer(id, 'Card payment', ['pesos', on(m, day), 150000], [card, on(m, day + 1), 150000]))
        break
      case 9:
        rows.push(...transfer(id, 'Cash for the wallet', ['main', on(m, day), 5000], ['wallet', on(m, day), 5000]))
        break
      default:
        rows.push(row(id, 'main', on(m, day), -(500 + ((j * 29) % 36) * 100), 'expense', 'Shopping', { category_id: pick(['cat-groceries', 'cat-dining', null], j) }))
    }
  }

  return { doc: { ...base.doc, accounts, categories, plan_items: items, statements, transactions: rows }, rates: base.rates }
}
