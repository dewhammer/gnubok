import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}))

import {
  generateApiKey,
  hashApiKey,
  extractBearerToken,
  validateScopes,
  hasScope,
  validateApiKey,
  DEFAULT_SCOPES,
} from '../api-keys'
import { createClient } from '@supabase/supabase-js'

const mockCreateClient = vi.mocked(createClient)

beforeEach(() => {
  vi.clearAllMocks()
})

// ============================================================
// generateApiKey
// ============================================================

describe('generateApiKey', () => {
  it('returns key starting with "gnubok_sk_"', () => {
    const { key } = generateApiKey()
    expect(key.startsWith('gnubok_sk_')).toBe(true)
  })

  it('returns 64-char hex SHA-256 hash', () => {
    const { hash } = generateApiKey()
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns prefix of KEY_PREFIX + 8 chars', () => {
    const { key, prefix } = generateApiKey()
    expect(prefix).toBe(key.slice(0, 'gnubok_sk_'.length + 8))
  })

  it('generates unique keys on successive calls', () => {
    const a = generateApiKey()
    const b = generateApiKey()
    expect(a.key).not.toBe(b.key)
    expect(a.hash).not.toBe(b.hash)
  })

  it('hash matches hashApiKey(key)', () => {
    const { key, hash } = generateApiKey()
    expect(hashApiKey(key)).toBe(hash)
  })
})

// ============================================================
// hashApiKey
// ============================================================

describe('hashApiKey', () => {
  it('returns 64-char hex string', () => {
    const hash = hashApiKey('gnubok_sk_test-key')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic for same input', () => {
    const hash1 = hashApiKey('gnubok_sk_deterministic')
    const hash2 = hashApiKey('gnubok_sk_deterministic')
    expect(hash1).toBe(hash2)
  })

  it('produces different hashes for different inputs', () => {
    const hash1 = hashApiKey('gnubok_sk_key-a')
    const hash2 = hashApiKey('gnubok_sk_key-b')
    expect(hash1).not.toBe(hash2)
  })
})

// ============================================================
// extractBearerToken
// ============================================================

describe('extractBearerToken', () => {
  it('extracts token from valid Bearer header', () => {
    const request = new Request('http://localhost', {
      headers: { authorization: 'Bearer my-secret-token' },
    })
    expect(extractBearerToken(request)).toBe('my-secret-token')
  })

  it('returns null when no authorization header', () => {
    const request = new Request('http://localhost')
    expect(extractBearerToken(request)).toBeNull()
  })

  it('returns null when header is not Bearer scheme', () => {
    const request = new Request('http://localhost', {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    })
    expect(extractBearerToken(request)).toBeNull()
  })

  it('handles token with special characters', () => {
    const request = new Request('http://localhost', {
      headers: { authorization: 'Bearer gnubok_sk_abc+def/ghi=jkl' },
    })
    expect(extractBearerToken(request)).toBe('gnubok_sk_abc+def/ghi=jkl')
  })
})

// ============================================================
// validateScopes
// ============================================================

