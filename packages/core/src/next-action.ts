import { moneyPart, textPart, type Copy, type Route, type Subject } from './copy'
import { addDays, monthKey } from './dates'
import { cardsOf } from './engine/cards'
import { debtFigures, type CardDebtFigures } from './engine/debt-figures'
import type { LineItem, Walk } from './engine/types'
import type { Money } from './money'
import type { ReviewItem } from './review'
import { snapshotIndex, type Snapshot } from './snapshot'

export type NextActionKind = 'send' | 'pay' | 'enter_statement' | 'review' | 'none'

// What the Add sheet opens with; an amount left null is typed by the person, such as what landed after a conversion.
export interface Prefill {
  from_account_id: string | null
  to_account_id: string
  sent: Money | null
  received: Money | null
}

export interface NextAction {
  kind: NextActionKind
  title: Copy
  context: Copy
  // null only for 'none'.
  subject: Subject | null
  route: Route
  prefill: Prefill | null
  review_id: string | null
  act_by: string | null
}

export interface NextActionInputs {
  snapshot: Snapshot
  walk: Walk
  review: readonly ReviewItem[]
}

export const NOTHING_TO_DO = 'Nothing to do now'

const frozen = (action: NextAction): NextAction => Object.freeze(action)

const enterTitle = (cardId: string): Copy => [textPart('Enter the '), { account: cardId }, textPart(' statement')]

// A due day as words: today or tomorrow by name, any other day as its date.
function dueWhen(due: string, asOf: string): Copy {
  if (due === asOf) return [textPart('today')]
  if (due === addDays(asOf, 1)) return [textPart('tomorrow')]
  return [{ date: due }]
}

