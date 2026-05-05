import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractInvoiceFields } from '@/extensions/general/invoice-inbox/lib/extract-invoice-fields'

// Mock pdfjs-dist so we can drive the regex extractors with canned text
// without building actual PDF binaries.
const mockGetDocument = vi.fn()

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: (...args: unknown[]) => mockGetDocument(...args),
}))

function fakePdf(text: string) {
  return {
    promise: Promise.resolve({
      numPages: 1,
      getPage: () =>
        Promise.resolve({
          getTextContent: () =>
            Promise.resolve({
              items: text.split(/\s+/).map((str) => ({ str })),
            }),
        }),
    }),
  }
}

describe('extractInvoiceFields', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty result for non-PDF mime type', async () => {
    const { data, rawText } = await extractInvoiceFields({
      buffer: Buffer.from(''),
      mimeType: 'image/png',
      fileName: 'foo.png',
    })
    expect(rawText).toBeNull()
    expect(data.totals.total).toBeNull()
    expect(data.supplier.orgNumber).toBeNull()
  })

  it('returns empty result when pdfjs extracts no text (image-only PDF)', async () => {
    mockGetDocument.mockReturnValueOnce(fakePdf(''))
    const { data, rawText } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'scan.pdf',
    })
    expect(rawText).toBe('')
    expect(data.totals.total).toBeNull()
  })

  it('extracts a Luhn-valid org number', async () => {
    // 5560125790 is a valid Swedish AB org-nr (Luhn-checked)
    mockGetDocument.mockReturnValueOnce(fakePdf('Lev: Acme AB Org.nr 556012-5790 Faktura'))
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'f.pdf',
    })
    expect(data.supplier.orgNumber).toBe('5560125790')
  })

  it('rejects org-nrs with bad Luhn digit', async () => {
    mockGetDocument.mockReturnValueOnce(fakePdf('Org.nr 556012-5791'))
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'f.pdf',
    })
    expect(data.supplier.orgNumber).toBeNull()
  })

  it('extracts a Luhn-valid OCR reference', async () => {
    mockGetDocument.mockReturnValueOnce(fakePdf('OCR-nummer: 12345674'))
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'f.pdf',
    })
    expect(data.invoice.paymentReference).toBe('12345674')
  })

  it('extracts a Luhn-valid bankgiro', async () => {
    // 991-2346 is the canonical test bankgiro (Luhn-valid) used in lib/bankgiro/__tests__
    mockGetDocument.mockReturnValueOnce(fakePdf('Bankgiro 991-2346 Plusgiro'))
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'f.pdf',
    })
    expect(data.supplier.bankgiro).toBe('991-2346')
  })

  it('parses Swedish-formatted totals', async () => {
    mockGetDocument.mockReturnValueOnce(
      fakePdf('Att betala 12 345,67 kr')
    )
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'f.pdf',
    })
    expect(data.totals.total).toBe(12345.67)
  })

  it('parses Förfallodatum and normalizes to ISO', async () => {
    mockGetDocument.mockReturnValueOnce(fakePdf('Förfallodatum 2026-06-15'))
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'f.pdf',
    })
    expect(data.invoice.dueDate).toBe('2026-06-15')
  })

  it('extracts an invoice number after Fakturanr', async () => {
    mockGetDocument.mockReturnValueOnce(fakePdf('Fakturanr F-2024-001 Datum'))
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'f.pdf',
    })
    expect(data.invoice.invoiceNumber).toBe('F-2024-001')
  })

  it('keeps SEK as default currency when no foreign code is present', async () => {
    mockGetDocument.mockReturnValueOnce(fakePdf('Total 100 kr'))
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'f.pdf',
    })
    expect(data.invoice.currency).toBe('SEK')
  })

  it('returns empty result when pdfjs throws', async () => {
    mockGetDocument.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const { data, rawText } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'f.pdf',
    })
    expect(rawText).toBeNull()
    expect(data.totals.total).toBeNull()
  })
})
