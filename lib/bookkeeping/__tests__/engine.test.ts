import { describe, it, expect, vi, beforeEach } from 'vitest'
import { validateBalance, getSwedishLocalDate, createDraftEntry, reverseEntry } from '../engine'
import { BookkeepingDatabaseError } from '../errors'
import type { CreateJournalEntryLineInput, JournalEntryStatus } from '@/types'

// Mock Supabase client for createDraftEntry/reverseEntry tests
function createMockChain(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: overrides.singleData ?? null, error: overrides.singleError ?? null }),
    eq: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
  }
  return chain
}

// Mock event bus
vi.mock('@/lib/events', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue([]) },
}))

describe('validateBalance', () => {
  it('balanced entry (debit == credit) → valid: true', () => {
    const lines: CreateJournalEntryLineInput[] = [
      { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
    ]

    const result = validateBalance(lines)
    expect(result.valid).toBe(true)
    expect(result.totalDebit).toBe(1000)
    expect(result.totalCredit).toBe(1000)
  })

  it('unbalanced entry → valid: false', () => {
    const lines: CreateJournalEntryLineInput[] = [
      { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 500 },
    ]

    const result = validateBalance(lines)
    expect(result.valid).toBe(false)
    expect(result.totalDebit).toBe(1000)
    expect(result.totalCredit).toBe(500)
  })

  it('zero amounts → valid: false (roundedDebit must be > 0)', () => {
    const lines: CreateJournalEntryLineInput[] = [
      { account_number: '1930', debit_amount: 0, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 0 },
    ]

    const result = validateBalance(lines)
    expect(result.valid).toBe(false)
    expect(result.totalDebit).toBe(0)
    expect(result.totalCredit).toBe(0)
  })

  it('floating point edge case (33.33 + 33.33 + 33.34) → valid: true', () => {
    const lines: CreateJournalEntryLineInput[] = [
      { account_number: '1930', debit_amount: 33.33, credit_amount: 0 },
      { account_number: '1930', debit_amount: 33.33, credit_amount: 0 },
      { account_number: '1930', debit_amount: 33.34, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 100 },
    ]

    const result = validateBalance(lines)
    expect(result.valid).toBe(true)
    expect(result.totalDebit).toBe(100)
    expect(result.totalCredit).toBe(100)
  })

  it('single line (only debit, no credit) → valid: false', () => {
    const lines: CreateJournalEntryLineInput[] = [
      { account_number: '1930', debit_amount: 500, credit_amount: 0 },
    ]

    const result = validateBalance(lines)
    expect(result.valid).toBe(false)
  })
})

describe('getSwedishLocalDate', () => {
  it('returns a date string in YYYY-MM-DD format', () => {
    const date = getSwedishLocalDate()
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('returns a valid date', () => {
    const date = getSwedishLocalDate()
    const parsed = new Date(date)
    expect(parsed.toString()).not.toBe('Invalid Date')
  })
})

describe('createDraftEntry — cancelled status on line-insert failure', () => {
  it('sets status to cancelled (not delete) when line insert fails', async () => {
    const updateMock = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) })

    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'fiscal_periods') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { name: 'FY 2024', period_start: '2024-01-01', period_end: '2024-12-31' },
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        if (table === 'journal_entries') {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'entry-1', user_id: 'user-1', status: 'draft' as JournalEntryStatus },
                  error: null,
                }),
              }),
            }),
            update: updateMock,
            delete: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
          }
        }
        if (table === 'journal_entry_lines') {
          return {
            insert: vi.fn().mockResolvedValue({ error: { message: 'Line insert failed' } }),
          }
        }
        if (table === 'chart_of_accounts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockReturnValue({
                  eq: vi.fn().mockResolvedValue({
                    data: [{ account_number: '1930', id: 'acc-1' }, { account_number: '3001', id: 'acc-2' }],
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        return createMockChain()
      }),
    }

    await expect(
      createDraftEntry(supabase as never, 'company-1', 'user-1', {
        fiscal_period_id: 'period-1',
        entry_date: '2024-01-01',
        description: 'Test',
        source_type: 'manual',
        lines: [
          { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
          { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
        ],
      })
    ).rejects.toThrow(BookkeepingDatabaseError)

    // Should call update with cancelled status, NOT delete
    expect(updateMock).toHaveBeenCalledWith({ status: 'cancelled' })
  })
})

