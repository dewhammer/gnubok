import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  makeJournalEntry,
} from '@/tests/helpers'

const mockCreateClient = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => mockCreateClient(),
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

const mockCommitEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  commitEntry: (...args: unknown[]) => mockCommitEntry(...args),
}))

import { POST } from '../route'

describe('POST /api/bookkeeping/journal-entries/[id]/commit', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: mockUser } }) },
    })
  })

  it('returns 401 when not authenticated', async () => {
    mockCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    })

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/commit', {
      method: 'POST',
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns posted entry on success', async () => {
    const postedEntry = makeJournalEntry({
      id: 'entry-1',
      status: 'posted',
      voucher_series: 'A',
      voucher_number: 42,
    })
    mockCommitEntry.mockResolvedValue(postedEntry)

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/commit', {
      method: 'POST',
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse<{ data: unknown }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual(postedEntry)
    expect(mockCommitEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'entry-1',
      'manual'
    )
  })

  it('returns 400 when engine throws', async () => {
    mockCommitEntry.mockRejectedValue(new Error('Entry not balanced'))

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/commit', {
      method: 'POST',
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toBe('Entry not balanced')
  })
})
