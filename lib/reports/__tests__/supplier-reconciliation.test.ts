import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================
// Mock — sequential result queue
// ============================================================

let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown }>

function makeBuilder() {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.single = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.then = (resolve: (v: unknown) => void) => resolve(results[resultIdx++] ?? { data: null, error: null })
  return b
}

function makeClient() {
  return {
    from: vi.fn().mockImplementation(() => makeBuilder()),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

import { generateReconciliation } from '../supplier-reconciliation'

let supabase: ReturnType<typeof makeClient>

beforeEach(() => {
  vi.clearAllMocks()
  resultIdx = 0
  results = []
  supabase = makeClient()
})

describe('generateReconciliation', () => {
  it('returns reconciled when supplier total matches account 2440 balance', async () => {
    results = [
      // 0: supplier_invoices
      {
        data: [
          { remaining_amount: 5000 },
          { remaining_amount: 3000 },
        ],
        error: null,
      },
      // 1: journal_entry_lines for account 2440
      {
        data: [
          { debit_amount: 0, credit_amount: 10000, journal_entry_id: 'e1' },
          { debit_amount: 2000, credit_amount: 0, journal_entry_id: 'e2' },
        ],
        error: null,
      },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    // Supplier total: 5000 + 3000 = 8000
    expect(result.supplier_ledger_total).toBe(8000)
    // Account 2440 (credit-normal): credits - debits = 10000 - 2000 = 8000
    expect(result.account_2440_balance).toBe(8000)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('detects mismatch when difference != 0', async () => {
    results = [
      // 0: supplier_invoices — total 5000
      {
        data: [
          { remaining_amount: 5000 },
        ],
        error: null,
      },
      // 1: journal_entry_lines — balance 7000
      {
        data: [
          { debit_amount: 0, credit_amount: 7000, journal_entry_id: 'e1' },
        ],
        error: null,
      },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(5000)
    expect(result.account_2440_balance).toBe(7000)
    expect(result.difference).toBe(-2000)
    expect(result.is_reconciled).toBe(false)
  })

  it('returns reconciled when both are zero/empty', async () => {
    results = [
      { data: [], error: null },
      { data: [], error: null },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(0)
    expect(result.account_2440_balance).toBe(0)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('handles null invoice data gracefully', async () => {
    results = [
      { data: null, error: null },
      {
        data: [
          { debit_amount: 0, credit_amount: 3000, journal_entry_id: 'e1' },
        ],
        error: null,
      },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(0)
    expect(result.account_2440_balance).toBe(3000)
    expect(result.difference).toBe(-3000)
    expect(result.is_reconciled).toBe(false)
  })

  it('computes credit-normal balance for account 2440 (liability)', async () => {
    results = [
      { data: [], error: null },
      {
        data: [
          { debit_amount: 0, credit_amount: 15000, journal_entry_id: 'e1' },
          { debit_amount: 5000, credit_amount: 0, journal_entry_id: 'e2' },
          { debit_amount: 3000, credit_amount: 0, journal_entry_id: 'e3' },
        ],
        error: null,
      },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    // Balance = credits - debits = 15000 - 5000 - 3000 = 7000
    expect(result.account_2440_balance).toBe(7000)
  })

  it('converts foreign-currency remaining_amount to SEK before reconciliation', async () => {
    // Reproduces the production bug: 225 EUR + 1 000 SEK was reported as 1 225
    // against a 2440 balance of 3 475, flagging a false discrepancy.
    results = [
      // 0: supplier_invoices — 225 EUR at 11, plus 1 000 SEK
      {
        data: [
          { remaining_amount: 225, currency: 'EUR', exchange_rate: 11 },
          { remaining_amount: 1000, currency: 'SEK', exchange_rate: null },
        ],
        error: null,
      },
      // 1: 2440 balance = 3 475 SEK (matches converted ledger total)
      {
        data: [
          { debit_amount: 0, credit_amount: 3475, journal_entry_id: 'e1' },
        ],
        error: null,
      },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(3475)
    expect(result.account_2440_balance).toBe(3475)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
    expect(result.unconverted_fx_count).toBe(0)
  })

  it('excludes FX invoices without exchange_rate from the SEK total and counts them', async () => {
    // An FX invoice without an exchange rate cannot be converted to SEK; the
    // sum must not silently add raw foreign currency. The row is excluded and
    // counted, so the UI can warn that the reconciliation may be unreliable.
    results = [
      // 0: supplier_invoices — 100 EUR with no rate (excluded), 1 000 SEK control
      {
        data: [
          { remaining_amount: 100, currency: 'EUR', exchange_rate: null },
          { remaining_amount: 1000, currency: 'SEK', exchange_rate: null },
        ],
        error: null,
      },
      // 1: 2440 balance reflects only the SEK invoice
      {
        data: [
          { debit_amount: 0, credit_amount: 1000, journal_entry_id: 'e1' },
        ],
        error: null,
      },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.unconverted_fx_count).toBe(1)
    // EUR row excluded → ledger total is just the SEK 1 000
    expect(result.supplier_ledger_total).toBe(1000)
    expect(result.account_2440_balance).toBe(1000)
    // Numbers match, but the calculation is incomplete (a row was excluded);
    // BFL 5 kap requires the period not be stamped Avstämd until the missing
    // exchange rate is filled in.
    expect(result.is_reconciled).toBe(false)
  })

  it('uses Math.round for monetary precision', async () => {
    results = [
      {
        data: [
          { remaining_amount: 33.33 },
          { remaining_amount: 33.34 },
        ],
        error: null,
      },
      {
        data: [
          { debit_amount: 0, credit_amount: 66.67, journal_entry_id: 'e1' },
        ],
        error: null,
      },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(66.67)
    expect(result.account_2440_balance).toBe(66.67)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })
})
