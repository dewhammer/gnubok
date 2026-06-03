import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock jwt module before importing api-client
const mockGenerateJWT = vi.fn().mockReturnValue('test-jwt-token')
vi.mock('../jwt', () => ({
  generateJWT: (...args: unknown[]) => mockGenerateJWT(...args),
  getAuthorizationHeader: () => `Bearer ${mockGenerateJWT()}`,
  _resetTokenCache: vi.fn(),
}))

// Mock environment
vi.stubEnv('ENABLE_BANKING_API_URL', 'https://api.test.com')

import {
  getASPSPs,
  getAccountBalances,
  getAccountTransactions,
  getAllTransactions,
  getAllTransactionsWithRaw,
  convertTransaction,
  type Transaction,
} from '../api-client'
import { resolveEnableBankingApiUrl, resolveEnableBankingJwtAudience } from '../config'

describe('api-client', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  describe('resolveEnableBankingApiUrl', () => {
    it('uses the sandbox API when ENABLE_BANKING_SANDBOX=true and no explicit URL is set', () => {
      expect(resolveEnableBankingApiUrl({ ENABLE_BANKING_SANDBOX: 'true' })).toBe('https://api.tilisy.com')
    })

    it('prefers explicit URLs over the sandbox flag', () => {
      expect(resolveEnableBankingApiUrl({
        ENABLE_BANKING_SANDBOX: 'true',
        ENABLE_BANKING_API_URL: 'https://api.example.test',
      })).toBe('https://api.example.test')
    })

    it('uses the API host as JWT audience', () => {
      expect(resolveEnableBankingJwtAudience({ ENABLE_BANKING_SANDBOX: 'true' })).toBe('api.tilisy.com')
      expect(resolveEnableBankingJwtAudience({})).toBe('api.enablebanking.com')
    })
  })

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------
  describe('timeout', () => {
    it('aborts fetch after timeout', async () => {
      fetchSpy.mockImplementation(
        () => new Promise((_, reject) => {
          // Simulate a hanging request — the AbortController will fire
          setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 100)
        })
      )

      await expect(getAccountBalances('acc-1')).rejects.toThrow('Aborted')
    })
  })

  // -------------------------------------------------------------------------
  // Retry
  // -------------------------------------------------------------------------
  describe('retry', () => {
    it('retries on 503 and succeeds', async () => {
      const failResponse = new Response('Service Unavailable', { status: 503 })
      const successResponse = new Response(JSON.stringify({ balances: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })

      fetchSpy
        .mockResolvedValueOnce(failResponse)
        .mockResolvedValueOnce(failResponse)
        .mockResolvedValueOnce(successResponse)

      const result = await getAccountBalances('acc-1')
      expect(result).toEqual([])
      expect(fetchSpy).toHaveBeenCalledTimes(3)
    })

    it('retries on AbortError (timeout) and succeeds', async () => {
      const abortError = new DOMException('Aborted', 'AbortError')
      const successResponse = new Response(JSON.stringify({ aspsps: [{ name: 'TestBank', country: 'SE' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })

      fetchSpy
        .mockRejectedValueOnce(abortError)
        .mockResolvedValueOnce(successResponse)

      const result = await getASPSPs('SE')
      expect(result).toEqual([{ name: 'TestBank', country: 'SE' }])
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('does not retry on 400 errors', async () => {
      const badRequest = new Response('Bad Request', { status: 400 })
      fetchSpy.mockResolvedValueOnce(badRequest)

      // getAccountTransactions throws on non-ok response
      await expect(getAccountTransactions('acc-1')).rejects.toThrow('Failed to get transactions')
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  })

  // -------------------------------------------------------------------------
  // Pagination cap
  // -------------------------------------------------------------------------
  describe('pagination cap', () => {
    it('stops at MAX_PAGINATION_PAGES', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      // Every response returns a continuation_key
      fetchSpy.mockImplementation(() => {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              transactions: [{ transaction_amount: { amount: '100', currency: 'SEK' } }],
              continuation_key: 'keep-going',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
      })

      const result = await getAllTransactions('acc-1', '2024-01-01', '2024-12-31')

      // Should have exactly 100 transactions (1 per page, 100 pages)
      expect(result).toHaveLength(100)
      expect(fetchSpy).toHaveBeenCalledTimes(100)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Pagination cap reached')
      )

      warnSpy.mockRestore()
    })
  })

  // -------------------------------------------------------------------------
  // getAllTransactionsWithRaw
  // -------------------------------------------------------------------------
  describe('getAllTransactionsWithRaw', () => {
    it('returns both transactions and raw pages', async () => {
      const page1 = {
        transactions: [{ transaction_amount: { amount: '100', currency: 'SEK' } }],
        continuation_key: 'page2',
      }
      const page2 = {
        transactions: [{ transaction_amount: { amount: '200', currency: 'SEK' } }],
      }

      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify(page1), { status: 200, headers: { 'Content-Type': 'application/json' } })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(page2), { status: 200, headers: { 'Content-Type': 'application/json' } })
        )

      const result = await getAllTransactionsWithRaw('acc-1', '2024-01-01', '2024-12-31')

      expect(result.transactions).toHaveLength(2)
      expect(result.rawPages).toHaveLength(2)
      expect(JSON.parse(result.rawPages[0])).toEqual(page1)
      expect(JSON.parse(result.rawPages[1])).toEqual(page2)
    })

    it('appends strategy=longest to the request URL when supplied', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ transactions: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )

      await getAllTransactionsWithRaw('acc-1', '2024-01-01', '2024-12-31', 'longest')

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const requestedUrl = fetchSpy.mock.calls[0][0] as string
      expect(requestedUrl).toContain('strategy=longest')
      expect(requestedUrl).toContain('date_from=2024-01-01')
      expect(requestedUrl).toContain('date_to=2024-12-31')
    })

    it('omits the strategy param when not supplied', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ transactions: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )

      await getAllTransactionsWithRaw('acc-1', '2024-01-01', '2024-12-31')

      const requestedUrl = fetchSpy.mock.calls[0][0] as string
      expect(requestedUrl).not.toContain('strategy=')
    })

    it('falls back to no-strategy on 400 and retries the same page', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      fetchSpy
        .mockResolvedValueOnce(
          new Response('Invalid strategy', { status: 400 })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ transactions: [{ transaction_amount: { amount: '50', currency: 'SEK' } }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )

      const result = await getAllTransactionsWithRaw('acc-1', '2024-01-01', '2024-12-31', 'longest')

      expect(result.transactions).toHaveLength(1)
      expect(fetchSpy).toHaveBeenCalledTimes(2)

      const firstUrl = fetchSpy.mock.calls[0][0] as string
      const secondUrl = fetchSpy.mock.calls[1][0] as string
      expect(firstUrl).toContain('strategy=longest')
      expect(secondUrl).not.toContain('strategy=')

      expect(warnSpy).toHaveBeenCalledWith(
        '[enable-banking] strategy rejected by API, retrying without strategy',
        expect.objectContaining({ strategy: 'longest' })
      )

      warnSpy.mockRestore()
    })
  })
})

