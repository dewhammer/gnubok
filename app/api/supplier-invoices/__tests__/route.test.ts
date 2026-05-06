import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
  makeSupplierInvoice,
  makeSupplier,
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

const mockFindFiscalPeriod = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  findFiscalPeriod: (...args: unknown[]) => mockFindFiscalPeriod(...args),
}))

const mockCreateSupplierInvoiceRegistrationEntry = vi.fn()
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({
  createSupplierInvoiceRegistrationEntry: (...args: unknown[]) =>
    mockCreateSupplierInvoiceRegistrationEntry(...args),
}))

import { eventBus } from '@/lib/events'

import { GET, POST } from '../route'

describe('GET /api/supplier-invoices', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/supplier-invoices')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns supplier invoices list', async () => {
    const invoices = [makeSupplierInvoice(), makeSupplierInvoice()]
    enqueue({ data: invoices, error: null })

    const request = createMockRequest('/api/supplier-invoices')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual(invoices)
  })

  it('applies status filter', async () => {
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/supplier-invoices', {
      searchParams: { status: 'registered' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockSupabase.from).toHaveBeenCalledWith('supplier_invoices')
  })

  it('handles to_pay virtual status', async () => {
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/supplier-invoices', {
      searchParams: { status: 'to_pay' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
  })

  it('returns 500 on database error', async () => {
    enqueue({ data: null, error: { message: 'DB error' } })

    const request = createMockRequest('/api/supplier-invoices')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    expect((body.error as unknown as { code: string }).code).toBe('INTERNAL_ERROR')
  })
})

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'
const VALID_UUID_2 = '550e8400-e29b-41d4-a716-446655440001'

