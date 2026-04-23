import { describe, it, expect } from 'vitest'
import {
  AccountsNotInChartError,
  BookkeepingDatabaseError,
  CannotCorrectNonPostedError,
  CannotReverseNonPostedError,
  CurrencyRevaluationAlreadyExistsError,
  EntryAlreadyReversedError,
  EntryDateOutsideFiscalPeriodError,
  FiscalPeriodNotFoundError,
  InvalidMappingResultError,
  JournalEntryNotBalancedError,
  JournalEntryNotFoundError,
  accountsNotInChartResponse,
  bookkeepingErrorResponse,
  isAccountsNotInChartError,
  isBookkeepingError,
} from '../errors'

describe('Typed bookkeeping errors', () => {
  it('AccountsNotInChartError carries sorted, deduped account numbers', () => {
    const err = new AccountsNotInChartError(['2641', '1930', '1930', '1510'])
    expect(err.code).toBe('ACCOUNTS_NOT_IN_CHART')
    expect(err.name).toBe('AccountsNotInChartError')
    expect(err.accountNumbers).toEqual(['1510', '1930', '2641'])
    expect(err).toBeInstanceOf(Error)
  })

  it('JournalEntryNotBalancedError preserves amounts and kind', () => {
    const err = new JournalEntryNotBalancedError(100, 80, 'correction')
    expect(err.code).toBe('JOURNAL_ENTRY_NOT_BALANCED')
    expect(err.totalDebit).toBe(100)
    expect(err.totalCredit).toBe(80)
    expect(err.kind).toBe('correction')
    expect(err.message).toContain('100')
    expect(err.message).toContain('80')
  })

  it('JournalEntryNotBalancedError defaults kind to "draft"', () => {
    const err = new JournalEntryNotBalancedError(100, 80)
    expect(err.kind).toBe('draft')
  })

  it('FiscalPeriodNotFoundError has fixed message', () => {
    const err = new FiscalPeriodNotFoundError()
    expect(err.code).toBe('FISCAL_PERIOD_NOT_FOUND')
    expect(err.message).toBe('Fiscal period not found')
  })

  it('EntryDateOutsideFiscalPeriodError carries period context', () => {
    const err = new EntryDateOutsideFiscalPeriodError('2024-06-15', 'FY 2025', '2025-01-01', '2025-12-31')
    expect(err.code).toBe('ENTRY_DATE_OUTSIDE_FISCAL_PERIOD')
    expect(err.entryDate).toBe('2024-06-15')
    expect(err.periodName).toBe('FY 2025')
    expect(err.periodStart).toBe('2025-01-01')
    expect(err.periodEnd).toBe('2025-12-31')
  })

  it('JournalEntryNotFoundError has fixed message', () => {
    const err = new JournalEntryNotFoundError()
    expect(err.code).toBe('JOURNAL_ENTRY_NOT_FOUND')
    expect(err.message).toBe('Journal entry not found')
  })

  it('CannotReverseNonPostedError carries current status', () => {
    const err = new CannotReverseNonPostedError('draft')
    expect(err.code).toBe('CANNOT_REVERSE_NON_POSTED')
    expect(err.currentStatus).toBe('draft')
  })

  it('CannotCorrectNonPostedError carries current status', () => {
    const err = new CannotCorrectNonPostedError('reversed')
    expect(err.code).toBe('CANNOT_CORRECT_NON_POSTED')
    expect(err.currentStatus).toBe('reversed')
  })

  it('EntryAlreadyReversedError has fixed message', () => {
    const err = new EntryAlreadyReversedError()
    expect(err.code).toBe('ENTRY_ALREADY_REVERSED')
  })

  it('CurrencyRevaluationAlreadyExistsError has fixed message', () => {
    const err = new CurrencyRevaluationAlreadyExistsError()
    expect(err.code).toBe('CURRENCY_REVALUATION_ALREADY_EXISTS')
  })

  it('InvalidMappingResultError carries mapping details', () => {
    const err = new InvalidMappingResultError(null, '3001')
    expect(err.code).toBe('INVALID_MAPPING_RESULT')
    expect(err.debitAccount).toBeNull()
    expect(err.creditAccount).toBe('3001')
  })

  it('BookkeepingDatabaseError carries operation tag and cause', () => {
    const err = new BookkeepingDatabaseError('commit_entry', 'constraint violation')
    expect(err.code).toBe('BOOKKEEPING_DATABASE_ERROR')
    expect(err.operation).toBe('commit_entry')
    expect(err.cause).toBe('constraint violation')
    expect(err.message).toContain('commit_entry')
    expect(err.message).toContain('constraint violation')
  })

  it('BookkeepingDatabaseError handles undefined cause', () => {
    const err = new BookkeepingDatabaseError('commit_entry', undefined)
    expect(err.message).toContain('commit_entry')
    expect(err.message).not.toContain('undefined')
  })
})

describe('isAccountsNotInChartError', () => {
  it('returns true for AccountsNotInChartError', () => {
    expect(isAccountsNotInChartError(new AccountsNotInChartError(['1930']))).toBe(true)
  })

  it('returns false for other errors', () => {
    expect(isAccountsNotInChartError(new Error('plain'))).toBe(false)
    expect(isAccountsNotInChartError(new FiscalPeriodNotFoundError())).toBe(false)
    expect(isAccountsNotInChartError(null)).toBe(false)
    expect(isAccountsNotInChartError(undefined)).toBe(false)
  })
})

