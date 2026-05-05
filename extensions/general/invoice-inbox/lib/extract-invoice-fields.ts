// Deterministic Swedish invoice field extraction.
//
// Replaces the deleted AI classifier. We pull text out of the PDF with
// pdfjs-dist and run regex extractors against it. Each extractor is
// independent — a missing field stays null rather than dragging down a
// neighbour. Validators (Luhn for org-nr/OCR/bankgiro) keep false
// positives near zero.
//
// Image-only PDFs and non-PDF mime types come back with all fields null.
// The inbox item is still created so the user can register manually.

import type { InvoiceExtractionResult } from '@/types'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { validateOcrReference, validateBankgiroNumber } from '@/lib/bankgiro/luhn'

// Below this we treat the document as image-only / unreadable and skip
// regex extraction. pdfjs-dist returns near-zero text for scanned PDFs.
const MIN_TEXT_CHARS_FOR_EXTRACTION = 10

export interface ExtractionInput {
  buffer: Buffer
  mimeType: string
  fileName: string
}

export interface ExtractionOutput {
  data: InvoiceExtractionResult
  /** Pulled from the PDF; null when the file isn't a text-based PDF. */
  rawText: string | null
}

/**
 * Extract invoice fields from a PDF buffer. Returns an InvoiceExtractionResult
 * whether or not anything matched — empty fields are null, lineItems is [],
 * and totals are null. Never throws on parse failure (returns empty result).
 */
export async function extractInvoiceFields(input: ExtractionInput): Promise<ExtractionOutput> {
  const text = await tryExtractPdfText(input)

  if (!text || text.length < MIN_TEXT_CHARS_FOR_EXTRACTION) {
    return { data: emptyResult(), rawText: text }
  }

  const data: InvoiceExtractionResult = {
    supplier: {
      name: extractSupplierName(text),
      orgNumber: extractOrgNumber(text),
      vatNumber: extractVatNumber(text),
      address: null,
      bankgiro: extractBankgiro(text),
      plusgiro: extractPlusgiro(text),
    },
    invoice: {
      invoiceNumber: extractInvoiceNumber(text),
      invoiceDate: extractDate(text, /faktura(?:datum|date)|utfärdat/i),
      dueDate: extractDate(text, /förfallo(?:datum|dag)|due\s*date|betala\s*senast/i),
      paymentReference: extractOcrReference(text),
      currency: extractCurrency(text),
    },
    lineItems: [],
    totals: extractTotals(text),
    vatBreakdown: extractVatBreakdown(text),
    confidence: 0,
  }

  return { data, rawText: text }
}

function emptyResult(): InvoiceExtractionResult {
  return {
    supplier: {
      name: null,
      orgNumber: null,
      vatNumber: null,
      address: null,
      bankgiro: null,
      plusgiro: null,
    },
    invoice: {
      invoiceNumber: null,
      invoiceDate: null,
      dueDate: null,
      paymentReference: null,
      currency: 'SEK',
    },
    lineItems: [],
    totals: { subtotal: null, vatAmount: null, total: null },
    vatBreakdown: [],
    confidence: 0,
  }
}

// ── PDF text extraction ─────────────────────────────────────────────

async function tryExtractPdfText(input: ExtractionInput): Promise<string | null> {
  if (input.mimeType !== 'application/pdf') return null

  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(input.buffer),
      isEvalSupported: false,
      disableFontFace: true,
    })
    const pdf = await loadingTask.promise

    const pages: string[] = []
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      const pageText = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
      pages.push(pageText)
    }
    return pages.join('\n').replace(/[ \t]+/g, ' ').trim()
  } catch (err) {
    console.warn('[invoice-inbox/extract] pdfjs failed:', err instanceof Error ? err.message : err)
    return null
  }
}

// ── Field extractors ────────────────────────────────────────────────

