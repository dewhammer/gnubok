import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

// Covers enforce_first_of_month_for_subsequent_periods (migration
// 20260418120000). The trigger only blocks mid-month period_start when a
// strictly earlier period exists — so importing a company's chronologically
// first fiscal year (förlängt första räkenskapsår) via SIE must succeed even
// after a later period was created during onboarding.
describe('fiscal_periods: subsequent-period start-day trigger', () => {
  async function insertPeriod(
    companyId: string,
    name: string,
    periodStart: string,
    periodEnd: string,
  ) {
    return getPool().query(
      `INSERT INTO public.fiscal_periods
         (company_id, name, period_start, period_end, is_closed, opening_balances_set)
       VALUES ($1, $2, $3, $4, false, false)
       RETURNING id`,
      [companyId, name, periodStart, periodEnd],
    )
  }

  it('allows a mid-month start when no earlier period exists', async () => {
    const { companyId } = await seedCompany()

    const { rows } = await insertPeriod(
      companyId,
      'Räkenskapsår 2025',
      '2025-06-15',
      '2026-06-30',
    )
    expect(rows[0]!.id).toBeTruthy()
  })

  it('allows importing an earlier mid-month period after a later day-1 period exists', async () => {
    const { companyId } = await seedCompany()

    // Onboarding-created period (day 1, year N).
    await insertPeriod(companyId, 'Räkenskapsår 2025', '2025-01-01', '2025-12-31')

    // SIE import of förlängt första räkenskapsår — earlier in time,
    // mid-month start. This used to fail with the old trigger.
    const { rows } = await insertPeriod(
      companyId,
      'Räkenskapsår 2023/2024',
      '2023-06-15',
      '2024-12-31',
    )
    expect(rows[0]!.id).toBeTruthy()
  })

  it('still rejects mid-month start when a strictly earlier period already exists', async () => {
    const { companyId } = await seedCompany()

    await insertPeriod(companyId, 'Räkenskapsår 2024', '2024-01-01', '2024-12-31')

    await expect(
      insertPeriod(companyId, 'Räkenskapsår 2025 (bad)', '2025-06-15', '2026-06-30'),
    ).rejects.toThrow(/Non-first fiscal period must start on the 1st of a month/)
  })
})