describe('validateScopes', () => {
  it('returns null for null input', () => {
    expect(validateScopes(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(validateScopes(undefined)).toBeNull()
  })

  it('returns null for non-array input', () => {
    expect(validateScopes('transactions:read')).toBeNull()
    expect(validateScopes(42)).toBeNull()
    expect(validateScopes({ scope: 'transactions:read' })).toBeNull()
  })

  it('filters to only valid API_KEY_SCOPES', () => {
    const result = validateScopes(['transactions:read', 'invalid:scope', 'reports:read'])
    expect(result).toEqual(['transactions:read', 'reports:read'])
  })

  it('returns null when no valid scopes remain after filter', () => {
    expect(validateScopes(['invalid:scope', 'also:invalid'])).toBeNull()
  })

  it('preserves valid scopes from mixed input', () => {
    const result = validateScopes(['customers:write', 'bogus', 'invoices:read'])
    expect(result).toEqual(['customers:write', 'invoices:read'])
  })
})

// ============================================================
// hasScope
// ============================================================

describe('hasScope', () => {
  it('returns true when scope present in array', () => {
    expect(hasScope(['transactions:read', 'reports:read'], 'transactions:read')).toBe(true)
  })

  it('returns false when scope absent', () => {
    expect(hasScope(['transactions:read', 'reports:read'], 'invoices:write')).toBe(false)
  })
})

// ============================================================
// validateApiKey
// ============================================================

describe('validateApiKey', () => {
  function setupMockRpc(response: { data: unknown; error: unknown }) {
    const mockRpc = vi.fn().mockResolvedValue(response)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockReturnValue({ rpc: mockRpc } as any)
  }

  it('rejects keys not starting with "gnubok_sk_"', async () => {
    const result = await validateApiKey('invalid-key-format')
    expect(result).toEqual({ error: 'Invalid API key format', status: 401 })
  })

  it('rejects a refresh token presented as Bearer with a specific message', async () => {
    const result = await validateApiKey('gnubok_rt_some_refresh_token')
    expect('status' in result && result.status).toBe(401)
    expect('error' in result && result.error).toContain('Refresh token')
  })

  it('rejects when RPC returns error', async () => {
    setupMockRpc({ data: null, error: { message: 'db error' } })

    const result = await validateApiKey('gnubok_sk_test-key-value')
    expect(result).toEqual({ error: 'Invalid API key', status: 401 })
  })

  it('rejects when RPC returns empty data array', async () => {
    setupMockRpc({ data: [], error: null })

    const result = await validateApiKey('gnubok_sk_test-key-value')
    expect(result).toEqual({ error: 'Invalid API key', status: 401 })
  })

  it('returns rate limit error when rate_limited is true', async () => {
    setupMockRpc({
      data: [{ user_id: 'u1', company_id: 'c1', scopes: null, rate_limited: true }],
      error: null,
    })

    const result = await validateApiKey('gnubok_sk_test-key-value')
    expect(result).toEqual({ error: 'Rate limit exceeded', status: 429 })
  })

  it('returns userId, companyId, scopes on success', async () => {
    setupMockRpc({
      data: [{
        user_id: 'user-123',
        company_id: 'company-456',
        scopes: ['transactions:read', 'reports:read'],
        rate_limited: false,
      }],
      error: null,
    })

    const result = await validateApiKey('gnubok_sk_test-key-value')
    expect(result).toEqual({
      userId: 'user-123',
      companyId: 'company-456',
      apiKeyId: undefined,
      apiKeyName: undefined,
      scopes: ['transactions:read', 'reports:read'],
      mode: 'live',
    })
  })

  it('falls back to DEFAULT_SCOPES when row.scopes is null', async () => {
    setupMockRpc({
      data: [{
        user_id: 'user-123',
        company_id: 'company-456',
        scopes: null,
        rate_limited: false,
      }],
      error: null,
    })

    const result = await validateApiKey('gnubok_sk_test-key-value')
    expect(result).toEqual({
      userId: 'user-123',
      companyId: 'company-456',
      apiKeyId: undefined,
      apiKeyName: undefined,
      scopes: DEFAULT_SCOPES,
      mode: 'live',
    })
  })

  it('surfaces mode from the RPC row', async () => {
    setupMockRpc({
      data: [{
        user_id: 'user-123',
        company_id: 'company-456',
        api_key_id: 'ak_1',
        api_key_name: 'CI test key',
        scopes: ['transactions:read'],
        rate_limited: false,
        mode: 'test',
      }],
      error: null,
    })

    const result = await validateApiKey('gnubok_sk_test-key-value')
    expect(result).toEqual({
      userId: 'user-123',
      companyId: 'company-456',
      apiKeyId: 'ak_1',
      apiKeyName: 'CI test key',
      scopes: ['transactions:read'],
      mode: 'test',
    })
  })
})
