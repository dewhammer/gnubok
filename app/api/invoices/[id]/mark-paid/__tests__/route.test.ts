import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeInvoice,
  makeCustomer,
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

const mockCreateInvoicePaymentJournalEntry = vi.fn()
const mockCreateInvoiceCashEntry = vi.fn()
vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoicePaymentJournalEntry: (...args: unknown[]) =>
    mockCreateInvoicePaymentJournalEntry(...args),
  createInvoiceCashEntry: (...args: unknown[]) =>
    mockCreateInvoiceCashEntry(...args),
}))

const mockCreateJournalEntry = vi.fn()
const mockFindFiscalPeriod = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) =>
    mockCreateJournalEntry(...args),
  findFiscalPeriod: (...args: unknown[]) =>
    mockFindFiscalPeriod(...args),
}))

import { POST } from '../route'

describe('POST /api/invoices/[id]/mark-paid', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 when invoice not found', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_PAID_NOT_FOUND')
  })

  it('returns 400 when invoice is in draft status', async () => {
    const invoice = makeInvoice({ status: 'draft' })
    enqueue({ data: invoice, error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_PAID_NOT_PAYABLE')
  })

  it('returns 400 when invoice is already paid', async () => {
    const invoice = makeInvoice({ status: 'paid' })
    enqueue({ data: invoice, error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_PAID_NOT_PAYABLE')
  })

  it('returns 400 when invoice is credited', async () => {
    const invoice = makeInvoice({ status: 'credited' })
    enqueue({ data: invoice, error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body: _body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
  })

  it('marks sent invoice as paid with accrual method', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({
      id: 'inv-1',
      status: 'sent',
      total: 12500,
      customer,
    })

    // Fetch invoice
    enqueue({ data: invoice, error: null })
    // Fetch company settings (now before update due to journal-first ordering)
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })
    // Update invoice status (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'inv-1' }], error: null })

    mockCreateInvoicePaymentJournalEntry.mockResolvedValue({ id: 'je-1' })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      status: string
      paid_amount: number
      journal_entry_id: string | null
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.status).toBe('paid')
    expect(body.paid_amount).toBe(12500)
    expect(body.journal_entry_id).toBe('je-1')
    expect(mockCreateInvoicePaymentJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ id: 'inv-1' }),
      expect.any(String),
      undefined,
      expect.anything()
    )
  })

  it('marks overdue invoice as paid with cash method', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({
      id: 'inv-1',
      status: 'overdue',
      total: 12500,
      customer,
    })

    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'cash', entity_type: 'enskild_firma' }, error: null })
    // Update invoice status (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'inv-1' }], error: null })

    mockCreateInvoiceCashEntry.mockResolvedValue({ id: 'je-2' })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_id: string | null
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_id).toBe('je-2')
    expect(mockCreateInvoiceCashEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ id: 'inv-1' }),
      expect.any(String),
      'enskild_firma',
      expect.anything()
    )
  })

  it('returns 500 when journal entry creation fails (invoice not marked paid)', async () => {
    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', total: 12500 })

    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })

    mockCreateInvoicePaymentJournalEntry.mockRejectedValueOnce(new Error('Period locked'))

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(500)
  })

  it('uses custom lines when provided instead of auto-generating', async () => {
    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', total: 12500 })

    // Fetch invoice
    enqueue({ data: invoice, error: null })
    // Fetch company settings (before update — journal-first ordering)
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })
    // Update invoice status (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'inv-1' }], error: null })

    mockFindFiscalPeriod.mockResolvedValue('fp-1')
    mockCreateJournalEntry.mockResolvedValue({ id: 'je-custom' })

    const customLines = [
      { account_number: '1920', debit_amount: 12500, credit_amount: 0, line_description: 'Betalning' },
      { account_number: '1510', debit_amount: 0, credit_amount: 12500, line_description: 'Betalning' },
    ]

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: {
        payment_date: '2025-03-17',
        lines: customLines,
      },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_id: string | null
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_id).toBe('je-custom')
    // Should NOT call auto-generation functions
    expect(mockCreateInvoicePaymentJournalEntry).not.toHaveBeenCalled()
    expect(mockCreateInvoiceCashEntry).not.toHaveBeenCalled()
    // Should call createJournalEntry directly with custom lines
    expect(mockCreateJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({
        entry_date: '2025-03-17',
        source_type: 'invoice_paid',
        lines: customLines,
      })
    )
  })

  it('returns 400 when custom lines are unbalanced', async () => {
    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', total: 12500 })

    // Fetch invoice
    enqueue({ data: invoice, error: null })

    const unbalancedLines = [
      { account_number: '1920', debit_amount: 12500, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 10000 },
    ]

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: {
        payment_date: '2025-03-17',
        lines: unbalancedLines,
      },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_PAID_LINES_UNBALANCED')
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('returns 400 when body has invalid schema (e.g. bad account number)', async () => {
    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', total: 12500 })

    // Fetch invoice
    enqueue({ data: invoice, error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: {
        payment_date: '2025-03-17',
        lines: [
          { account_number: 'XXXX', debit_amount: 12500, credit_amount: 0 },
        ],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
  })

  it('falls back to auto-generation when lines are not provided', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({
      id: 'inv-1',
      status: 'sent',
      total: 12500,
      customer,
    })

    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })
    // Update invoice status (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'inv-1' }], error: null })

    mockCreateInvoicePaymentJournalEntry.mockResolvedValue({ id: 'je-auto' })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: { payment_date: '2025-03-17' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_id: string | null
    }>(response)

    expect(status).toBe(200)
    expect(body.journal_entry_id).toBe('je-auto')
    expect(mockCreateInvoicePaymentJournalEntry).toHaveBeenCalled()
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })
})
