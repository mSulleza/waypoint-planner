/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import { scaleMinor } from '../src/money'
import { cardPreset } from '../src/presets'
import { calibrate, INTEREST_TOLERANCE, worstMissByLag, type CalibrationFile } from './calibration-helpers'

// Runs only with WAYPOINT_PRIVATE_DIR set to the private directory that holds statements-calibration.json, so no printed figure enters the repo.
const dir = import.meta.env.WAYPOINT_PRIVATE_DIR as string | undefined
const file = dir ? ((await import(/* @vite-ignore */ `${dir}/statements-calibration.json`)).default as CalibrationFile) : null

describe.skipIf(file === null)('PH presets replay the printed statements', () => {
  for (const card of file?.cards ?? []) {
    const fits = calibrate(card)
    const tolerance = INTEREST_TOLERANCE[card.preset]
    const minimum = cardPreset(card.preset)?.rules.minimum

    describe(card.preset, () => {
      it('replays every printed statement and has a tolerance entry', () => {
        expect(fits.length).toBe(card.statements.length)
        expect(tolerance).not.toBeUndefined()
      })

      it("fits printed interest no worse at the preset's payment lag than at any other lag from 0 to 2", () => {
        const lags = worstMissByLag(card)
        const own = lags.find((l) => l.lag === cardPreset(card.preset)?.rules.interest.payment_effective_lag_days)
        expect(own).toBeDefined()
        expect(lags.filter((l) => l.worst < (own?.worst ?? 0))).toEqual([])
      })

      if (card.preset === 'PH-min-floor') {
        it('prints 3% of retail purchases plus installments, so the preset minimum on the whole total is never below it', () => {
          if (!minimum) throw new Error('PH-min-floor has no minimum rule')
          for (const f of fits) {
            expect(f.minimum.printed).toBe(scaleMinor(f.charges_minor, minimum.pct, minimum.rounding) + f.installments_minor)
            expect(f.minimum.preset).toBeGreaterThanOrEqual(f.minimum.printed)
          }
        })
      } else {
        it('gives every printed minimum to the minor unit', () => {
          expect(fits.map((f) => [f.cut_date, f.minimum.preset])).toEqual(fits.map((f) => [f.cut_date, f.minimum.printed]))
        })
      }

      if (typeof tolerance === 'number') {
        it('lists card rows that add up to every printed payments and credits', () => {
          expect(fits.map((f) => [f.cut_date, f.credits.listed])).toEqual(fits.map((f) => [f.cut_date, f.credits.printed]))
        })

        it('replays printed interest within its tolerance', () => {
          const misses = fits.map((f) => [f.cut_date, Math.abs(f.interest.printed - f.interest.modelled)] as const)
          expect(misses.filter(([, miss]) => miss > tolerance)).toEqual([])
        })
      }
    })
  }
})