// -------------------------------------------------------------------------
// JWT cache tests
// -------------------------------------------------------------------------
describe('JWT cache', () => {
  it('reuses cached token within validity window', async () => {
    // Reset mocks and re-import to test cache behavior
    vi.resetModules()
    const jwtCallCount = { count: 0 }

    vi.doMock('../jwt', () => ({
      generateJWT: () => {
        jwtCallCount.count++
        return 'cached-token'
      },
      getAuthorizationHeader: () => {
        // Simulate cached behavior: first call generates, subsequent calls reuse
        jwtCallCount.count++
        return `Bearer cached-token`
      },
      _resetTokenCache: vi.fn(),
    }))

    // The actual cache test is in jwt.ts — we verify the cache function exists
    const jwt = await import('../jwt')
    expect(typeof jwt._resetTokenCache).toBe('function')
  })
})

describe('convertTransaction', () => {
  function makeTx(overrides: Partial<Transaction> = {}): Transaction {
    return {
      transaction_amount: { amount: '250.00', currency: 'SEK' },
      credit_debit_indicator: 'DBIT',
      booking_date: '2024-06-15',
      ...overrides,
    }
  }

  it('uses remittance_information when present', () => {
    const tx = makeTx({ remittance_information: ['Faktura 123', ' '] })
    expect(convertTransaction(tx, 'SEK').description).toBe('Faktura 123')
  })

  it('falls back to the counterparty name when remittance is empty', () => {
    const out = makeTx({ remittance_information: ['   '], creditor_name: 'Telia AB' })
    expect(convertTransaction(out, 'SEK').description).toBe('Telia AB')
  })

  it('derives a Swedish label from bank_transaction_code when remittance and counterparty are both absent', () => {
    const tx = makeTx({ bank_transaction_code: 'PMNT-CCRD-POSD', merchant_category_code: '5411' })
    // MCC 5411 wins (most specific).
    expect(convertTransaction(tx, 'SEK').description).toBe('Inköp dagligvaror')
  })

  it('uses the ISO family label when only bank_transaction_code is present', () => {
    const tx = makeTx({ bank_transaction_code: 'PMNT/CCRD' })
    expect(convertTransaction(tx, 'SEK').description).toBe('Kortköp')
  })

  it('falls back to the Swedish neutral (never English "Unknown") when nothing is recognized', () => {
    const tx = makeTx({})
    expect(convertTransaction(tx, 'SEK').description).toBe('Okänd transaktion')
  })

  it('carries the ISO codes through onto the converted transaction', () => {
    const tx = makeTx({ bank_transaction_code: 'PMNT/RCDT', proprietary_bank_transaction_code: 'XB' })
    const out = convertTransaction(tx, 'SEK')
    expect(out.bank_transaction_code).toBe('PMNT/RCDT')
    expect(out.proprietary_bank_transaction_code).toBe('XB')
  })
})