function extractOrgNumber(text: string): string | null {
  const candidates = text.match(/\b\d{6}-?\d{4}\b/g) ?? []
  for (const c of candidates) {
    const normalized = normalizeOrgNumber(c)
    if (normalized) return normalized
  }
  return null
}

function extractVatNumber(text: string): string | null {
  const m = text.match(/\bSE\d{10}\d{2}\b/i)
  return m ? m[0].toUpperCase() : null
}

function extractOcrReference(text: string): string | null {
  // Anchor on "OCR" / "Referens" / "Bet.ref" labels; widen to any digit
  // run on the same logical line if no labelled hit found.
  const labelled = text.match(
    /(?:OCR(?:-?nummer)?|Referens(?:nummer)?|Bet\.?\s*ref\.?|Betalningsreferens)[^\d\n]{0,40}(\d[\d\s]{3,30}\d)/i
  )
  if (labelled) {
    const digits = labelled[1].replace(/\s/g, '')
    if (validateOcrReference(digits)) return digits
  }
  // Fallback: look for any standalone digit run that passes Luhn (4-25 digits)
  const candidates = text.match(/\b\d{4,25}\b/g) ?? []
  for (const c of candidates) {
    if (validateOcrReference(c)) return c
  }
  return null
}

function extractBankgiro(text: string): string | null {
  const labelled = text.match(/Bankgiro(?:nr)?[^\d\n]{0,20}(\d{3,4}-?\d{4})/i)
  if (labelled && validateBankgiroNumber(labelled[1])) {
    return labelled[1].includes('-') ? labelled[1] : insertBankgiroHyphen(labelled[1])
  }
  // Fallback: any 7-8 digit number with hyphen that passes Luhn
  const candidates = text.match(/\b\d{3,4}-\d{4}\b/g) ?? []
  for (const c of candidates) {
    if (validateBankgiroNumber(c)) return c
  }
  return null
}

function insertBankgiroHyphen(digits: string): string {
  if (digits.length === 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`
  if (digits.length === 8) return `${digits.slice(0, 4)}-${digits.slice(4)}`
  return digits
}

function extractPlusgiro(text: string): string | null {
  const m = text.match(/Plusgiro(?:nr)?[^\d\n]{0,20}(\d{1,8}-\d)/i)
  return m ? m[1] : null
}

function extractInvoiceNumber(text: string): string | null {
  const m = text.match(
    /(?:Faktura(?:nr|nummer)?|Invoice\s*(?:no|number|#))[^\w\n]{0,8}([A-Z0-9][A-Z0-9\-/]{2,20})/i
  )
  return m ? m[1].trim() : null
}

function extractDate(text: string, anchor: RegExp): string | null {
  // Look for a date within ~40 chars of the anchor
  const re = new RegExp(
    `(?:${anchor.source})[^\\d\\n]{0,40}(\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4})`,
    'i'
  )
  const m = text.match(re)
  if (!m) return null
  return normalizeDate(m[1])
}

function normalizeDate(raw: string): string | null {
  const sep = raw.match(/[-/.]/)
  if (!sep) return null
  const parts = raw.split(/[-/.]/).map((p) => p.trim())
  if (parts.length !== 3) return null
  let yyyy: string, mm: string, dd: string
  if (parts[0].length === 4) {
    [yyyy, mm, dd] = parts
  } else if (parts[2].length === 4) {
    [dd, mm, yyyy] = parts
  } else {
    return null
  }
  const m = mm.padStart(2, '0')
  const d = dd.padStart(2, '0')
  if (!/^\d{4}$/.test(yyyy) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d)) return null
  // Sanity check
  const month = parseInt(m, 10)
  const day = parseInt(d, 10)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${yyyy}-${m}-${d}`
}

function extractCurrency(text: string): string {
  // Default SEK; only switch if a 3-letter currency code appears with an amount nearby
  const m = text.match(/\b(EUR|USD|GBP|NOK|DKK|CHF)\b/i)
  return m ? m[1].toUpperCase() : 'SEK'
}

