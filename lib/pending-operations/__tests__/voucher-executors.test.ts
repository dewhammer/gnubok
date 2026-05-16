/**
 * Unit tests for commitCreateVoucher and commitCorrectEntry executors.
 * The executors aren't exported individually, so we drive them through the
 * public `commitPendingOperation` dispatcher.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase, makeJournalEntry } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>(
    '@/lib/bookkeeping/engine'
  )
  return {
    ...actual,
    createJournalEntry: vi.fn(),
    findFiscalPeriod: vi.fn(),
    reverseEntry: vi.fn(),
  }
})

vi.mock('@/lib/core/bookkeeping/storno-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/core/bookkeeping/storno-service')>(
    '@/lib/core/bookkeeping/storno-service'
  )
  return {
    ...actual,
    correctEntry: vi.fn(),
  }
})

import { commitPendingOperation } from '../commit'
import { createJournalEntry, findFiscalPeriod, reverseEntry } from '@/lib/bookkeeping/engine'
import { correctEntry } from '@/lib/core/bookkeeping/storno-service'

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'create_voucher',
    status: 'pending',
    title: 'test',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'high',
    created_at: '2026-05-12T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-05-12T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

// ─── create_voucher ─────────────────────────────────────────────────

describe('commitPendingOperation: create_voucher', () => {
  it('happy path: posts a balanced entry with the provided fiscal_period_id', async () => {
    vi.mocked(createJournalEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-100', voucher_number: 42, voucher_series: 'A' })
    )

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      params: {
        entry_date: '2026-05-12',
        description: 'Capitalize Cursor subscription to 1010',
        fiscal_period_id: 'fp-1',
        lines: [
          { account_number: '1010', debit_amount: 250, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 250 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      journal_entry_id: 'je-100',
      voucher_number: 42,
      voucher_series: 'A',
      fiscal_period_id: 'fp-1',
    })
    expect(createJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({
        fiscal_period_id: 'fp-1',
        entry_date: '2026-05-12',
        description: 'Capitalize Cursor subscription to 1010',
        source_type: 'manual',
      }),
      'mcp_create_voucher'
    )
    // findFiscalPeriod must NOT be called when fiscal_period_id is supplied —
    // it's the caller's explicit choice.
    expect(findFiscalPeriod).not.toHaveBeenCalled()
  })

  it('resolves fiscal_period from entry_date when omitted', async () => {
    vi.mocked(findFiscalPeriod).mockResolvedValueOnce('fp-resolved')
    vi.mocked(createJournalEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-101', voucher_number: 7 })
    )

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      params: {
        entry_date: '2026-05-12',
        description: 'no fiscal_period_id',
        lines: [
          { account_number: '5410', debit_amount: 100, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 100 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ fiscal_period_id: 'fp-resolved' })
    expect(findFiscalPeriod).toHaveBeenCalledWith(expect.anything(), 'company-1', '2026-05-12')
  })

  it('returns 400 in Swedish when no fiscal period covers the date', async () => {
    vi.mocked(findFiscalPeriod).mockResolvedValueOnce(null)

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      params: {
        entry_date: '2027-12-31',
        description: 'far-future date',
        lines: [
          { account_number: '5410', debit_amount: 100, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 100 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/räkenskapsperiod/i)
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('returns 400 when required fields are missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      params: {
        entry_date: '2026-05-12',
        // missing description and lines
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('hardcodes source_type to manual even if params.source_type is tampered', async () => {
    vi.mocked(createJournalEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-tamper', voucher_number: 8 })
    )

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      params: {
        entry_date: '2026-05-12',
        description: 'attempt to spoof source_type',
        fiscal_period_id: 'fp-1',
        // Direct DB insert or future stager could put anything here.
        source_type: 'bank_transaction',
        lines: [
          { account_number: '1010', debit_amount: 100, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 100 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    // Critical assertion: source_type is ALWAYS 'manual', never the
    // caller-supplied value. Bypassing this lets a tampered operation
    // misrepresent the audit trail as a bank-feed or invoice entry.
    expect(createJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ source_type: 'manual' }),
      'mcp_create_voucher'
    )
    expect(createJournalEntry).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ source_type: 'bank_transaction' }),
      expect.anything()
    )
  })

  it('returns 400 with Swedish error when params are unbalanced (tamper defense)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      params: {
        entry_date: '2026-05-12',
        description: 'tampered: debit ≠ credit',
        fiscal_period_id: 'fp-1',
        // The MCP tool validates balance before staging, but a hand-inserted
        // pending_operations row could bypass that. The executor's own
        // validateBalance() gate catches it before reaching the engine.
        lines: [
          { account_number: '1010', debit_amount: 1000, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 800 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/balanserar inte/i)
    expect(createJournalEntry).not.toHaveBeenCalled()
  })
})

// ─── correct_entry ──────────────────────────────────────────────────

describe('commitPendingOperation: correct_entry', () => {
  it('happy path: posts storno + corrected for a posted entry in an open period', async () => {
    vi.mocked(correctEntry).mockResolvedValueOnce({
      reversal: makeJournalEntry({ id: 'je-storno', voucher_number: 50 }),
      corrected: makeJournalEntry({ id: 'je-corrected', voucher_number: 51 }),
    })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'je-original',
        status: 'posted',
        fiscal_period_id: 'fp-1',
        fiscal_periods: { is_closed: false },
      },
      error: null,
    }) // executor's pre-flight fetch
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      operation_type: 'correct_entry',
      params: {
        entry_id: 'je-original',
        lines: [
          { account_number: '2645', debit_amount: 250, credit_amount: 0 },
          { account_number: '2614', debit_amount: 0, credit_amount: 250 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      original_entry_id: 'je-original',
      storno_entry_id: 'je-storno',
      corrected_entry_id: 'je-corrected',
      storno_voucher_number: 50,
      corrected_voucher_number: 51,
    })
    expect(correctEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'je-original',
      expect.arrayContaining([
        expect.objectContaining({ account_number: '2645' }),
        expect.objectContaining({ account_number: '2614' }),
      ])
    )
  })

  it('returns 404 when the original entry does not exist', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // executor's pre-flight fetch (no row)
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      operation_type: 'correct_entry',
      params: {
        entry_id: 'je-missing',
        lines: [
          { account_number: '5410', debit_amount: 100, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 100 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.auto_rejected).toBe(true)
    expect(result.http_status).toBe(404)
    expect(correctEntry).not.toHaveBeenCalled()
  })

  it('returns 409 when the original entry is not posted', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'je-draft',
        status: 'draft',
        fiscal_period_id: 'fp-1',
        fiscal_periods: { is_closed: false },
      },
      error: null,
    }) // executor's pre-flight fetch
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      operation_type: 'correct_entry',
      params: {
        entry_id: 'je-draft',
        lines: [
          { account_number: '5410', debit_amount: 100, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 100 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/bokförda verifikationer/)
    expect(correctEntry).not.toHaveBeenCalled()
  })

  it('returns 409 with omprövning hint when the period is closed', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'je-original',
        status: 'posted',
        fiscal_period_id: 'fp-1',
        fiscal_periods: { is_closed: true },
      },
      error: null,
    }) // executor's pre-flight fetch
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      operation_type: 'correct_entry',
      params: {
        entry_id: 'je-original',
        lines: [
          { account_number: '5410', debit_amount: 100, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 100 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/omprövning/i)
    expect(correctEntry).not.toHaveBeenCalled()
  })

  it('returns 400 when required fields are missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      operation_type: 'correct_entry',
      params: {
        entry_id: 'je-1',
        // missing lines
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(correctEntry).not.toHaveBeenCalled()
  })
})

// ─── reverse_entry ──────────────────────────────────────────────────

describe('commitPendingOperation: reverse_entry', () => {
  it('happy path: posts storno for a posted entry in an open period', async () => {
    vi.mocked(reverseEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-storno', voucher_number: 99, voucher_series: 'A', fiscal_period_id: 'fp-1' })
    )

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'je-original',
        status: 'posted',
        fiscal_period_id: 'fp-1',
        fiscal_periods: { is_closed: false },
      },
      error: null,
    }) // executor's pre-flight fetch
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      operation_type: 'reverse_entry',
      params: { entry_id: 'je-original' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      original_entry_id: 'je-original',
      reversal_entry_id: 'je-storno',
      reversal_voucher_number: 99,
      reversal_voucher_series: 'A',
    })
    expect(reverseEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'je-original',
      undefined
    )
  })

  it('forwards reversal_date when provided', async () => {
    vi.mocked(reverseEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-storno', voucher_number: 100, fiscal_period_id: 'fp-1' })
    )

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'je-original',
        status: 'posted',
        fiscal_period_id: 'fp-1',
        fiscal_periods: { is_closed: false },
      },
      error: null,
    })
    enqueue({ data: null, error: null })

    const op = makePendingOp({
      operation_type: 'reverse_entry',
      params: { entry_id: 'je-original', reversal_date: '2026-05-20' },
    })

    await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(reverseEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'je-original',
      '2026-05-20'
    )
  })

  it('returns 404 when the original entry does not exist', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null }) // pre-flight finds no row
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      operation_type: 'reverse_entry',
      params: { entry_id: 'je-missing' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.auto_rejected).toBe(true)
    expect(result.http_status).toBe(404)
    expect(reverseEntry).not.toHaveBeenCalled()
  })

  it('returns 409 when the original entry is not posted', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({
      data: {
        id: 'je-draft',
        status: 'draft',
        fiscal_period_id: 'fp-1',
        fiscal_periods: { is_closed: false },
      },
      error: null,
    })
    enqueue({ data: null, error: null })

    const op = makePendingOp({
      operation_type: 'reverse_entry',
      params: { entry_id: 'je-draft' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/bokförda verifikationer kan makuleras/)
    expect(reverseEntry).not.toHaveBeenCalled()
  })

  it('returns 409 when the period is closed', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({
      data: {
        id: 'je-original',
        status: 'posted',
        fiscal_period_id: 'fp-1',
        fiscal_periods: { is_closed: true },
      },
      error: null,
    })
    enqueue({ data: null, error: null })

    const op = makePendingOp({
      operation_type: 'reverse_entry',
      params: { entry_id: 'je-original' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/omprövning/i)
    expect(reverseEntry).not.toHaveBeenCalled()
  })

  it('returns 400 when entry_id is missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })

    const op = makePendingOp({
      operation_type: 'reverse_entry',
      params: {},
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(reverseEntry).not.toHaveBeenCalled()
  })

  it('returns 500 with BFL invariant error if engine returns a storno in a different period', async () => {
    // Engine guarantee per BFL 5 kap 5§: storno lands in original.fiscal_period_id
    // (lib/bookkeeping/engine.ts:492). The executor asserts this so a future engine
    // change that breaks the invariant fails fast.
    vi.mocked(reverseEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-storno', voucher_number: 99, fiscal_period_id: 'fp-WRONG' })
    )

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({
      data: {
        id: 'je-original',
        status: 'posted',
        entry_date: '2026-05-15',
        fiscal_period_id: 'fp-1',
        fiscal_periods: { is_closed: false },
      },
      error: null,
    })
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      operation_type: 'reverse_entry',
      params: { entry_id: 'je-original' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(500)
    expect(result.error).toMatch(/BFL invariant broken/i)
  })

  it('returns 409 when the entry_date is covered by the company-wide lock', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'je-original',
        status: 'posted',
        entry_date: '2025-12-15',
        fiscal_period_id: 'fp-1',
        fiscal_periods: { is_closed: false },
      },
      error: null,
    }) // pre-flight fetch — per-period OK
    // resolvePeriodStatusForDate: company_settings says 2025-12-31 lock_through.
    enqueue({ data: { bookkeeping_locked_through: '2025-12-31' }, error: null })
    enqueue({ data: { id: 'fp-1' }, error: null }) // covering period lookup
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      operation_type: 'reverse_entry',
      params: { entry_id: 'je-original' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/låst|omprövning/i)
    expect(reverseEntry).not.toHaveBeenCalled()
  })
})