// The one thing to do now (spec §7), the first of: today's top-up, a card payment overdue or due today, a statement to enter, the first review item, then the earliest top-up or card payment still to come this month. Every amount is the walk's or the payment figures', never sized here.
export function nextAction(inputs: NextActionInputs): NextAction {
  const { snapshot, walk, review } = inputs
  if (walk.as_of !== snapshot.as_of) throw new RangeError(`The walk is for ${walk.as_of}, not the snapshot's day ${snapshot.as_of}`)
  if (walk.mode !== 'full') throw new RangeError('The next action reads the walk lines; walk in full mode')
  if (review === undefined) throw new RangeError('The review list must load before the next action')
  const index = snapshotIndex(snapshot)
  const asOf = snapshot.as_of
  const month = monthKey(asOf)
  const currencyOf = (id: string) => index.accounts.get(id)?.currency ?? snapshot.doc.household.base_currency

  const topUps = new Map<string, LineItem>()
  for (const l of walk.lines) if (l.source === 'top_up' && l.flags.includes('to_send')) topUps.set(l.id, l)
  const sends = [...topUps.values()].filter((l) => l.amount_minor < 0)
  const landed = (out: LineItem): LineItem => {
    const into = out.pair_id === null ? undefined : topUps.get(out.pair_id)
    if (!into) throw new Error(`Top-up '${out.id}' has no landed leg`)
    return into
  }
  // A top-up's action on the day it is sent, with the next one this month on the same route as its later line.
  const sendAction = (out: LineItem): NextAction => {
    const target = landed(out).account_id
    const later = sends.find((l) => l.date > out.date && l.date.slice(0, 7) === month && l.account_id === out.account_id && landed(l).account_id === target)
    return frozen({
      kind: 'send',
      title: [textPart('Send '), moneyPart(0 - out.amount_minor, currencyOf(out.account_id)), textPart(' → '), { account: target }],
      context: later ? [textPart('and '), moneyPart(0 - later.amount_minor, currencyOf(later.account_id)), textPart(' more on '), { date: later.date }] : [],
      subject: { account_id: target, month },
      route: { tab: 'today', sheet: 'add', account_id: out.account_id },
      prefill: { from_account_id: out.account_id, to_account_id: target, sent: { minor: 0 - out.amount_minor, currency: currencyOf(out.account_id) }, received: null },
      review_id: null,
      act_by: out.date,
    })
  }
  const today = sends.find((l) => l.date === asOf)
  if (today) return sendAction(today)

  const replays = cardsOf(walk)
  const cards = replays === null ? [] : debtFigures(snapshot, walk).cards
  const dueDay = (c: CardDebtFigures) => replays?.get(c.account_id)?.statements.find((s) => s.id === c.statement_id)?.due_date ?? asOf
  const order = (c: CardDebtFigures) => index.accounts.get(c.account_id)?.sort_order ?? 0
  const payable = cards
    .filter((c) => c.payment !== null && c.payment.left_to_pay_minor > 0 && c.pay_on !== null && (c.pay_on <= asOf || dueDay(c) < asOf))
    .sort((a, b) => {
      const [lateA, lateB] = [dueDay(a) < asOf, dueDay(b) < asOf]
      if (lateA !== lateB) return lateA ? -1 : 1
      return (lateA ? (dueDay(a) < dueDay(b) ? -1 : dueDay(a) > dueDay(b) ? 1 : 0) : 0) || order(a) - order(b) || (a.account_id < b.account_id ? -1 : 1)
    })
  // A card payment: the statement to enter first when its cycle is provisional, else left to pay against the remaining due.
  const cardAction = (card: CardDebtFigures): NextAction => {
    const current = replays?.get(card.account_id)?.statements.find((s) => s.id === card.statement_id)
    if (!current) throw new Error(`The replay of '${card.account_id}' lost its statement '${card.statement_id}'`)
    if (current.provisional) {
      const reviewId = `statement_to_enter:${current.id}`
      return frozen({
        kind: 'enter_statement',
        title: enterTitle(card.account_id),
        context: [textPart('Its payment is due '), ...dueWhen(current.due_date, asOf), textPart('.')],
        subject: { review_id: reviewId },
        route: { tab: 'today', sheet: 'statement', account_id: card.account_id },
        prefill: null,
        review_id: reviewId,
        act_by: current.due_date,
      })
    }
    const left = card.payment?.left_to_pay_minor ?? 0
    const funder = index.accounts.get(card.account_id)?.funded_from_account_id ?? null
    const same = funder !== null && currencyOf(funder) === card.currency
    const amount = { minor: left, currency: card.currency }
    // Which amount is which: the plan's payment, then the statement's remaining due when it is more.
    const share: Copy = card.remaining_due_minor > left ? [textPart('The plan pays '), moneyPart(left, card.currency), textPart(' of the '), moneyPart(card.remaining_due_minor, card.currency), textPart(' due. ')] : []
    return frozen({
      kind: 'pay',
      title: [textPart('Pay '), moneyPart(left, card.currency), textPart(' → '), { account: card.account_id }],
      context: [...share, textPart(current.due_date < asOf ? 'It was due ' : 'It is due '), ...dueWhen(current.due_date, asOf), textPart('.')],
      subject: { account_id: card.account_id, month },
      route: { tab: 'today', sheet: 'add', account_id: card.account_id },
      prefill: { from_account_id: funder, to_account_id: card.account_id, sent: same ? amount : null, received: amount },
      review_id: null,
      act_by: current.due_date,
    })
  }
  const card = payable[0]
  if (card) return cardAction(card)

  const first = review.find((r) => r.kind === 'statement_to_enter') ?? review[0]
  if (first) {
    const statement = first.kind === 'statement_to_enter'
    return frozen({
      kind: statement ? 'enter_statement' : 'review',
      title: statement ? enterTitle(first.account_id) : [textPart(first.title)],
      context: first.body,
      subject: { review_id: first.id },
      route: statement ? { tab: 'today', sheet: 'statement', account_id: first.account_id } : first.route,
      prefill: null,
      review_id: first.id,
      act_by: first.act_by,
    })
  }

  // Nothing due now: the earliest top-up or card payment still to come this month, so it can be done early; a top-up comes before a payment it funds on the same day.
  const nextSend = sends.find((l) => l.date > asOf && l.date.slice(0, 7) === month)
  const nextCard = cards
    .filter((c) => c.payment !== null && c.payment.left_to_pay_minor > 0 && c.pay_on !== null && c.pay_on > asOf && c.pay_on.slice(0, 7) === month)
    .sort((a, b) => ((a.pay_on ?? '') < (b.pay_on ?? '') ? -1 : (a.pay_on ?? '') > (b.pay_on ?? '') ? 1 : 0) || order(a) - order(b) || (a.account_id < b.account_id ? -1 : 1))[0]
  if (nextSend && (!nextCard || nextSend.date <= (nextCard.pay_on ?? nextSend.date))) return sendAction(nextSend)
  if (nextCard) return cardAction(nextCard)

  // Reassurance only when this month's projection backs it: every cash account has a floor and stays at or above its target.
  const cash = snapshot.doc.accounts.filter((a) => a.kind === 'cash')
  const steady = cash.length > 0 && cash.every((a) => {
    const m = walk.figures.get(a.id)?.[0]
    return m !== undefined && m.floor_set && m.word === 'OK'
  })
  return frozen({
    kind: 'none',
    title: [textPart(NOTHING_TO_DO)],
    context: steady ? [textPart('Every account stays at or above its floor this month.')] : [],
    subject: null,
    route: { tab: 'today' },
    prefill: null,
    review_id: null,
    act_by: null,
  })
}