function extractTotals(text: string): { subtotal: number | null; vatAmount: number | null; total: number | null } {
  const total = findAmountNear(text, /(?:Att\s*betala|Totalt\s*att\s*betala|Summa\s*att\s*betala|Total(?:summa)?|Belopp\s*att\s*betala)/i)
  const vatAmount = findAmountNear(text, /(?:Total\s*moms|Moms(?:\s*totalt)?|VAT(?:\s*total)?)/i)
  const subtotal = findAmountNear(text, /(?:Netto(?:summa)?|Subtotal|Summa\s*excl(?:\.|usive)?\s*moms|Belopp\s*excl(?:\.|usive)?\s*moms)/i)
  return { subtotal, vatAmount, total }
}

function findAmountNear(text: string, anchor: RegExp): number | null {
  const re = new RegExp(`(?:${anchor.source})[^\\d\\n-]{0,60}([0-9][\\d\\s.,]*[0-9])`, 'i')
  const m = text.match(re)
  if (!m) return null
  return parseSwedishAmount(m[1])
}

function parseSwedishAmount(raw: string): number | null {
  // Swedish uses space as thousands sep and comma as decimal: "1 234,56".
  // Also tolerate "1,234.56" (international) and "1234.56".
  const cleaned = raw.replace(/\s/g, '')
  let normalized: string
  if (/,/.test(cleaned) && /\./.test(cleaned)) {
    // Both present — assume thousands+decimal. Decide by last separator.
    const lastComma = cleaned.lastIndexOf(',')
    const lastDot = cleaned.lastIndexOf('.')
    if (lastComma > lastDot) {
      normalized = cleaned.replace(/\./g, '').replace(',', '.')
    } else {
      normalized = cleaned.replace(/,/g, '')
    }
  } else if (/,/.test(cleaned)) {
    // Only comma — Swedish decimal
    normalized = cleaned.replace(',', '.')
  } else {
    normalized = cleaned
  }
  const n = parseFloat(normalized)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

function extractVatBreakdown(text: string): Array<{ rate: number; base: number; amount: number }> {
  const out: Array<{ rate: number; base: number; amount: number }> = []
  // Match patterns like "Moms 25%  800,00  200,00" or "25% moms 200,00"
  const lineRe = /(?:Moms\s*)?(\d{1,2})\s*%[^\n\d-]{0,30}([0-9][\d\s.,]*[0-9])(?:[^\n\d-]{0,30}([0-9][\d\s.,]*[0-9]))?/gi
  let m: RegExpExecArray | null
  while ((m = lineRe.exec(text)) !== null) {
    const rate = parseInt(m[1], 10)
    if (![25, 12, 6, 0].includes(rate)) continue
    const a = parseSwedishAmount(m[2])
    const b = m[3] ? parseSwedishAmount(m[3]) : null
    if (a == null) continue
    // Two amounts: base then VAT amount. One amount: just VAT, derive base.
    if (b != null) {
      out.push({ rate, base: a, amount: b })
    } else if (rate > 0) {
      const base = Math.round((a / (rate / 100)) * 100) / 100
      out.push({ rate, base, amount: a })
    }
  }
  // Dedup by rate (keep first hit)
  const seen = new Set<number>()
  return out.filter((row) => {
    if (seen.has(row.rate)) return false
    seen.add(row.rate)
    return true
  })
}

function extractSupplierName(text: string): string | null {
  // Heuristic: first non-blank, non-numeric line in the first 500 chars,
  // skipping obvious header words.
  const head = text.slice(0, 500)
  const lines = head.split(/\n|(?:\s{4,})/).map((l) => l.trim()).filter(Boolean)
  const skip = /^(faktura|invoice|kvitto|receipt|sida|page|datum|date)$/i
  for (const line of lines) {
    if (skip.test(line)) continue
    if (/^\d/.test(line)) continue
    if (line.length < 3 || line.length > 80) continue
    return line
  }
  return null
}
