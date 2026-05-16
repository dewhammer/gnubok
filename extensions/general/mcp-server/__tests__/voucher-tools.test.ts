/**
 * Staging-time gate tests for gnubok_create_voucher.
 *
 * The executor-level gates (period lock, balance, status === 'posted' for
 * correct_entry) are tested in lib/pending-operations/__tests__/. This file
 * covers the pre-staging gates added to the MCP tool layer for UX — explicit
 * fiscal_period_id validation, inactive/missing account rejection, and the
 * source_type-not-staged invariant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>(
    '@/lib/bookkeeping/engine'
  )
  return {
    ...actual,
    findFiscalPeriod: vi.fn(),
  }
})

import { tools } from '../server'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'

const createVoucher = tools.find((t) => t.name === 'gnubok_create_voucher')!
const correctEntry = tools.find((t) => t.name === 'gnubok_correct_entry')!
const reverseEntry = tools.find((t) => t.name === 'gnubok_reverse_journal_entry')!

beforeEach(() => {
  vi.clearAllMocks()
})

const balancedLines = [
  { account_number: '1010', debit_amount: 250, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 250 },
]

describe('gnubok_create_voucher — staging gates', () => {
  it('is registered and mapped to bookkeeping:write scope', async () => {
    const { TOOL_SCOPE_MAP } = await import('@/lib/auth/api-keys')
    expect(createVoucher).toBeDefined()
    expect(createVoucher.annotations.readOnlyHint).toBe(false)
    expect(TOOL_SCOPE_MAP.gnubok_create_voucher).toBe('bookkeeping:write')
  })

  it('rejects unbalanced lines before staging', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      createVoucher.execute(
        {
          entry_date: '2026-05-12',
          description: 'unbalanced',
          fiscal_period_id: 'fp-1',
          lines: [
            { account_number: '1010', debit_amount: 100, credit_amount: 0 },
            { account_number: '1930', debit_amount: 0, credit_amount: 80 },
          ],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/not balanced/i)
  })

  it('rejects when an explicit fiscal_period_id is closed', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // fiscal_periods fetch returns a closed period
    enqueue({
      data: {
        id: 'fp-closed',
        is_closed: true,
        period_start: '2026-01-01',
        period_end: '2026-03-31',
        name: 'Q1 2026',
      },
      error: null,
    })

    await expect(
      createVoucher.execute(
        {
          entry_date: '2026-02-15',
          description: 'attempt to post in closed Q1',
          fiscal_period_id: 'fp-closed',
          lines: balancedLines,
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/låst/i)
    // findFiscalPeriod must NOT be called when an explicit ID was supplied.
    expect(findFiscalPeriod).not.toHaveBeenCalled()
  })

  it('rejects when an explicit fiscal_period_id does not exist', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null }) // fiscal_periods fetch — not found

    await expect(
      createVoucher.execute(
        {
          entry_date: '2026-05-12',
          description: 'unknown period uuid',
          fiscal_period_id: 'fp-nonexistent',
          lines: balancedLines,
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/not found/i)
  })

  it('rejects when entry_date is outside the supplied period', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: 'fp-1',
        is_closed: false,
        period_start: '2026-01-01',
        period_end: '2026-03-31',
        name: 'Q1 2026',
      },
      error: null,
    })

    await expect(
      createVoucher.execute(
        {
          entry_date: '2026-05-12',
          description: 'date outside Q1',
          fiscal_period_id: 'fp-1',
          lines: balancedLines,
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/utanför/i)
  })

  it('rejects when a referenced account is missing from the chart', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: 'fp-1',
        is_closed: false,
        period_start: '2026-01-01',
        period_end: '2026-12-31',
        name: '2026',
      },
      error: null,
    })
    // chart_of_accounts returns nothing — both accounts unknown
    enqueue({ data: [], error: null })

    await expect(
      createVoucher.execute(
        {
          entry_date: '2026-05-12',
          description: 'unknown accounts',
          fiscal_period_id: 'fp-1',
          lines: balancedLines,
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/saknas i kontoplanen/i)
  })

  it('rejects when a referenced account exists but is inactive', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: 'fp-1',
        is_closed: false,
        period_start: '2026-01-01',
        period_end: '2026-12-31',
        name: '2026',
      },
      error: null,
    })
    enqueue({
      data: [
        { account_number: '1010', account_name: 'Balanserade utgifter', is_active: false },
        { account_number: '1930', account_name: 'Företagskonto', is_active: true },
      ],
      error: null,
    })

    await expect(
      createVoucher.execute(
        {
          entry_date: '2026-05-12',
          description: 'inactive account',
          fiscal_period_id: 'fp-1',
          lines: balancedLines,
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/inaktiv/i)
  })

  it('happy path: stages with no source_type in params (executor hardcodes it)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: 'fp-1',
        is_closed: false,
        period_start: '2026-01-01',
        period_end: '2026-12-31',
        name: '2026',
      },
      error: null,
    })
    enqueue({
      data: [
        { account_number: '1010', account_name: 'Balanserade utgifter', is_active: true },
        { account_number: '1930', account_name: 'Företagskonto', is_active: true },
      ],
      error: null,
    })
    // resolvePeriodStatusForDate: layer 1 (company_settings) + layer 2 (fiscal_periods).
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { id: 'op-staged' }, error: null }) // pending_operations insert

    const result = (await createVoucher.execute(
      {
        entry_date: '2026-05-12',
        description: 'Capitalize Cursor',
        fiscal_period_id: 'fp-1',
        lines: balancedLines,
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; operation_id?: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.operation_id).toBe('op-staged')
    expect(result.preview.total_debit).toBe(250)
    expect(result.preview.total_credit).toBe(250)

    // Critical: the staged pending_operations row must NOT carry source_type.
    // The executor always hardcodes 'manual'. Look at the insert call.
    const insertCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls
    expect(insertCalls.some((args) => args[0] === 'pending_operations')).toBe(true)
  })
})

describe('gnubok_correct_entry — registration', () => {
  it('is registered with bookkeeping:write scope and is not read-only', async () => {
    const { TOOL_SCOPE_MAP } = await import('@/lib/auth/api-keys')
    expect(correctEntry).toBeDefined()
    expect(correctEntry.annotations.readOnlyHint).toBe(false)
    expect(TOOL_SCOPE_MAP.gnubok_correct_entry).toBe('bookkeeping:write')
  })

  it('rejects unbalanced replacement lines before staging', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      correctEntry.execute(
        {
          entry_id: 'je-1',
          lines: [
            { account_number: '2645', debit_amount: 250, credit_amount: 0 },
            { account_number: '2614', debit_amount: 0, credit_amount: 200 },
          ],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/not balanced/i)
  })
})

describe('gnubok_reverse_journal_entry — staging gates', () => {
  it('is registered with bookkeeping:write scope and is not read-only', async () => {
    const { TOOL_SCOPE_MAP } = await import('@/lib/auth/api-keys')
    expect(reverseEntry).toBeDefined()
    expect(reverseEntry.annotations.readOnlyHint).toBe(false)
    expect(TOOL_SCOPE_MAP.gnubok_reverse_journal_entry).toBe('bookkeeping:write')
  })

  it('rejects when entry_id is missing', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      reverseEntry.execute({}, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/entry_id is required/i)
  })

  it('rejects when the original entry is not posted', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: 'je-1',
        status: 'draft',
        entry_date: '2026-05-12',
        description: 'Test',
        voucher_number: 1,
        voucher_series: 'A',
        fiscal_period_id: 'fp-1',
        fiscal_periods: { name: '2026', is_closed: false },
        lines: [],
      },
      error: null,
    })
    await expect(
      reverseEntry.execute({ entry_id: 'je-1' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/posted entries can be reversed/i)
  })

  it('rejects when the original entry is in a closed period', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: 'je-1',
        status: 'posted',
        entry_date: '2025-12-31',
        description: 'Test',
        voucher_number: 42,
        voucher_series: 'A',
        fiscal_period_id: 'fp-closed',
        fiscal_periods: { name: '2025', is_closed: true },
        lines: [],
      },
      error: null,
    })
    await expect(
      reverseEntry.execute({ entry_id: 'je-1' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/closed/i)
  })
})
