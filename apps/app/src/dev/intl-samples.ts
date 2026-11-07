const CURRENCIES = ['EUR', 'PHP', 'USD', 'JPY', 'KWD'] as const
const LOCALES = ['en-PH', 'es-ES', 'en-US', 'ja-JP'] as const
const INSTANT = new Date('2026-10-07T22:30:00Z')

export interface IntlSamples {
  money: { locale: string; currency: string; formatted: string; compact: string; maxFractionDigits: number }[]
  deviceTimeZone: string
  manila: string
  madrid: string
}

export function intlSamples(): IntlSamples {
  const money = LOCALES.flatMap((locale) =>
    CURRENCIES.map((currency) => {
      const nf = new Intl.NumberFormat(locale, { style: 'currency', currency })
      return {
        locale,
        currency,
        formatted: nf.format(-1234567.891),
        compact: new Intl.NumberFormat(locale, { style: 'currency', currency, notation: 'compact' }).format(-1234567.891),
        maxFractionDigits: nf.resolvedOptions().maximumFractionDigits ?? -1,
      }
    }),
  )
  const at = (timeZone: string) =>
    new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(INSTANT)
  return { money, deviceTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, manila: at('Asia/Manila'), madrid: at('Europe/Madrid') }
}
