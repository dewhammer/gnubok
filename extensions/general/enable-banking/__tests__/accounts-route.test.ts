import { describe, it, expect, vi, beforeEach } from 'vitest'
import { enableBankingExtension } from '../index'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { StoredAccount } from '../types'

// Locate the PATCH /accounts handler once — schema doesn't change at runtime.
const accountsRoute = enableBankingExtension.apiRoutes?.find(
  r => r.method === 'PATCH' && r.path === '/accounts'
)

if (!accountsRoute) {
  throw new Error('PATCH /accounts route not registered on enable-banking extension')
}

interface SupabaseStub {
  authUser: { id: string } | null
  connectionRow: {
    id: string
    status: string
    accounts_data: StoredAccount[]
  } | null
  connectionError?: { message: string } | null
  updateError?: { message: string } | null
  capturedUpdate?: Record<string, unknown>
}

function buildSupabase(stub: SupabaseStub) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: stub.authUser }, error: null }),
    },
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: stub.connectionRow,
        error: stub.connectionError ?? null,
      }),
      update: vi.fn((payload: Record<string, unknown>) => {
        stub.capturedUpdate = payload
        return {
          eq: vi.fn().mockResolvedValue({ error: stub.updateError ?? null }),
        }
      }),
    })),
  }
}

