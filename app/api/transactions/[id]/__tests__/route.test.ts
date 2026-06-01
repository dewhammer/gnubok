import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeTransaction,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

// PATCH (edit title) goes through withRouteContext → requireAuth.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))

vi.mock('@/lib/sandbox/guard', () => ({
  guardSandbox: vi.fn(),
}))

import { DELETE, PATCH } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { guardSandbox } from '@/lib/sandbox/guard'
import { NextResponse } from 'next/server'

describe('DELETE /api/transactions/[id]', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = new Request('http://localhost/api/transactions/tx-1', { method: 'DELETE' })
    const response = await DELETE(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 when transaction not found', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = new Request('http://localhost/api/transactions/tx-1', { method: 'DELETE' })
    const response = await DELETE(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(404)
    expect(body).toEqual({ error: 'Transaction not found' })
  })

  it('returns 409 when transaction has a journal entry', async () => {
    const tx = makeTransaction({ journal_entry_id: 'je-1', bank_connection_id: null, import_source: null })
    enqueue({ data: tx, error: null })

    const request = new Request('http://localhost/api/transactions/tx-1', { method: 'DELETE' })
    const response = await DELETE(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(409)
    expect(body.error).toContain('booked')
  })

  it('allows deleting unbooked bank-synced transactions', async () => {
    const tx = makeTransaction({ bank_connection_id: 'bc-1', journal_entry_id: null, import_source: null })
    enqueue({ data: tx, error: null }) // fetch
    enqueue({ data: null, error: null }) // delete

    const request = new Request('http://localhost/api/transactions/tx-1', { method: 'DELETE' })
    const response = await DELETE(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(body).toEqual({ success: true })
  })

  it('allows deleting unbooked imported transactions', async () => {
    const tx = makeTransaction({ import_source: 'csv_nordea', journal_entry_id: null, bank_connection_id: null })
    enqueue({ data: tx, error: null }) // fetch
    enqueue({ data: null, error: null }) // delete

    const request = new Request('http://localhost/api/transactions/tx-1', { method: 'DELETE' })
    const response = await DELETE(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(body).toEqual({ success: true })
  })

  it('deletes a manually added unbooked transaction', async () => {
    const tx = makeTransaction({ journal_entry_id: null, bank_connection_id: null, import_source: null })
    enqueue({ data: tx, error: null }) // fetch
    enqueue({ data: null, error: null }) // delete

    const request = new Request('http://localhost/api/transactions/tx-1', { method: 'DELETE' })
    const response = await DELETE(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(body).toEqual({ success: true })
  })

  it('returns 500 when deletion fails', async () => {
    const tx = makeTransaction({ journal_entry_id: null, bank_connection_id: null, import_source: null })
    enqueue({ data: tx, error: null }) // fetch
    enqueue({ data: null, error: { message: 'DB error' } }) // delete fails

    const request = new Request('http://localhost/api/transactions/tx-1', { method: 'DELETE' })
    const response = await DELETE(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(500)
    expect(body).toEqual({ error: 'Failed to delete transaction' })
  })
})

describe('PATCH /api/transactions/[id] (edit title)', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  function patchReq(body: unknown) {
    return new Request('http://localhost/api/transactions/tx-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: mockSupabase as never,
      error: null,
    })
    vi.mocked(guardSandbox).mockResolvedValue(null)
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const res = await PATCH(patchReq({ description: 'Ny titel' }), createMockRouteParams({ id: 'tx-1' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 400 when the title is empty / whitespace-only', async () => {
    const res = await PATCH(patchReq({ description: '   ' }), createMockRouteParams({ id: 'tx-1' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
  })

  it('returns 404 when the transaction is not found', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const res = await PATCH(patchReq({ description: 'Ny titel' }), createMockRouteParams({ id: 'tx-1' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(404)
  })

  it('returns 409 when the transaction is booked', async () => {
    enqueue({
      data: {
        id: 'tx-1',
        description: 'X',
        original_description: 'X',
        journal_entry_id: 'je-1',
        invoice_id: null,
        supplier_invoice_id: null,
      },
      error: null,
    })

    const res = await PATCH(patchReq({ description: 'Ny titel' }), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(409)
    expect(body.error.code).toBe('TRANSACTION_TITLE_LOCKED')
  })

  it('returns 409 when matched to an invoice even if journal_entry_id is null', async () => {
    enqueue({
      data: {
        id: 'tx-1',
        description: 'X',
        original_description: 'X',
        journal_entry_id: null,
        invoice_id: 'inv-1',
        supplier_invoice_id: null,
      },
      error: null,
    })

    const res = await PATCH(patchReq({ description: 'Ny titel' }), createMockRouteParams({ id: 'tx-1' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(409)
  })

  it('updates the title for an editable (unbooked, unmatched) transaction', async () => {
    enqueue({
      data: {
        id: 'tx-1',
        description: 'ICA',
        original_description: 'ICA',
        journal_entry_id: null,
        invoice_id: null,
        supplier_invoice_id: null,
      },
      error: null,
    }) // fetch
    enqueue({
      data: { id: 'tx-1', description: 'Lunch med kund', title_edited_at: '2026-06-01T10:00:00Z' },
      error: null,
    }) // update

    const res = await PATCH(
      patchReq({ description: 'Lunch med kund' }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status, body } = await parseJsonResponse<{ data: { description: string } }>(res)
    expect(status).toBe(200)
    expect(body.data.description).toBe('Lunch med kund')
  })

  it('restores the original title (200) when the new title equals original_description', async () => {
    enqueue({
      data: {
        id: 'tx-1',
        description: 'Lunch med kund',
        original_description: 'ICA MAXI',
        journal_entry_id: null,
        invoice_id: null,
        supplier_invoice_id: null,
      },
      error: null,
    }) // fetch
    enqueue({
      data: { id: 'tx-1', description: 'ICA MAXI', title_edited_at: null },
      error: null,
    }) // update

    const res = await PATCH(patchReq({ description: 'ICA MAXI' }), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ data: { title_edited_at: string | null } }>(res)
    expect(status).toBe(200)
    expect(body.data.title_edited_at).toBeNull()
  })

  it('returns 409 when the row is matched/booked between read and write (optimistic-lock miss)', async () => {
    enqueue({
      data: {
        id: 'tx-1',
        description: 'ICA',
        original_description: 'ICA',
        journal_entry_id: null,
        invoice_id: null,
        supplier_invoice_id: null,
      },
      error: null,
    }) // fetch passes the read gate
    enqueue({ data: null, error: null }) // UPDATE affects 0 rows (gate re-assert failed)

    const res = await PATCH(patchReq({ description: 'Ny titel' }), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(409)
    expect(body.error.code).toBe('TRANSACTION_TITLE_LOCKED')
  })
})