describe('POST /api/supplier-invoices', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: { supplier_id: VALID_UUID, items: [] },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 when supplier not found', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID_2,
        supplier_invoice_number: 'LF-001',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [{ description: 'Material', quantity: 1, unit_price: 8000, account_number: '4010' }],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect((body.error as unknown as { code: string }).code).toBe('SUPPLIER_NOT_FOUND')
  })

  it('creates supplier invoice with items and arrival number', async () => {
    const supplier = makeSupplier({ id: VALID_UUID })
    const createdInvoice = makeSupplierInvoice({ id: 'si-1' })

    // Fetch supplier
    enqueue({ data: supplier, error: null })
    // RPC get_next_arrival_number
    enqueue({ data: 5 })
    // Insert invoice
    enqueue({ data: createdInvoice, error: null })
    // Insert items
    enqueue({ data: null, error: null })
    // Fetch company settings
    enqueue({ data: { accounting_method: 'accrual' }, error: null })

    mockCreateSupplierInvoiceRegistrationEntry.mockResolvedValue({ id: 'je-1' })
    // Update invoice with registration_journal_entry_id
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LF-001',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [
          {
            description: 'Material',
            quantity: 10,
            unit_price: 800,
            account_number: '4010',
            vat_rate: 0.25,
          },
        ],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      data: { registration_journal_entry_id: string }
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toBeTruthy()
    expect(body.data.registration_journal_entry_id).toBe('je-1')
    expect(mockCreateSupplierInvoiceRegistrationEntry).toHaveBeenCalled()
  })

  it('emits supplier_invoice.registered event', async () => {
    const supplier = makeSupplier({ id: VALID_UUID })
    const createdInvoice = makeSupplierInvoice({ id: 'si-1' })

    enqueue({ data: supplier, error: null })
    enqueue({ data: 5 })
    enqueue({ data: createdInvoice, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })

    mockCreateSupplierInvoiceRegistrationEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: null, error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LF-001',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [
          { description: 'Material', quantity: 10, unit_price: 800, account_number: '4010', vat_rate: 0.25 },
        ],
      },
    })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'supplier_invoice.registered',
        payload: expect.objectContaining({ userId: 'user-1' }),
      })
    )
  })

  it('skips registration entry for cash method', async () => {
    const supplier = makeSupplier({ id: VALID_UUID })
    const createdInvoice = makeSupplierInvoice({ id: 'si-1' })

    enqueue({ data: supplier, error: null })
    enqueue({ data: 6 })
    enqueue({ data: createdInvoice, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { accounting_method: 'cash' }, error: null })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LF-002',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [{ description: 'Service', quantity: 1, unit_price: 5000, account_number: '6200' }],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      data: { registration_journal_entry_id: null }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.registration_journal_entry_id).toBeNull()
    expect(mockCreateSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
  })

  it('rolls back on items insertion failure', async () => {
    const supplier = makeSupplier({ id: VALID_UUID })
    const createdInvoice = makeSupplierInvoice({ id: 'si-1' })

    enqueue({ data: supplier, error: null })
    enqueue({ data: 7 })
    enqueue({ data: createdInvoice, error: null })
    // Items fail
    enqueue({ data: null, error: { message: 'Items insert failed' } })
    // Rollback delete
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LF-003',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [{ description: 'Test', quantity: 1, unit_price: 1000, account_number: '4010' }],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    expect((body.error as unknown as { code: string }).code).toBe('SI_CREATE_FAILED')
  })

  it('returns 409 with credit chain on duplicate supplier_invoice_number for credited original', async () => {
    const supplier = makeSupplier({ id: VALID_UUID })

    // Fetch supplier
    enqueue({ data: supplier, error: null })
    // RPC get_next_arrival_number
    enqueue({ data: 8 })
    // Insert invoice → unique-index violation
    enqueue({
      data: null,
      error: {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "idx_supplier_invoices_company_supplier_number"',
      },
    })
    // Lookup existing row
    enqueue({
      data: {
        id: 'existing-1',
        supplier_invoice_number: 'LF-DUP',
        status: 'credited',
      },
      error: null,
    })
    // Lookup credit note for the credited original
    enqueue({ data: { id: 'credit-1' }, error: null })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LF-DUP',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [{ description: 'Test', quantity: 1, unit_price: 1000, account_number: '4010' }],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { existing: { id: string; supplier_invoice_number: string; status: string; credit_note_id: string } } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('SI_CREATE_DUPLICATE_INVOICE_NUMBER')
    expect(body.error.details.existing).toEqual({
      id: 'existing-1',
      supplier_invoice_number: 'LF-DUP',
      status: 'credited',
      credit_note_id: 'credit-1',
    })
  })

  it('returns 409 without credit_note_id when existing invoice is not credited', async () => {
    const supplier = makeSupplier({ id: VALID_UUID })

    enqueue({ data: supplier, error: null })
    enqueue({ data: 9 })
    enqueue({
      data: null,
      error: {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "idx_supplier_invoices_company_supplier_number"',
      },
    })
    enqueue({
      data: {
        id: 'existing-2',
        supplier_invoice_number: 'LF-DUP-2',
        status: 'approved',
      },
      error: null,
    })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LF-DUP-2',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [{ description: 'Test', quantity: 1, unit_price: 1000, account_number: '4010' }],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { existing: { id: string; status: string; credit_note_id: string | null } } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('SI_CREATE_DUPLICATE_INVOICE_NUMBER')
    expect(body.error.details.existing.status).toBe('approved')
    expect(body.error.details.existing.credit_note_id).toBeNull()
  })

  it('returns generic 409 when existing row lookup races to nothing', async () => {
    const supplier = makeSupplier({ id: VALID_UUID })

    enqueue({ data: supplier, error: null })
    enqueue({ data: 10 })
    enqueue({
      data: null,
      error: {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "idx_supplier_invoices_company_supplier_number"',
      },
    })
    // Lookup returns null — the row was deleted between the failing insert and our fetch
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LF-RACE',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [{ description: 'Test', quantity: 1, unit_price: 1000, account_number: '4010' }],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { existing?: unknown } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('SI_CREATE_DUPLICATE_INVOICE_NUMBER')
    expect(body.error.details?.existing).toBeNull()
  })

  it('falls through to 500 for non-23505 insert errors', async () => {
    const supplier = makeSupplier({ id: VALID_UUID })

    enqueue({ data: supplier, error: null })
    enqueue({ data: 11 })
    enqueue({ data: null, error: { code: '23502', message: 'NOT NULL violation' } })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LF-OTHER',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [{ description: 'Test', quantity: 1, unit_price: 1000, account_number: '4010' }],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    expect((body.error as unknown as { code: string }).code).toBe('SI_CREATE_FAILED')
  })
})
