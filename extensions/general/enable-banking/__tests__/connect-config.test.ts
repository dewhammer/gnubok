import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { enableBankingExtension } from '../index'
import type { ExtensionContext } from '@/lib/extensions/types'

const connectRoute = enableBankingExtension.apiRoutes?.find(
  r => r.method === 'POST' && r.path === '/connect'
)

if (!connectRoute) {
  throw new Error('POST /connect route not registered on enable-banking extension')
}

function makeContext(): ExtensionContext {
  const supabase = {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null }),
    },
  }

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

function makeRequest(): Request {
  return new Request('http://localhost/api/extensions/ext/enable-banking/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aspsp_name: 'SEB', aspsp_country: 'SE' }),
  })
}

describe('POST /connect (enable-banking) configuration', () => {
  beforeEach(() => {
    vi.stubEnv('ENABLE_BANKING_APP_ID', '')
    vi.stubEnv('ENABLE_BANKING_APP_ID_PRODUCTION', '')
    vi.stubEnv('ENABLE_BANKING_PRIVATE_KEY', '')
    vi.stubEnv('ENABLE_BANKING_PRIVATE_KEY_PRODUCTION', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns 503 NOT_CONFIGURED when Enable Banking credentials are missing', async () => {
    const res = await connectRoute.handler(makeRequest(), makeContext())

    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body).toMatchObject({
      error: 'Enable Banking is not configured',
      code: 'NOT_CONFIGURED',
      configuration_error: 'ENABLE_BANKING_APP_ID environment variable is not set',
    })
  })
})
