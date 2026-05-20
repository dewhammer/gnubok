import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  isAllowedRedirectUri: vi.fn(),
  requireCompanyId: vi.fn(),
  getBranding: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => mocks.createClient(),
}))

vi.mock('@/lib/auth/oauth-allowlist', () => ({
  isAllowedRedirectUri: (...args: unknown[]) => mocks.isAllowedRedirectUri(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: (...args: unknown[]) => mocks.requireCompanyId(...args),
}))

vi.mock('@/lib/branding/service', () => ({
  getBranding: () => mocks.getBranding(),
}))

import { GET } from '../route'

function buildAuthorizeUrl(params: Record<string, string>): string {
  const url = new URL('http://localhost/api/mcp-oauth/authorize')
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  return url.toString()
}

function buildSupabase(user: { id: string } | null, companyName = 'Test AB') {
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }) },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { company_name: companyName },
            error: null,
          }),
        }),
      }),
    }),
  }
}

describe('GET /api/mcp-oauth/authorize — CSP', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
    mocks.createClient.mockResolvedValue(buildSupabase({ id: 'user-1' }))
    mocks.isAllowedRedirectUri.mockResolvedValue(true)
    mocks.requireCompanyId.mockResolvedValue('company-1')
    mocks.getBranding.mockReturnValue({ appName: 'gnubok' })
  })

  it("form-action includes the redirect_uri origin so the post-consent redirect isn't blocked", async () => {
    // Regression: the consent form POSTs same-origin, but the server's 303
    // response redirects to the client callback. CSP form-action re-checks
    // every hop in the chain, so 'self' alone blocks the post-consent step.
    const request = new Request(
      buildAuthorizeUrl({
        response_type: 'code',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: 'abc',
        code_challenge_method: 'S256',
        scope: 'mcp',
        state: 'xyz',
      })
    )
    const response = await GET(request)
    expect(response.status).toBe(200)

    const csp = response.headers.get('Content-Security-Policy')
    expect(csp).toBeTruthy()
    expect(csp).toMatch(/form-action 'self' https:\/\/claude\.ai(;|$)/)
    // 'self' is preserved so the same-origin POST still works.
    expect(csp).toContain("form-action 'self'")
  })

  it('form-action uses the redirect origin only (no path/query leakage)', async () => {
    const request = new Request(
      buildAuthorizeUrl({
        response_type: 'code',
        redirect_uri: 'https://claude.com/api/oauth/callback?env=prod',
        code_challenge: 'abc',
        code_challenge_method: 'S256',
        scope: 'mcp',
      })
    )
    const response = await GET(request)
    expect(response.status).toBe(200)

    const csp = response.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toContain('https://claude.com')
    // Origin only — no path, no query string in the source expression.
    expect(csp).not.toContain('/api/oauth/callback')
    expect(csp).not.toContain('env=prod')
  })

  it('renders both read and write rows when client passes only the legacy `mcp` scope marker', async () => {
    // Claude's connector sends scope=mcp today. The consent UI must render
    // every scope group so the user can opt into :write grants — only the
    // :read rows are pre-checked (Art. 25(2) data-protection-by-default).
    // Regression: commit 04c097c2 hid all write rows by clamping the
    // ceiling to DEFAULT_OAUTH_SCOPES.
    const request = new Request(
      buildAuthorizeUrl({
        response_type: 'code',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: 'abc',
        code_challenge_method: 'S256',
        scope: 'mcp',
      })
    )
    const response = await GET(request)
    expect(response.status).toBe(200)
    const html = await response.text()

    // Write scopes must render as checkboxes (un-pre-checked).
    expect(html).toMatch(/value="transactions:write"/)
    expect(html).toMatch(/value="bookkeeping:write"/)
    expect(html).toMatch(/value="invoices:write"/)
    expect(html).toMatch(/value="pending_operations:approve"/)

    // The :write checkbox must NOT be pre-checked when the client passed
    // no explicit scope request — the user has to opt in deliberately.
    const writeRow = html.match(
      /<input[^>]*value="transactions:write"[^>]*>/
    )?.[0]
    expect(writeRow).toBeDefined()
    expect(writeRow!).not.toContain('checked')

    // The :read counterpart must still be pre-checked (safe default).
    const readRow = html.match(
      /<input[^>]*value="transactions:read"[^>]*>/
    )?.[0]
    expect(readRow).toBeDefined()
    expect(readRow!).toContain('checked')
  })

  it('renders only the requested scopes when the client passes them explicitly', async () => {
    // RFC 6749 §3.3 strict least-privilege: an explicit `scope=` shrinks the
    // ceiling, so a client that asked for read-only cannot have a write box
    // surface at consent time.
    const request = new Request(
      buildAuthorizeUrl({
        response_type: 'code',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: 'abc',
        code_challenge_method: 'S256',
        scope: 'transactions:read invoices:read',
      })
    )
    const response = await GET(request)
    expect(response.status).toBe(200)
    const html = await response.text()

    expect(html).toContain('value="transactions:read"')
    expect(html).toContain('value="invoices:read"')
    expect(html).not.toContain('value="transactions:write"')
    expect(html).not.toContain('value="bookkeeping:write"')
  })

  it('rejects disallowed redirect_uri before any CSP would be emitted', async () => {
    mocks.isAllowedRedirectUri.mockResolvedValue(false)
    const request = new Request(
      buildAuthorizeUrl({
        response_type: 'code',
        redirect_uri: 'https://evil.example/cb',
        code_challenge: 'abc',
        code_challenge_method: 'S256',
        scope: 'mcp',
      })
    )
    const response = await GET(request)
    expect(response.status).toBe(400)
    // Important: the form-action whitelist must never be populated from an
    // untrusted origin. A 400 here keeps the allowlist as the single source
    // of truth for which origins can land at this endpoint.
  })
})
