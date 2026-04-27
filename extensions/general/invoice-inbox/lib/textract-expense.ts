/**
 * AWS Textract AnalyzeExpense — deterministic field extraction for receipts
 * and invoices. Runs in parallel with the Claude vision pass; numbers from
 * Textract act as an anti-hallucination anchor for the final cross-check.
 *
 * Why receipt-specialized OCR over generic AnalyzeDocument: AnalyzeExpense is
 * tuned for the expense-document family (SUMMARY_FIELDS like TOTAL, TAX,
 * VENDOR_NAME, INVOICE_RECEIPT_DATE with field-level confidence scores).
 * Generic OCR returns raw text and positions — useful for nothing on its own.
 *
 * Failure model: every path is best-effort. If Textract returns an error, is
 * unsupported for this mime type, or the file is over the sync-API limit,
 * we return null and the caller falls back to Claude-only. Never throws.
 */

import {
  TextractClient,
  AnalyzeExpenseCommand,
  type ExpenseDocument,
  type ExpenseField,
} from '@aws-sdk/client-textract'

let _client: TextractClient | null = null

function getClient(): TextractClient {
  if (!_client) {
    _client = new TextractClient({
      region: process.env.AWS_REGION || 'eu-north-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    })
  }
  return _client
}

// Sync AnalyzeExpense caps at 5 MB per document. Anything bigger we skip
// rather than fall back to the async API — that adds S3 polling complexity
// for a tail case. The common-path receipt is <1 MB.
const MAX_SYNC_BYTES = 5 * 1024 * 1024

// Textract supports: PNG, JPEG, PDF, TIFF. HEIC/WebP → skip (Claude handles
// them fine; a second read isn't worth converting the image).
const SUPPORTED_MIMES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/tiff'])

export interface TextractExpenseResult {
  total: { value: number; confidence: number } | null
  subtotal: { value: number; confidence: number } | null
  tax: { value: number; confidence: number } | null
  vendor: { value: string; confidence: number } | null
  date: { value: string; confidence: number } | null
  currency: string | null
  // Raw summary fields kept for audit and future use (e.g., line items).
  raw_summary: Array<{ type: string; value: string; confidence: number }>
}

export async function analyzeExpenseWithTextract(
  fileBuffer: Buffer,
  mimeType: string
): Promise<TextractExpenseResult | null> {
  if (!SUPPORTED_MIMES.has(mimeType)) return null
  if (fileBuffer.byteLength > MAX_SYNC_BYTES) return null
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) return null

  try {
    const client = getClient()
    const response = await client.send(
      new AnalyzeExpenseCommand({
        Document: { Bytes: fileBuffer },
      })
    )

    const doc: ExpenseDocument | undefined = response.ExpenseDocuments?.[0]
    if (!doc) return null

    const summary = doc.SummaryFields ?? []
    return parseSummaryFields(summary)
  } catch (err) {
    // Don't let OCR failure break the pipeline — the Claude pass still runs.
    // Log so we can see rate-limit / auth issues but return null to caller.
    console.error('[textract-expense] AnalyzeExpense failed:', err)
    return null
  }
}

function parseSummaryFields(fields: ExpenseField[]): TextractExpenseResult {
  const raw_summary = fields
    .map((f) => ({
      type: f.Type?.Text ?? 'UNKNOWN',
      value: f.ValueDetection?.Text ?? '',
      confidence: (f.ValueDetection?.Confidence ?? 0) / 100,
    }))
    .filter((f) => f.value)

  const pickNumber = (type: string): { value: number; confidence: number } | null => {
    const field = fields.find((f) => f.Type?.Text === type)
    if (!field?.ValueDetection?.Text) return null
    const parsed = parseMoneyString(field.ValueDetection.Text)
    if (parsed == null) return null
    return { value: parsed, confidence: (field.ValueDetection.Confidence ?? 0) / 100 }
  }

  const pickString = (type: string): { value: string; confidence: number } | null => {
    const field = fields.find((f) => f.Type?.Text === type)
    if (!field?.ValueDetection?.Text) return null
    return {
      value: field.ValueDetection.Text.trim(),
      confidence: (field.ValueDetection.Confidence ?? 0) / 100,
    }
  }

  const rawDate = pickString('INVOICE_RECEIPT_DATE')
  return {
    total: pickNumber('TOTAL'),
    subtotal: pickNumber('SUBTOTAL'),
    tax: pickNumber('TAX'),
    vendor: pickString('VENDOR_NAME'),
    date: rawDate ? { value: normalizeDate(rawDate.value), confidence: rawDate.confidence } : null,
    currency: pickString('CURRENCY')?.value ?? null,
    raw_summary,
  }
}

// Textract returns money strings like "123,45 kr", "$123.45", "1 234,56 SEK".
// Strip everything but digits + separators, then normalize to period as
// decimal. Returns null when we can't confidently parse.
function parseMoneyString(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,-]/g, '').trim()
  if (!cleaned) return null

  // Swedish: 1 234,56 → 1234.56 (comma = decimal, space/period = thousands)
  // US: 1,234.56 → 1234.56 (comma = thousands, period = decimal)
  // Heuristic: if both , and . present, the rightmost is the decimal.
  const lastComma = cleaned.lastIndexOf(',')
  const lastDot = cleaned.lastIndexOf('.')

  let normalized: string
  if (lastComma === -1 && lastDot === -1) {
    normalized = cleaned
  } else if (lastComma > lastDot) {
    // Comma is decimal separator
    normalized = cleaned.replace(/\./g, '').replace(',', '.')
  } else {
    // Period is decimal separator
    normalized = cleaned.replace(/,/g, '')
  }

  const num = Number(normalized)
  return Number.isFinite(num) ? num : null
}

// Textract returns dates in many formats ("2024-03-14", "14/3/24", "March 14,
// 2024"). We coerce to ISO where possible; leave the original string as a
// fallback. The Claude pass will have its own date, so imperfect parse here
// is fine — cross-check falls back to fuzzy matching if needed.
function normalizeDate(raw: string): string {
  const trimmed = raw.trim()
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10)
  const parsed = new Date(trimmed)
  if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10)
  return trimmed
}

// Compares a Claude-extracted total against the Textract-extracted total.
// Agreement tolerance is 1 öre (0.01 SEK) — anything more is a real
// disagreement worth flagging, not rounding noise. Returns null when either
// side didn't produce a total (no basis for comparison).
export interface AgreementResult {
  agrees: boolean
  claude_total: number | null
  ocr_total: number | null
  ocr_confidence: number | null
  delta: number | null
}

export function checkTotalsAgreement(
  claudeTotal: number | null | undefined,
  textract: TextractExpenseResult | null
): AgreementResult | null {
  if (claudeTotal == null || !textract?.total) return null
  const delta = Math.abs(claudeTotal - textract.total.value)
  return {
    agrees: delta <= 0.01,
    claude_total: claudeTotal,
    ocr_total: textract.total.value,
    ocr_confidence: textract.total.confidence,
    delta,
  }
}
