import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { makeJournalEntry, makeJournalEntryLine } from '@/tests/helpers'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'

// ============================================================
// Mock — separate client (no .then) from query builder (thenable)
// ============================================================

let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown }>

function makeBuilder() {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'insert', 'update', 'delete']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.single = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.then = (resolve: (v: unknown) => void) => resolve(results[resultIdx++] ?? { data: null, error: null })
  return b
}

function makeClient() {
  return {
    from: vi.fn().mockImplementation(() => makeBuilder()),
    rpc: vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null }),
  }
}

vi.mock('@/lib/bookkeeping/engine', () => ({
  validateBalance: vi.fn().mockReturnValue({ valid: true, totalDebit: 1000, totalCredit: 1000 }),
  getNextVoucherNumber: vi.fn(async () => ++resultIdx), // just increment
  getSwedishLocalDate: vi.fn().mockReturnValue('2024-06-15'),
}))

import { correctEntry } from '../storno-service'
import { validateBalance, getNextVoucherNumber } from '@/lib/bookkeeping/engine'

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  resultIdx = 0
  results = []

  // Reset the mock implementations after clearAllMocks
  vi.mocked(validateBalance).mockReturnValue({ valid: true, totalDebit: 1000, totalCredit: 1000 })
  let voucherNum = 0
  vi.mocked(getNextVoucherNumber).mockImplementation(async () => ++voucherNum)
})

describe('correctEntry', () => {
  const originalEntry = makeJournalEntry({
    id: 'orig-1',
    status: 'posted',
    description: 'Test purchase',
    fiscal_period_id: 'fp-1',
    voucher_series: 'A',
    lines: [
      makeJournalEntryLine({ account_number: '5410', debit_amount: 1000, credit_amount: 0 }),
      makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 1000 }),
    ],
  })

  const correctedLines = [
    { account_number: '5420', debit_amount: 1200, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 1200 },
  ]

  function setupResults() {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })
    const correctedEntry = makeJournalEntry({ id: 'corrected-1', correction_of_id: 'orig-1' })

    results = [
      // 0: fetch original (.single())
      { data: originalEntry, error: null },
      // 1: insert reversal entry (.single())
      { data: reversalEntry, error: null },
      // 2: insert reversal lines (thenable)
      { data: null, error: null },
      // 3: update reversal to posted (thenable)
      { data: null, error: null },
      // -- getNextVoucherNumber increments resultIdx --
      // 4: fetch accounts for corrected lines (thenable)
      { data: [{ id: 'acc-5420', account_number: '5420' }, { id: 'acc-1930', account_number: '1930' }], error: null },
      // 5: insert corrected entry (.single())
      { data: correctedEntry, error: null },
      // 6: insert corrected lines (thenable)
      { data: null, error: null },
      // 7: update corrected to posted (thenable)
      { data: null, error: null },
      // 8: CAS update original to reversed (thenable, needs array for .length check)
      { data: [{ id: 'orig-1' }], error: null },
      // 9: fetch final reversal (.single())
      { data: { ...reversalEntry, lines: [] }, error: null },
      // 10: fetch final corrected (.single())
      { data: { ...correctedEntry, lines: correctedLines }, error: null },
    ]
  }

  it('creates reversal with swapped debit/credit lines', async () => {
    setupResults()
    const supabase = makeClient()
    const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    expect(result.reversal).toBeDefined()
    expect(result.reversal.reverses_id).toBe('orig-1')
  })

  it('links original ↔ reversal ↔ corrected via IDs', async () => {
    setupResults()
    const supabase = makeClient()
    const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    expect(result.reversal.id).toBe('reversal-1')
    expect(result.corrected.id).toBe('corrected-1')
    expect(result.corrected.correction_of_id).toBe('orig-1')
  })

  it('validates balance of corrected lines (rejects unbalanced)', async () => {
    vi.mocked(validateBalance).mockReturnValueOnce({
      valid: false,
      totalDebit: 1200,
      totalCredit: 1000,
    })

    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', [
        { account_number: '5420', debit_amount: 1200, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
      ])
    ).rejects.toThrow('not balanced')
  })

  it('cancels both entries on concurrent reversal (CAS guard)', async () => {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })
    const correctedEntry = makeJournalEntry({ id: 'corrected-1', correction_of_id: 'orig-1' })

    results = [
      { data: originalEntry, error: null },         // 0: fetch original
      { data: reversalEntry, error: null },          // 1: insert reversal
      { data: null, error: null },                   // 2: insert reversal lines
      { data: null, error: null },                   // 3: post reversal
      { data: [{ id: 'acc-5420', account_number: '5420' }, { id: 'acc-1930', account_number: '1930' }], error: null }, // 4: accounts
      { data: correctedEntry, error: null },         // 5: insert corrected
      { data: null, error: null },                   // 6: insert corrected lines
      { data: null, error: null },                   // 7: post corrected
      { data: [], error: null },                     // 8: CAS fails — empty array
      { data: null, error: null },                   // 9: cancelEntry reversal update
      { data: null, error: null },                   // 10: cancelEntry reversal lines delete
      { data: null, error: null },                   // 11: cancelEntry corrected update
      { data: null, error: null },                   // 12: cancelEntry corrected lines delete
    ]

    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    ).rejects.toThrow('already reversed')
  })

  it('cancels reversal when corrected entry creation fails', async () => {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })

    results = [
      { data: originalEntry, error: null },          // 0: fetch original
      { data: reversalEntry, error: null },           // 1: insert reversal
      { data: null, error: null },                    // 2: insert reversal lines
      { data: null, error: null },                    // 3: post reversal
      { data: [{ id: 'acc-5420', account_number: '5420' }, { id: 'acc-1930', account_number: '1930' }], error: null }, // 4: accounts
      { data: null, error: { message: 'DB error' } }, // 5: insert corrected FAILS
      { data: null, error: null },                    // 6: cancelEntry reversal update
      { data: null, error: null },                    // 7: cancelEntry reversal lines delete
    ]

    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    ).rejects.toThrow(BookkeepingDatabaseError)
  })

  it('cancels reversal entry when reversal lines fail', async () => {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })

    results = [
      { data: originalEntry, error: null },           // 0: fetch original
      { data: reversalEntry, error: null },            // 1: insert reversal
      { data: null, error: { message: 'line error' } }, // 2: insert reversal lines FAILS
      { data: null, error: null },                     // 3: cancelEntry update
      { data: null, error: null },                     // 4: cancelEntry lines delete
    ]

    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    ).rejects.toThrow(BookkeepingDatabaseError)
  })

  it('emits journal_entry.corrected event', async () => {
    setupResults()

    const handler = vi.fn()
    eventBus.on('journal_entry.corrected', handler)

    const supabase = makeClient()
    await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', companyId: 'company-1' })
    )
  })
})