describe('isBookkeepingError', () => {
  it('returns true for all typed bookkeeping errors', () => {
    expect(isBookkeepingError(new AccountsNotInChartError(['1930']))).toBe(true)
    expect(isBookkeepingError(new JournalEntryNotBalancedError(100, 80))).toBe(true)
    expect(isBookkeepingError(new FiscalPeriodNotFoundError())).toBe(true)
    expect(isBookkeepingError(new EntryDateOutsideFiscalPeriodError('2024-06-15', 'FY', '2025-01-01', '2025-12-31'))).toBe(true)
    expect(isBookkeepingError(new JournalEntryNotFoundError())).toBe(true)
    expect(isBookkeepingError(new CannotReverseNonPostedError('draft'))).toBe(true)
    expect(isBookkeepingError(new CannotCorrectNonPostedError('draft'))).toBe(true)
    expect(isBookkeepingError(new EntryAlreadyReversedError())).toBe(true)
    expect(isBookkeepingError(new CurrencyRevaluationAlreadyExistsError())).toBe(true)
    expect(isBookkeepingError(new InvalidMappingResultError('1930', '3001'))).toBe(true)
    expect(isBookkeepingError(new BookkeepingDatabaseError('commit_entry', 'x'))).toBe(true)
  })

  it('returns false for plain Error', () => {
    expect(isBookkeepingError(new Error('plain'))).toBe(false)
    expect(isBookkeepingError(null)).toBe(false)
    expect(isBookkeepingError('string')).toBe(false)
  })
})

describe('accountsNotInChartResponse', () => {
  it('returns 400 with Swedish message and account_numbers', async () => {
    const err = new AccountsNotInChartError(['1930', '2641'])
    const response = accountsNotInChartResponse(err)
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe('ACCOUNTS_NOT_IN_CHART')
    expect(body.error.message).toContain('1930')
    expect(body.error.message).toContain('2641')
    expect(body.error.account_numbers).toEqual(['1930', '2641'])
  })
})

describe('bookkeepingErrorResponse', () => {
  it('returns null for plain Error', () => {
    expect(bookkeepingErrorResponse(new Error('plain'))).toBeNull()
    expect(bookkeepingErrorResponse(null)).toBeNull()
    expect(bookkeepingErrorResponse('string')).toBeNull()
  })

  it('returns 400 for AccountsNotInChartError (via accountsNotInChartResponse)', async () => {
    const response = bookkeepingErrorResponse(new AccountsNotInChartError(['1930']))!
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe('ACCOUNTS_NOT_IN_CHART')
    expect(body.error.account_numbers).toEqual(['1930'])
  })

  it('returns 400 for JournalEntryNotBalancedError with totalDebit/totalCredit', async () => {
    const response = bookkeepingErrorResponse(new JournalEntryNotBalancedError(100, 80, 'draft'))!
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe('JOURNAL_ENTRY_NOT_BALANCED')
    expect(body.error.details).toEqual({ totalDebit: 100, totalCredit: 80, kind: 'draft' })
  })

  it('returns 404 for FiscalPeriodNotFoundError', async () => {
    const response = bookkeepingErrorResponse(new FiscalPeriodNotFoundError())!
    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.error.code).toBe('FISCAL_PERIOD_NOT_FOUND')
  })

  it('returns 400 for EntryDateOutsideFiscalPeriodError with period details', async () => {
    const response = bookkeepingErrorResponse(
      new EntryDateOutsideFiscalPeriodError('2024-06-15', 'FY 2025', '2025-01-01', '2025-12-31')
    )!
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe('ENTRY_DATE_OUTSIDE_FISCAL_PERIOD')
    expect(body.error.details).toEqual({
      entryDate: '2024-06-15',
      periodName: 'FY 2025',
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
    })
  })

  it('returns 404 for JournalEntryNotFoundError', async () => {
    const response = bookkeepingErrorResponse(new JournalEntryNotFoundError())!
    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.error.code).toBe('JOURNAL_ENTRY_NOT_FOUND')
  })

  it('returns 400 for CannotReverseNonPostedError with currentStatus', async () => {
    const response = bookkeepingErrorResponse(new CannotReverseNonPostedError('draft'))!
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe('CANNOT_REVERSE_NON_POSTED')
    expect(body.error.details).toEqual({ currentStatus: 'draft' })
  })

  it('returns 400 for CannotCorrectNonPostedError with currentStatus', async () => {
    const response = bookkeepingErrorResponse(new CannotCorrectNonPostedError('reversed'))!
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe('CANNOT_CORRECT_NON_POSTED')
    expect(body.error.details).toEqual({ currentStatus: 'reversed' })
  })

  it('returns 409 for EntryAlreadyReversedError (concurrent conflict)', async () => {
    const response = bookkeepingErrorResponse(new EntryAlreadyReversedError())!
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error.code).toBe('ENTRY_ALREADY_REVERSED')
  })

  it('returns 409 for CurrencyRevaluationAlreadyExistsError (duplicate)', async () => {
    const response = bookkeepingErrorResponse(new CurrencyRevaluationAlreadyExistsError())!
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error.code).toBe('CURRENCY_REVALUATION_ALREADY_EXISTS')
  })

  it('returns 400 for InvalidMappingResultError with mapping details', async () => {
    const response = bookkeepingErrorResponse(new InvalidMappingResultError(null, '3001'))!
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe('INVALID_MAPPING_RESULT')
    expect(body.error.details).toEqual({ debitAccount: null, creditAccount: '3001' })
  })

  it('returns 500 for BookkeepingDatabaseError with operation tag', async () => {
    const response = bookkeepingErrorResponse(
      new BookkeepingDatabaseError('commit_entry', 'constraint violation')
    )!
    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.error.code).toBe('BOOKKEEPING_DATABASE_ERROR')
    expect(body.error.details).toEqual({ operation: 'commit_entry' })
    expect(body.error.message).toContain('constraint violation')
  })
})
