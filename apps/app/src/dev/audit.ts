export interface AuditResult {
  smallControls: string[]
  maskedDigits: string[]
}

const CONTROLS = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="radio"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

const DIGIT = /\p{Nd}/u
const SYMBOL_AMOUNT = /\p{Sc}\s?\p{Nd}|\p{Nd}\s?\p{Sc}/u
const CODE_AMOUNT = /\b([A-Z]{3})\s?\p{Nd}|\p{Nd}\s?([A-Z]{3})\b/gu

let currencyCodes: ReadonlySet<string> | null = null

export function knownCurrencies(): ReadonlySet<string> {
  currencyCodes ??= new Set(Intl.supportedValuesOf('currency'))
  return currencyCodes
}

// A digit beside a currency symbol or ISO code is an amount; dates and counts are not.
export function moneyLike(text: string, codes: ReadonlySet<string> = knownCurrencies()): boolean {
  if (SYMBOL_AMOUNT.test(text)) return true
  for (const m of text.matchAll(CODE_AMOUNT)) if (codes.has(m[1] ?? m[2] ?? '')) return true
  return false
}

export function undersized(width: number, height: number, min: number): boolean {
  return Math.round(width) < min || Math.round(height) < min
}

function shown(el: Element): boolean {
  const rect = el.getBoundingClientRect()
  // Zero-area nodes, such as react-native-web's dialog focus brackets, are not visible controls.
  if (rect.width === 0 || rect.height === 0) return false
  if (getComputedStyle(el).visibility === 'hidden') return false
  for (let node: Element | null = el; node; node = node.parentElement) if (getComputedStyle(node).opacity === '0') return false
  return true
}

function nameOf(el: Element): string {
  const label = el.getAttribute('aria-label') ?? (el instanceof HTMLInputElement ? el.placeholder : '') ?? ''
  return (label || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)
}

// The text an element draws itself, its text nodes joined: React renders <Text>€{value}</Text> as two text nodes.
export function ownText(el: { childNodes: ArrayLike<{ nodeType: number; nodeValue: string | null }> }): string {
  let text = ''
  for (const node of Array.from(el.childNodes)) if (node.nodeType === 3) text += node.nodeValue ?? ''
  return text
}

function textOf(el: Element): string {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el.textContent ?? '')
}

export function runAudit(doc: Document, minTarget: number): AuditResult {
  const smallControls: string[] = []
  for (const el of doc.querySelectorAll(CONTROLS)) {
    if (!shown(el)) continue
    const r = el.getBoundingClientRect()
    if (undersized(r.width, r.height, minTarget)) smallControls.push(`${el.getAttribute('role') ?? el.tagName.toLowerCase()} "${nameOf(el)}" ${Math.round(r.width)}x${Math.round(r.height)}`)
  }
  const maskedDigits: string[] = []
  for (const el of doc.querySelectorAll('[data-money]')) {
    const text = textOf(el)
    if (DIGIT.test(text) && shown(el)) maskedDigits.push(text.trim())
  }
  for (const el of doc.querySelectorAll('input, textarea')) {
    const text = textOf(el)
    if (!el.closest('[data-money]') && moneyLike(text) && shown(el)) maskedDigits.push(text.trim())
  }
  for (const el of doc.body.querySelectorAll('*')) {
    const text = ownText(el)
    if (text !== '' && !el.closest('[data-money]') && moneyLike(text) && shown(el)) maskedDigits.push(text.trim())
  }
  return { smallControls, maskedDigits }
}

// Development only, on the web: window.__waypointAudit() lists undersized controls and amount digits left visible.
export function installAudit(minTarget: number): void {
  ;(globalThis as { __waypointAudit?: () => AuditResult }).__waypointAudit = () => runAudit(document, minTarget)
}