function makeContext(supabase: ReturnType<typeof buildSupabase>): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'enable-banking',
    requestId: 'req_test',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    emit: vi.fn().mockResolvedValue(undefined),
    settings: { get: vi.fn(), set: vi.fn(), getAll: vi.fn() } as never,
    storage: {} as never,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as never,
    services: {} as never,
  }
}

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/extensions/ext/enable-banking/accounts', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('PATCH /accounts (enable-banking)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when unauthenticated', async () => {
    const supabase = buildSupabase({ authUser: null, connectionRow: null })
    const ctx = makeContext(supabase)

    const res = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1'] }),
      ctx
    )
    expect(res.status).toBe(401)
  })

  it('returns 400 when connection_id missing', async () => {
    const supabase = buildSupabase({ authUser: { id: 'user-1' }, connectionRow: null })
    const ctx = makeContext(supabase)

    const res = await accountsRoute.handler(
      makeRequest({ enabled_uids: ['acc-1'] }),
      ctx
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 when enabled_uids is empty', async () => {
    const supabase = buildSupabase({ authUser: { id: 'user-1' }, connectionRow: null })
    const ctx = makeContext(supabase)

    const res = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: [] }),
      ctx
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Välj minst ett konto/i)
  })

  it('returns 400 when enabled_uids contains unknown uid', async () => {
    const supabase = buildSupabase({
      authUser: { id: 'user-1' },
      connectionRow: {
        id: 'conn-1',
        status: 'pending_selection',
        accounts_data: [
          { uid: 'acc-1', currency: 'SEK', enabled: true },
          { uid: 'acc-2', currency: 'SEK', enabled: true },
        ],
      },
    })
    const ctx = makeContext(supabase)

    const res = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1', 'acc-bogus'] }),
      ctx
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.unknown_uids).toEqual(['acc-bogus'])
  })

  it('returns 404 when connection not found', async () => {
    const supabase = buildSupabase({
      authUser: { id: 'user-1' },
      connectionRow: null,
      connectionError: { message: 'not found' },
    })
    const ctx = makeContext(supabase)

    const res = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1'] }),
      ctx
    )
    expect(res.status).toBe(404)
  })

  it('returns 400 when connection is in an invalid status (e.g. expired)', async () => {
    const supabase = buildSupabase({
      authUser: { id: 'user-1' },
      connectionRow: {
        id: 'conn-1',
        status: 'expired',
        accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }],
      },
    })
    const ctx = makeContext(supabase)

    const res = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1'] }),
      ctx
    )
    expect(res.status).toBe(400)
  })

  it('flips status to active and writes per-account enabled flags', async () => {
    const stub: SupabaseStub = {
      authUser: { id: 'user-1' },
      connectionRow: {
        id: 'conn-1',
        status: 'pending_selection',
        accounts_data: [
          { uid: 'acc-1', currency: 'SEK', enabled: true, name: 'Företag' },
          { uid: 'acc-2', currency: 'SEK', enabled: true, name: 'Privat' },
          { uid: 'acc-3', currency: 'SEK', enabled: true, name: 'Spar' },
        ],
      },
    }
    const supabase = buildSupabase(stub)
    const ctx = makeContext(supabase)

    const res = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1', 'acc-3'] }),
      ctx
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, enabled_count: 2, total_count: 3 })

    expect(stub.capturedUpdate).toBeDefined()
    expect(stub.capturedUpdate?.status).toBe('active')
    const written = stub.capturedUpdate?.accounts_data as StoredAccount[]
    expect(written).toHaveLength(3)
    expect(written.find(a => a.uid === 'acc-1')?.enabled).toBe(true)
    expect(written.find(a => a.uid === 'acc-2')?.enabled).toBe(false)
    expect(written.find(a => a.uid === 'acc-3')?.enabled).toBe(true)
    // Disabled accounts are kept in the row so the user can re-enable later.
    expect(written.find(a => a.uid === 'acc-2')?.name).toBe('Privat')
  })

  it('allows re-selection on an already-active connection', async () => {
    const stub: SupabaseStub = {
      authUser: { id: 'user-1' },
      connectionRow: {
        id: 'conn-1',
        status: 'active',
        accounts_data: [
          { uid: 'acc-1', currency: 'SEK', enabled: true },
          { uid: 'acc-2', currency: 'SEK', enabled: false },
        ],
      },
    }
    const supabase = buildSupabase(stub)
    const ctx = makeContext(supabase)

    const res = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-2'] }),
      ctx
    )

    expect(res.status).toBe(200)
    const written = stub.capturedUpdate?.accounts_data as StoredAccount[]
    expect(written.find(a => a.uid === 'acc-1')?.enabled).toBe(false)
    expect(written.find(a => a.uid === 'acc-2')?.enabled).toBe(true)
  })

  it('omits status from update payload when connection is already active (state machine)', async () => {
    const stub: SupabaseStub = {
      authUser: { id: 'user-1' },
      connectionRow: {
        id: 'conn-1',
        status: 'active',
        accounts_data: [
          { uid: 'acc-1', currency: 'SEK', enabled: true },
          { uid: 'acc-2', currency: 'SEK', enabled: false },
        ],
      },
    }
    const supabase = buildSupabase(stub)
    const ctx = makeContext(supabase)

    const res = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-2'] }),
      ctx
    )

    expect(res.status).toBe(200)
    // Status field is NOT present in the update — already-active connections
    // don't re-assert the transition, which keeps the state machine explicit.
    expect(stub.capturedUpdate).toBeDefined()
    expect('status' in (stub.capturedUpdate ?? {})).toBe(false)
  })

  it('returns 400 when ctx.companyId is absent (no user.id fallback)', async () => {
    const supabase = buildSupabase({ authUser: { id: 'user-1' }, connectionRow: null })
    const ctx = makeContext(supabase)
    // Simulate a missing company context — should not fall back to user.id.
    const ctxWithoutCompany = { ...ctx, companyId: undefined as unknown as string }

    const res = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1'] }),
      ctxWithoutCompany
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Company context required/i)
  })

  it('returns 400 when enabled_uids exceeds the per-connection cap', async () => {
    const supabase = buildSupabase({
      authUser: { id: 'user-1' },
      connectionRow: {
        id: 'conn-1',
        status: 'pending_selection',
        accounts_data: [],
      },
    })
    const ctx = makeContext(supabase)

    const tooMany = Array.from({ length: 51 }, (_, i) => `acc-${i}`)
    const res = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: tooMany }),
      ctx
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Max 50 konton/i)
  })

  it('emits bank_connection.account_selection_changed after a successful update', async () => {
    const stub: SupabaseStub = {
      authUser: { id: 'user-1' },
      connectionRow: {
        id: 'conn-1',
        status: 'pending_selection',
        accounts_data: [
          { uid: 'acc-1', currency: 'SEK', enabled: true },
          { uid: 'acc-2', currency: 'SEK', enabled: true },
        ],
      },
    }
    const supabase = buildSupabase(stub)
    const ctx = makeContext(supabase)

    const res = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1'] }),
      ctx
    )

    expect(res.status).toBe(200)
    expect(ctx.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'bank_connection.account_selection_changed',
        payload: expect.objectContaining({
          connectionId: 'conn-1',
          previousStatus: 'pending_selection',
          newStatus: 'active',
          enabledCount: 1,
          totalCount: 2,
          userId: 'user-1',
          companyId: 'company-1',
        }),
      })
    )
  })
})
