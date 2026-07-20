import { describe, it, expect } from 'vitest'
import { buildCustomerUpdateData, normalizeOptionalText } from '../build-update-data'

describe('normalizeOptionalText', () => {
  it('turns blank strings into null', () => {
    expect(normalizeOptionalText('')).toBeNull()
    expect(normalizeOptionalText('   ')).toBeNull()
  })

  it('trims non-empty values', () => {
    expect(normalizeOptionalText('  hello@example.com  ')).toBe('hello@example.com')
  })
})

describe('buildCustomerUpdateData', () => {
  it('stores cleared email as null instead of empty string', () => {
    const update = buildCustomerUpdateData({ email: '' })
    expect(update.email).toBeNull()
  })

  it('clears personal_number when blank', () => {
    const update = buildCustomerUpdateData({ personal_number: '' })
    expect(update.personal_number).toBeNull()
  })

  it('includes personal_number when provided', () => {
    const update = buildCustomerUpdateData({ personal_number: '850101-1234' })
    expect(update.personal_number).toBe('850101-1234')
  })
})
