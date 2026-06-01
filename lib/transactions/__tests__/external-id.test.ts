import { describe, it, expect } from 'vitest'
import {
  amountToOre,
  buildStableExternalIds,
  contentDedupKey,
  normalizeImportedDescription,
  FALLBACK_DESCRIPTION,
} from '../external-id'

describe('amountToOre', () => {
  it('normalizes a JS number to integer öre', () => {
    expect(amountToOre(1234.5)).toBe(123450)
    expect(amountToOre(-250)).toBe(-25000)
    expect(amountToOre(0)).toBe(0)
  })

  it('normalizes a numeric string (PostgREST representation) to the same öre', () => {
    // The core fix: a DB-fetched numeric string and a raw JS number for the
    // same amount must collapse to the same integer.
    expect(amountToOre('1234.50')).toBe(123450)
    expect(amountToOre('1234.5')).toBe(amountToOre(1234.5))
    expect(amountToOre('-250.00')).toBe(amountToOre(-250))
    expect(amountToOre('100')).toBe(10000)
  })

  it('rounds sub-öre noise deterministically (never toFixed)', () => {
    expect(amountToOre(0.1 + 0.2)).toBe(30) // 0.30000000000000004 → 30
    expect(amountToOre(19.995)).toBe(2000)
  })
})

describe('buildStableExternalIds', () => {
  it('derives the id from account + date + öre, not from any bank id', () => {
    const ids = buildStableExternalIds('eb', 'SE123', [{ date: '2024-06-15', amount: -500 }])
    expect(ids).toEqual(['eb_SE123_2024-06-15_-50000_0'])
  })

  it('disambiguates genuinely identical transactions with an occurrence index', () => {
    const ids = buildStableExternalIds('eb', 'acc', [
      { date: '2024-06-15', amount: -250 },
      { date: '2024-06-15', amount: -250 },
      { date: '2024-06-15', amount: -250 },
    ])
    expect(ids).toEqual([
      'eb_acc_2024-06-15_-25000_0',
      'eb_acc_2024-06-15_-25000_1',
      'eb_acc_2024-06-15_-25000_2',
    ])
  })

  it('produces the SAME set of ids regardless of provider ordering (re-sync dedupe)', () => {
    const a = buildStableExternalIds('eb', 'acc', [
      { date: '2024-06-15', amount: -250 },
      { date: '2024-06-16', amount: -100 },
      { date: '2024-06-15', amount: -250 },
    ])
    // Same transactions, different order on a later sync.
    const b = buildStableExternalIds('eb', 'acc', [
      { date: '2024-06-15', amount: -250 },
      { date: '2024-06-15', amount: -250 },
      { date: '2024-06-16', amount: -100 },
    ])
    expect(new Set(a)).toEqual(new Set(b))
  })

  it('treats string and number amounts as the same id (provider type drift)', () => {
    const num = buildStableExternalIds('eb', 'acc', [{ date: '2024-06-15', amount: 1234.5 }])
    const str = buildStableExternalIds('eb', 'acc', [{ date: '2024-06-15', amount: '1234.50' }])
    expect(num).toEqual(str)
  })

  it('keeps distinct amounts and dates on separate occurrence counters', () => {
    const ids = buildStableExternalIds('eb', 'acc', [
      { date: '2024-06-15', amount: -250 },
      { date: '2024-06-15', amount: -100 },
      { date: '2024-06-16', amount: -250 },
      { date: '2024-06-15', amount: -250 },
    ])
    expect(ids).toEqual([
      'eb_acc_2024-06-15_-25000_0',
      'eb_acc_2024-06-15_-10000_0',
      'eb_acc_2024-06-16_-25000_0',
      'eb_acc_2024-06-15_-25000_1',
    ])
  })

  it('returns an empty array for an empty batch', () => {
    expect(buildStableExternalIds('eb', 'acc', [])).toEqual([])
  })
})

describe('contentDedupKey', () => {
  it('matches a JS number against a PostgREST numeric string for the same amount', () => {
    // The core dedup-bridge fix: an incoming raw number and a DB-fetched string
    // for the same amount + date + description must produce the SAME key.
    const incoming = contentDedupKey('2024-06-15', -250, 'ICA Maxi Solna')
    const stored = contentDedupKey('2024-06-15', '-250.00', 'ICA Maxi Solna')
    expect(incoming).toBe(stored)
  })

  it('normalizes description (lowercase, trim, 24-char prefix)', () => {
    expect(contentDedupKey('2024-06-15', -100, '  ICA Maxi Solna  '))
      .toBe(contentDedupKey('2024-06-15', -100, 'ica maxi solna'))
    // Differs only past the 24-char prefix → same key.
    expect(contentDedupKey('2024-06-15', -100, 'Betalning till leverantör AAA'))
      .toBe(contentDedupKey('2024-06-15', -100, 'Betalning till leverantör BBB'))
  })

  it('keeps distinct transactions apart when description differs in the prefix', () => {
    expect(contentDedupKey('2024-06-15', -250, 'ICA Maxi'))
      .not.toBe(contentDedupKey('2024-06-15', -250, 'Coop Stockholm'))
  })

  it('treats a null/undefined description as an empty prefix', () => {
    expect(contentDedupKey('2024-06-15', -100, null))
      .toBe(contentDedupKey('2024-06-15', -100, undefined))
    expect(contentDedupKey('2024-06-15', -100, null))
      .toBe(contentDedupKey('2024-06-15', -100, ''))
  })
})

describe('normalizeImportedDescription', () => {
  it('maps empty / whitespace-only titles to the Swedish neutral', () => {
    expect(normalizeImportedDescription('')).toBe(FALLBACK_DESCRIPTION)
    expect(normalizeImportedDescription('   ')).toBe(FALLBACK_DESCRIPTION)
    expect(normalizeImportedDescription(null)).toBe(FALLBACK_DESCRIPTION)
    expect(normalizeImportedDescription(undefined)).toBe(FALLBACK_DESCRIPTION)
  })

  it('maps the legacy English "Unknown" sentinel to the Swedish neutral (case-insensitive)', () => {
    expect(normalizeImportedDescription('Unknown')).toBe(FALLBACK_DESCRIPTION)
    expect(normalizeImportedDescription('unknown')).toBe(FALLBACK_DESCRIPTION)
    expect(normalizeImportedDescription('  UNKNOWN  ')).toBe(FALLBACK_DESCRIPTION)
  })

  it('preserves a real title and trims surrounding whitespace', () => {
    expect(normalizeImportedDescription('ICA Maxi Solna')).toBe('ICA Maxi Solna')
    expect(normalizeImportedDescription('  Lön juni  ')).toBe('Lön juni')
  })

  it('does NOT clobber a real title that merely contains the word "unknown"', () => {
    expect(normalizeImportedDescription('Unknown Pizza AB')).toBe('Unknown Pizza AB')
  })
})
