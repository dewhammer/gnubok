import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createQueuedMockSupabase,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/invoices/match-log', () => ({
  logMatchEvent: vi.fn(),
}))

vi.mock('@/lib/events/bus', () => ({
  eventBus: { emit: vi.fn() },
}))

const mockCreatePaymentEntry = vi.fn()
const mockCreateCashEntry = vi.fn()
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({
  createSupplierInvoicePaymentEntry: (...args: unknown[]) => mockCreatePaymentEntry(...args),
  createSupplierInvoiceCashEntry: (...args: unknown[]) => mockCreateCashEntry(...args),
}))

import { POST } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  mockCreatePaymentEntry.mockResolvedValue({ id: 'je-1' })
  mockCreateCashEntry.mockResolvedValue({ id: 'je-1' })
})

const TX_UUID = '11111111-1111-4111-8111-111111111111'
const SI_UUID = '22222222-2222-4222-8222-222222222222'

function makeReq() {
  return new Request(`http://localhost/api/transactions/${TX_UUID}/match-supplier-invoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ supplier_invoice_id: SI_UUID }),
  })
}

function enqueueHappyPath(opts: {
  transaction: { amount: number; currency: string; amount_sek?: number | null }
  invoice: {
    currency: string
    exchange_rate?: number | null
    remaining_amount?: number
    paid_amount?: number
  }
}) {
  // 1. transactions fetch
  enqueue({
    data: {
      id: TX_UUID,
      company_id: 'company-1',
      amount: opts.transaction.amount,
      currency: opts.transaction.currency,
      amount_sek: opts.transaction.amount_sek ?? null,
      supplier_invoice_id: null,
      date: '2026-05-12',
    },
    error: null,
  })
  // 2. supplier_invoices fetch
  enqueue({
    data: {
      id: SI_UUID,
      currency: opts.invoice.currency,
      exchange_rate: opts.invoice.exchange_rate ?? null,
      status: 'registered',
      remaining_amount: opts.invoice.remaining_amount ?? 225,
      paid_amount: opts.invoice.paid_amount ?? 0,
      supplier: { supplier_type: 'eu_business' },
      items: [],
    },
    error: null,
  })
  // 3. company_settings fetch
  enqueue({ data: { accounting_method: 'accrual' }, error: null })
  // 4. supplier_invoices update (CAS)
  enqueue({ data: [{ id: SI_UUID }], error: null })
  // 5. supplier_invoice_payments insert
  enqueue({ data: null, error: null })
  // 6. transactions update (link)
  enqueue({ data: null, error: null })
}

describe('POST /api/transactions/[id]/match-supplier-invoice — FX residual', () => {
  it('passes no exchangeRateDifference for a SEK transaction paying a SEK invoice', async () => {
    enqueueHappyPath({
      transaction: { amount: -2390, currency: 'SEK' },
      invoice: { currency: 'SEK', remaining_amount: 2390 },
    })
    await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    expect(mockCreatePaymentEntry).toHaveBeenCalledTimes(1)
    const args = mockCreatePaymentEntry.mock.calls[0]
    // (supabase, companyId, userId, invoice, paymentAmountSek, paymentDate, exchangeRateDifference?)
    expect(args[4]).toBe(2390) // paymentAmountSek = actual bank SEK
    expect(args[6]).toBeUndefined() // no FX diff
  })

  it('computes a loss when the SEK paid exceeds the AP booked SEK (EUR invoice)', async () => {
    // Invoice: 225 EUR @ rate 10.6254 → AP booked at 2390.72 SEK.
    // Bank: paid 2400 SEK out of a SEK account.
    // → diff = 2390.72 − 2400 = −9.28 (loss, debit 7960).
    enqueueHappyPath({
      transaction: { amount: -2400, currency: 'SEK' },
      invoice: { currency: 'EUR', exchange_rate: 10.6254, remaining_amount: 225 },
    })
    await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const args = mockCreatePaymentEntry.mock.calls[0]
    expect(args[4]).toBeCloseTo(2390.72, 2) // paymentAmountSek = originalBookedSek
    expect(args[6]).toBeCloseTo(-9.28, 2) // exchangeRateDifference (loss)
  })

  it('computes a gain when the SEK paid is less than the AP booked SEK', async () => {
    // Invoice: 100 EUR @ rate 11 → AP booked at 1100 SEK.
    // Bank: paid 1080 SEK (rate had dipped) → diff = 1100 − 1080 = +20 (gain → credit 3960).
    enqueueHappyPath({
      transaction: { amount: -1080, currency: 'SEK' },
      invoice: { currency: 'EUR', exchange_rate: 11, remaining_amount: 100 },
    })
    await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const args = mockCreatePaymentEntry.mock.calls[0]
    expect(args[4]).toBeCloseTo(1100, 2)
    expect(args[6]).toBeCloseTo(20, 2)
  })

  it('uses transaction.amount_sek for a foreign-currency bank transaction', async () => {
    // Reverse case: SEK invoice for 1000 kr, paid from a EUR card that
    // showed amount_sek = 1063 (rate had moved).
    // → diff = 1000 − 1063 = −63 (loss).
    enqueueHappyPath({
      transaction: { amount: -100, currency: 'EUR', amount_sek: -1063 },
      invoice: { currency: 'SEK', remaining_amount: 1000 },
    })
    await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const args = mockCreatePaymentEntry.mock.calls[0]
    // SEK invoice: originalBookedSek = remaining = 1000, FX diff = 1000 - 1063 = -63
    expect(args[4]).toBe(1000)
    expect(args[6]).toBeCloseTo(-63, 2)
  })

  it('falls back to bank SEK when the invoice has no exchange_rate on file', async () => {
    // Foreign-currency invoice but exchange_rate is null on the row.
    // Without a rate we can't compute the AP-booked SEK precisely, so we
    // pass the actual bank SEK and skip the FX diff.
    enqueueHappyPath({
      transaction: { amount: -239, currency: 'SEK' },
      invoice: { currency: 'USD', exchange_rate: null, remaining_amount: 25 },
    })
    await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const args = mockCreatePaymentEntry.mock.calls[0]
    expect(args[4]).toBe(239)
    expect(args[6]).toBeUndefined()
  })
})

describe('POST /api/transactions/[id]/match-supplier-invoice — non-FX paths', () => {
  it('returns 200 with the expected body shape on the happy path', async () => {
    enqueueHappyPath({
      transaction: { amount: -1000, currency: 'SEK' },
      invoice: { currency: 'SEK', remaining_amount: 1000 },
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      paid_amount: number
      remaining_amount: number
    }>(res)
    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.paid_amount).toBe(1000)
    expect(body.remaining_amount).toBe(0)
  })
})
