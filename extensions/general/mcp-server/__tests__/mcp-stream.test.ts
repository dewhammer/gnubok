import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    extractBearerToken: vi.fn(),
    validateApiKey: vi.fn(),
  }
})

import { extractBearerToken, validateApiKey } from '@/lib/auth/api-keys'
import { handleMcpGetRequest } from '../server'

describe('MCP streamable HTTP GET /mcp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when Authorization header is missing', async () => {
    vi.mocked(extractBearerToken).mockReturnValue(null)

    const res = await handleMcpGetRequest(
      new Request('http://localhost/mcp', {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
      })
    )

    expect(res.status).toBe(401)
    expect(validateApiKey).not.toHaveBeenCalled()
  })

  it('returns 401 when API key is invalid', async () => {
    vi.mocked(extractBearerToken).mockReturnValue('bad-token')
    vi.mocked(validateApiKey).mockResolvedValue({ error: 'Invalid key', status: 401 })

    const res = await handleMcpGetRequest(
      new Request('http://localhost/mcp', {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          Authorization: 'Bearer bad-token',
        },
      })
    )

    expect(res.status).toBe(401)
  })

  it('returns 405 when Accept is not text/event-stream', async () => {
    vi.mocked(extractBearerToken).mockReturnValue('good-token')
    vi.mocked(validateApiKey).mockResolvedValue({
      userId: 'user-1',
      companyId: 'company-1',
      scopes: ['reports:read'],
      apiKeyId: 'key-1',
      apiKeyName: 'Test',
    })

    const res = await handleMcpGetRequest(
      new Request('http://localhost/mcp', {
        method: 'GET',
        headers: { Authorization: 'Bearer good-token' },
      })
    )

    expect(res.status).toBe(405)
  })

  it('returns SSE stream when authenticated with text/event-stream Accept', async () => {
    vi.mocked(extractBearerToken).mockReturnValue('good-token')
    vi.mocked(validateApiKey).mockResolvedValue({
      userId: 'user-1',
      companyId: 'company-1',
      scopes: ['reports:read'],
      apiKeyId: 'key-1',
      apiKeyName: 'Test',
    })

    const res = await handleMcpGetRequest(
      new Request('http://localhost/mcp', {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          Authorization: 'Bearer good-token',
        },
      })
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')

    const reader = res.body!.getReader()
    const { value } = await reader.read()
    await reader.cancel()
    const body = new TextDecoder().decode(value)
    expect(body).toContain(': connected')
  })
})