describe('createDraftEntry — date/period cross-validation', () => {
  function buildSupabase(periodData: { name: string; period_start: string; period_end: string } | null) {
    return {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'fiscal_periods') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: periodData,
                    error: periodData ? null : { message: 'Not found' },
                  }),
                }),
              }),
            }),
          }
        }
        if (table === 'chart_of_accounts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockReturnValue({
                  eq: vi.fn().mockResolvedValue({
                    data: [{ account_number: '1930', id: 'acc-1' }, { account_number: '3001', id: 'acc-2' }],
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        if (table === 'journal_entries') {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'entry-1', status: 'draft' },
                  error: null,
                }),
              }),
            }),
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'entry-1', status: 'draft', lines: [] },
                  error: null,
                }),
              }),
            }),
          }
        }
        if (table === 'journal_entry_lines') {
          return {
            insert: vi.fn().mockResolvedValue({ error: null }),
          }
        }
        return createMockChain()
      }),
    }
  }

  const validLines = [
    { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
    { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
  ]

  it('rejects entry date before period start', async () => {
    const supabase = buildSupabase({
      name: 'FY 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })

    await expect(
      createDraftEntry(supabase as never, 'company-1', 'user-1', {
        fiscal_period_id: 'period-1',
        entry_date: '2024-12-15',
        description: 'Test',
        source_type: 'manual',
        lines: validLines,
      })
    ).rejects.toThrow('Entry date 2024-12-15 is outside fiscal period "FY 2025"')
  })

  it('rejects entry date after period end', async () => {
    const supabase = buildSupabase({
      name: 'FY 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })

    await expect(
      createDraftEntry(supabase as never, 'company-1', 'user-1', {
        fiscal_period_id: 'period-1',
        entry_date: '2026-01-15',
        description: 'Test',
        source_type: 'manual',
        lines: validLines,
      })
    ).rejects.toThrow('Entry date 2026-01-15 is outside fiscal period "FY 2025"')
  })

  it('accepts entry date within period', async () => {
    const supabase = buildSupabase({
      name: 'FY 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })

    const result = await createDraftEntry(supabase as never, 'company-1', 'user-1', {
      fiscal_period_id: 'period-1',
      entry_date: '2025-06-15',
      description: 'Test',
      source_type: 'manual',
      lines: validLines,
    })

    expect(result).toBeDefined()
    expect(result.id).toBe('entry-1')
  })

  it('accepts entry date on period start boundary', async () => {
    const supabase = buildSupabase({
      name: 'FY 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })

    const result = await createDraftEntry(supabase as never, 'company-1', 'user-1', {
      fiscal_period_id: 'period-1',
      entry_date: '2025-01-01',
      description: 'Test',
      source_type: 'manual',
      lines: validLines,
    })

    expect(result).toBeDefined()
  })

  it('accepts entry date on period end boundary', async () => {
    const supabase = buildSupabase({
      name: 'FY 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })

    const result = await createDraftEntry(supabase as never, 'company-1', 'user-1', {
      fiscal_period_id: 'period-1',
      entry_date: '2025-12-31',
      description: 'Test',
      source_type: 'manual',
      lines: validLines,
    })

    expect(result).toBeDefined()
  })

  it('throws when fiscal period not found', async () => {
    const supabase = buildSupabase(null)

    await expect(
      createDraftEntry(supabase as never, 'company-1', 'user-1', {
        fiscal_period_id: 'nonexistent',
        entry_date: '2025-06-15',
        description: 'Test',
        source_type: 'manual',
        lines: validLines,
      })
    ).rejects.toThrow('Fiscal period not found')
  })
})

describe('JournalEntryStatus type includes cancelled', () => {
  it('cancelled is a valid JournalEntryStatus value', () => {
    const status: JournalEntryStatus = 'cancelled'
    expect(['draft', 'posted', 'reversed', 'cancelled']).toContain(status)
  })
})
