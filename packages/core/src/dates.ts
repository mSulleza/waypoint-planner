export type Roll = 'none' | 'following' | 'preceding'

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTH = /^(\d{4})-(\d{2})(?:-\d{2})?$/

const pad = (n: number, width = 2) => String(n).padStart(width, '0')
const format = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
const monthLength = (y: number, m: number) => (m === 2 ? (isLeap(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31)

function parts(day: string): [number, number, number] {
  const match = DAY.exec(day)
  const [y, m, d] = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0]
  if (!match || m < 1 || m > 12 || d < 1 || d > monthLength(y, m)) throw new RangeError(`Not a YYYY-MM-DD date: ${day}`)
  return [y, m, d]
}

function monthParts(dayOrMonth: string): [number, number] {
  const match = MONTH.exec(dayOrMonth)
  if (!match) throw new RangeError(`Not a YYYY-MM month or YYYY-MM-DD date: ${dayOrMonth}`)
  if (dayOrMonth.length > 7) parts(dayOrMonth)
  const [y, m] = [Number(match[1]), Number(match[2])]
  if (m < 1 || m > 12) throw new RangeError(`Not a YYYY-MM month: ${dayOrMonth}`)
  return [y, m]
}

// Days since 1970-01-01 in the proleptic Gregorian calendar (Howard Hinnant's algorithm), so no Date or time zone is involved.
function toEpochDay(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y
  const era = Math.floor(yy / 400)
  const yoe = yy - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468
}

function fromEpochDay(n: number): string {
  const z = n + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const m = mp < 10 ? mp + 3 : mp - 9
  return format(yoe + era * 400 + (m <= 2 ? 1 : 0), m, doy - Math.floor((153 * mp + 2) / 5) + 1)
}

function count(n: number): number {
  if (!Number.isSafeInteger(n)) throw new RangeError(`Not a whole count: ${n}`)
  return n
}

// The day number of a date already checked as YYYY-MM-DD, skipping the regex: for hot loops over snapshot and engine dates.
export function dayNumber(day: string): number {
  return toEpochDay(Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10)))
}

export function dayFromNumber(n: number): string {
  return fromEpochDay(count(n))
}

export function addDays(day: string, n: number): string {
  return fromEpochDay(toEpochDay(...parts(day)) + count(n))
}

// Whole days from `from` to `to`; negative when `to` is earlier.
export function daysBetween(from: string, to: string): number {
  return toEpochDay(...parts(to)) - toEpochDay(...parts(from))
}

export function addMonths(day: string, n: number): string {
  const [y, m, d] = parts(day)
  const index = y * 12 + (m - 1) + count(n)
  const [ny, nm] = [Math.floor(index / 12), (((index % 12) + 12) % 12) + 1]
  return format(ny, nm, Math.min(d, monthLength(ny, nm)))
}

export function daysInMonth(dayOrMonth: string): number {
  return monthLength(...monthParts(dayOrMonth))
}

// Day `day` in the month of `dayOrMonth`, clamped to the month end, as the database's make_date with least() does.
export function dayInMonth(dayOrMonth: string, day: number): string {
  return `${monthKey(dayOrMonth)}-${pad(Math.min(day, daysInMonth(dayOrMonth)))}`
}

export function firstOfMonth(dayOrMonth: string): string {
  const [y, m] = monthParts(dayOrMonth)
  return format(y, m, 1)
}

export function lastDayOfMonth(dayOrMonth: string): string {
  const [y, m] = monthParts(dayOrMonth)
  return format(y, m, monthLength(y, m))
}

export function monthKey(day: string): string {
  const [y, m] = monthParts(day)
  return `${pad(y, 4)}-${pad(m)}`
}

// 0 is Sunday; 1970-01-01 was a Thursday.
const weekday = (epochDay: number) => (((epochDay + 4) % 7) + 7) % 7

export function rollDayNumber(n: number, rule: Roll): number {
  const wd = weekday(n)
  if (rule === 'none' || (wd !== 0 && wd !== 6)) return n
  if (rule === 'following') return n + (wd === 6 ? 2 : 1)
  return n - (wd === 6 ? 1 : 2)
}

export function roll(day: string, rule: Roll): string {
  const n = toEpochDay(...parts(day))
  const rolled = rollDayNumber(n, rule)
  return rolled === n ? day : fromEpochDay(rolled)
}

const dayFormats = new Map<string, Intl.DateTimeFormat>()

export function todayIn(timeZone: string, instant: Date | number): string {
  let fmt = dayFormats.get(timeZone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: 'numeric', day: 'numeric' })
    dayFormats.set(timeZone, fmt)
  }
  const found = fmt.formatToParts(instant)
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(found.find((p) => p.type === type)?.value)
  return format(value('year'), value('month'), value('day'))
}
