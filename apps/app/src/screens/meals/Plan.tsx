import type { Snapshot } from '@waypoint/core'
import { mealsIndex, type MealsDoc, type MealSettings } from '@waypoint/core/meals'
import type { PlanAnswer } from '@/ai/meals-plan'
import { useState } from 'react'
import { View } from 'react-native'
import { asDataError, ERROR_TITLES } from '@/data/errors'
import { randomId } from '@/data/uuid'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { Money, useMoneyText } from '@/ui/Money'
import { Pill } from '@/ui/Pill'
import { Row } from '@/ui/Row'
import { Segmented } from '@/ui/Segmented'
import { Sheet } from '@/ui/Sheet'
import { Text } from '@/ui/Text'
import { TextField } from '@/ui/TextField'
import { useLocale } from '@/ui/theme'
import { SPACE } from '@/ui/tokens'
import { askPlan, useMealEdit } from './data'
import { dayName, weekRange, weekView } from './meals.model'
import { STRONG } from './parts'
import { draftDoc, planEdits, recipeCosts, type PlanMode } from './plan.model'

// Plan this week: a note, DeepSeek's draft of the days, the draft priced by the app against the week's budget, and nothing saved until "Use this plan".
export function PlanSheet({ open, doc, settings, snapshot, start, onClose }: { open: boolean; doc: MealsDoc; settings: MealSettings; snapshot: Snapshot; start: string; onClose: () => void }) {
  const locale = useLocale()
  const money = useMoneyText()
  const edit = useMealEdit()
  const current = weekView(snapshot, doc, settings, start)
  const empty = current.days.filter((d) => !d.lunch && !d.dinner).length
  const [mode, setMode] = useState<PlanMode>(empty > 0 ? 'empty' : 'all')
  const [note, setNote] = useState('')
  const [draft, setDraft] = useState<PlanAnswer | null>(null)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const ask = async () => {
    setAsking(true)
    setError(null)
    setDraft(null)
    try {
      setDraft(await askPlan({ week: start, mode, note, budget_minor: current.budget?.budget_minor ?? null, currency: current.budget?.currency ?? settings.currency, costs: recipeCosts(doc) }))
    } catch (e) {
      setError(e)
    } finally {
      setAsking(false)
    }
  }
  const use = async () => {
    if (!draft) return
    try {
      for (const e of planEdits(doc, draft.plan, start, mode, randomId)) await edit.mutateAsync(e)
      setDraft(null)
      setNote('')
      onClose()
    } catch {
      // The banner says what went wrong.
    }
  }
  const failure = error ? asDataError(error) : edit.error ? asDataError(edit.error) : null
  const preview = draft ? weekView(snapshot, draftDoc(doc, draft.plan, start, mode), settings, start) : null
  const recipes = mealsIndex(doc).recipes
  const name = (id: string | null) => (id ? (recipes.get(id)?.name ?? 'A recipe') : null)
  return (
    <Sheet open={open} onClose={onClose} title={`Plan ${weekRange(start, locale)}`}>
      <View style={{ gap: SPACE[4] }}>
        <Segmented
          label="Plan"
          options={[
            { value: 'empty', label: `Empty days (${empty})` },
            { value: 'all', label: 'The whole week' },
          ]}
          value={mode}
          onChange={(m) => {
            setMode(m)
            setDraft(null)
          }}
        />
        <TextField label="Anything DeepSeek should know?" value={note} onChangeText={setNote} multiline numberOfLines={3} maxLength={500} placeholder="Chicken in the fridge; cook twice Sunday" />
        {draft ? (
          <Button label={asking ? 'Asking DeepSeek…' : 'Try again'} variant="secondary" disabled={asking} onPress={() => void ask()} />
        ) : (
          <Button label={asking ? 'Asking DeepSeek…' : 'Draft the week'} variant="primary" disabled={asking || (mode === 'empty' && empty === 0)} onPress={() => void ask()} />
        )}
        {failure ? <Banner tone="negative" title={ERROR_TITLES[failure.kind]} body={failure.message} detail={failure.technical ?? undefined} /> : null}
        {draft && preview ? (
          <View style={{ gap: SPACE[3] }}>
            {preview.budget ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: SPACE[2] }}>
                <Text variant="headline">The week&apos;s shopping</Text>
                <Money minor={preview.budget.cost_minor} currency={preview.budget.currency} variant="headline" style={STRONG} />
                <Text variant="footnote" tone="text2">
                  {'of '}
                  <Money minor={preview.budget.budget_minor} currency={preview.budget.currency} variant="footnote" tone="text2" />
                </Text>
                {preview.budget.over_minor > 0 ? (
                  <Pill tone="caution" icon="triangle-alert">
                    {`${money(preview.budget.over_minor, preview.budget.currency)} over`}
                  </Pill>
                ) : null}
              </View>
            ) : null}
            {draft.note ? <Text tone="text2">{draft.note}</Text> : null}
            <Card flush>
              {preview.days.map((d, i) => {
                const p = draft.plan.find((x) => x.day === d.day)
                const lunch = d.lunch?.recipe.name ?? 'nothing planned'
                const dinner = d.dinner === 'leftovers' ? 'lunch again' : (d.dinner?.recipe.name ?? 'nothing planned')
                return <Row key={d.day} divider={i > 0} title={dayName(d.day, locale)} detail={`${p ? 'New · ' : ''}Lunch: ${lunch} · Dinner: ${p ? (name(p.dinner_recipe_id) ?? (p.leftovers ? 'lunch again' : 'nothing planned')) : dinner}`} />
              })}
            </Card>
            {draft.plan.length === 0 ? <Text tone="text2">DeepSeek planned no days. Add to the note and try again.</Text> : null}
            <Button label={edit.isPending ? 'Saving…' : 'Use this plan'} variant="primary" disabled={edit.isPending || draft.plan.length === 0} onPress={() => void use()} />
            <Text variant="footnote" tone="text2">
              DeepSeek picks the recipes; Waypoint works out the shopping and the budget. {mode === 'all' ? 'The whole week is replaced, so days it leaves out are cleared.' : 'Days already planned stay as they are.'}
            </Text>
          </View>
        ) : null}
      </View>
    </Sheet>
  )
}
