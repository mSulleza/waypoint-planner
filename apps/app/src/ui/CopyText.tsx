import type { Copy, CopyPart } from '@waypoint/core'
import { useCallback } from 'react'
import { StyleSheet } from 'react-native'
import { useSnapshot } from '@/data/hooks'
import { shortDay } from '@/data/status'
import { monthTitle, shortMonth } from '@/shell/url.model'
import { Money } from './Money'
import { Text, type TextProps } from './Text'
import { useLocale } from './theme'
import { useMaskText } from './useMaskText'

// Every part of core copy but money as words: the household's own names, and days and months in its locale; months in full unless asked short.
export function useCopyWords(months: 'long' | 'short' = 'long'): (part: Exclude<CopyPart, { money: unknown }>) => string {
  const doc = useSnapshot().snapshot?.doc
  const locale = useLocale()
  const text = useMaskText()
  return useCallback(
    (part) => {
      // A description from the bank can hold an amount.
      if ('text' in part) return text(part.text)
      if ('date' in part) return shortDay(part.date, locale)
      if ('month' in part) return months === 'short' ? shortMonth(part.month, locale) : monthTitle(part.month, locale)
      if ('account' in part) return doc?.accounts.find((a) => a.id === part.account)?.name ?? ''
      if ('item' in part) return doc?.plan_items.find((p) => p.id === part.item)?.name ?? ''
      return doc?.categories.find((c) => c.id === part.category)?.name ?? ''
    },
    [doc, locale, text, months],
  )
}

// Core copy (next action, alerts, review items) as one run of text, each amount through <Money> so the eye masks it.
export function CopyText({ copy, variant = 'body', tone = 'text', months, ...rest }: { copy: Copy; months?: 'long' | 'short' } & TextProps) {
  const words = useCopyWords(months)
  // An amount sets its own face, so it takes the line's weight explicitly.
  const weight = StyleSheet.flatten(rest.style)?.fontWeight
  return (
    <Text variant={variant} tone={tone} {...rest}>
      {copy.map((part, i) => ('money' in part ? <Money key={i} minor={part.money.minor} currency={part.money.currency} variant={variant} tone={tone} style={weight ? { fontWeight: weight } : undefined} /> : words(part)))}
    </Text>
  )
}
