/**
 * Link an existing posted verifikat to a customer invoice as its payment row.
 *
 * Used when the GL already contains a verifikat that credits AR (default
 * 1510) — e.g. a SIE-imported payment voucher, a manually-entered cash
 * receipt, or any flow where the bookkeeping landed without invoice linkage.
 * No new journal entry is created. Only an invoice_payments row is inserted
 * pointing at the existing journal_entry_id, plus the invoice's
 * paid_amount/remaining_amount/status are advanced.
 *
 * Vouchers that book income directly (credit 30xx instead of 1510) are
 * rejected here with VOUCHER_NO_AR_CREDIT. The proper fix for those is a
 * storno+correction via gnubok_correct_entry — out of scope for this V1.
 *
 * Both the web API route and the MCP commit handler call into the same
 * `linkInvoiceToVoucher()` function so behaviour stays in lockstep.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events/bus'
import { createLogger } from '@/lib/logger'
import {
  CONFIDENCE,
  amountsMatchExact,
  amountsMatchFuzzy,
  customerNameMatches,
} from './invoice-matching'
import type { Invoice, Customer } from '@/types'

const log = createLogger('voucher-matching')

/** AR account range. Default 1510 (Kundfordringar) — covers all 151x. */
const AR_ACCOUNT_PREFIX = '151'

/** ±90 days from the invoice's due_date as the default search window. */
const DEFAULT_DATE_WINDOW_DAYS = 90

/** Tolerance for floating-point comparisons on monetary amounts (0.5 öre). */
const AMOUNT_TOLERANCE = 0.005

/** Date-proximity bump applied when entry_date is within ±7 days of due_date. */
const DATE_PROXIMITY_BUMP = 0.05

export interface VoucherCandidate {
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  description: string
  /** Total credit to the AR account on this voucher (always positive). */
  ar_credit_amount: number
  currency: string
  /** Currency of the AR-credit line; nullable when the line stores SEK only. */
  ar_line_currency: string | null
  /** True when the voucher's fiscal period is closed or locked. */
  period_locked: boolean
  /** Confidence score 0..1 (or 0.99 for OCR match). */
  confidence: number
  /** Localized reason in Swedish (mirrors invoice-matching.ts conventions). */
  match_reason: string
}

interface JournalEntryLine {
  id: string
  journal_entry_id: string
  account_number: string
  debit_amount: number | null
  credit_amount: number | null
  currency: string | null
}

interface VoucherRow {
  id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  description: string
  status: string
  source_type: string | null
  fiscal_period_id: string
}

interface FiscalPeriodRow {
  id: string
  status: string
}

interface CandidateContext {
  invoice: Invoice & { customer?: Customer }
  remainingAmount: number
}

/** Internal: SQL-side filter for posted, non-storno, non-opening entries. */
const EXCLUDED_SOURCE_TYPES = ['opening_balance', 'storno']

/**
 * Find posted journal entries whose lines credit an AR account and could
 * plausibly be the payment for this invoice. Returns up to `limit` ranked
 * candidates.
 *
 * The query is intentionally generous on filtering — we let the validator
 * make the final call at commit time. Ranking mirrors
 * `findMatchingInvoices()`: exact amount + customer match wins, then exact,
 * then fuzzy (±1% capped at 500 SEK), with a small bump for date proximity
 * to the invoice's due_date.
 */
export async function findMatchingVouchersForInvoice(
  supabase: SupabaseClient,
  companyId: string,
  invoice: Invoice & { customer?: Customer },
  options: { limit?: number; dateWindowDays?: number } = {}
): Promise<VoucherCandidate[]> {
  const limit = options.limit ?? 10
  const windowDays = options.dateWindowDays ?? DEFAULT_DATE_WINDOW_DAYS

  const remainingAmount = computeRemaining(invoice)
  if (remainingAmount <= AMOUNT_TOLERANCE) return []

  const dueDate = new Date(invoice.due_date)
  const dateFrom = new Date(dueDate)
  dateFrom.setDate(dateFrom.getDate() - windowDays)
  const dateTo = new Date(dueDate)
  dateTo.setDate(dateTo.getDate() + windowDays)

  const { data: lines, error } = await supabase
    .from('journal_entry_lines')
    .select(
      `
      id,
      journal_entry_id,
      account_number,
      debit_amount,
      credit_amount,
      currency,
      journal_entries!inner (
        id,
        voucher_series,
        voucher_number,
        entry_date,
        description,
        status,
        source_type,
        fiscal_period_id,
        company_id
      )
      `
    )
    .eq('journal_entries.company_id', companyId)
    .eq('journal_entries.status', 'posted')
    .like('account_number', `${AR_ACCOUNT_PREFIX}%`)
    .gt('credit_amount', 0)
    .gte('journal_entries.entry_date', dateFrom.toISOString().slice(0, 10))
    .lte('journal_entries.entry_date', dateTo.toISOString().slice(0, 10))
    .limit(limit * 10)
  if (error || !lines) return []

  // Group lines by journal_entry_id so we sum the AR credit per voucher.
  const byEntry = new Map<
    string,
    { entry: VoucherRow; arCreditTotal: number; lineCurrency: string | null }
  >()

  for (const raw of lines) {
    const line = raw as unknown as JournalEntryLine & {
      journal_entries: VoucherRow
    }
    const entry = line.journal_entries
    if (!entry) continue
    if (EXCLUDED_SOURCE_TYPES.includes(entry.source_type ?? '')) continue

    const credit = Number(line.credit_amount ?? 0)
    if (credit <= 0) continue

    const existing = byEntry.get(entry.id)
    if (existing) {
      existing.arCreditTotal += credit
    } else {
      byEntry.set(entry.id, {
        entry,
        arCreditTotal: credit,
        lineCurrency: line.currency,
      })
    }
  }

  if (byEntry.size === 0) return []

  // Drop entries already fully linked to *this* invoice.
  const candidateEntryIds = Array.from(byEntry.keys())
  const { data: existingLinks } = await supabase
    .from('invoice_payments')
    .select('journal_entry_id')
    .eq('company_id', companyId)
    .eq('invoice_id', invoice.id)
    .in('journal_entry_id', candidateEntryIds)

  const alreadyLinked = new Set(
    (existingLinks ?? [])
      .map((row) => (row as { journal_entry_id: string | null }).journal_entry_id)
      .filter((id): id is string => !!id)
  )
  for (const id of alreadyLinked) byEntry.delete(id)
  if (byEntry.size === 0) return []

  // Resolve fiscal period locks in one batched query so we can surface a
  // "period locked" flag in the candidate preview. Linking is allowed in
  // locked periods (no JE mutation) — this is just informational.
  const periodIds = Array.from(
    new Set(Array.from(byEntry.values()).map((v) => v.entry.fiscal_period_id))
  )
  const { data: periods } = await supabase
    .from('fiscal_periods')
    .select('id, status')
    .in('id', periodIds)
  const lockedPeriods = new Set(
    (periods ?? [])
      .filter(
        (p) =>
          (p as FiscalPeriodRow).status === 'closed' ||
          (p as FiscalPeriodRow).status === 'locked'
      )
      .map((p) => (p as FiscalPeriodRow).id)
  )

  // Score and rank.
  const ctx: CandidateContext = { invoice, remainingAmount }
  const candidates: VoucherCandidate[] = []
  for (const { entry, arCreditTotal, lineCurrency } of byEntry.values()) {
    const scored = scoreCandidate(entry, arCreditTotal, lineCurrency, ctx)
    if (!scored) continue
    candidates.push({
      journal_entry_id: entry.id,
      voucher_series: entry.voucher_series,
      voucher_number: entry.voucher_number,
      entry_date: entry.entry_date,
      description: entry.description,
      ar_credit_amount: round2(arCreditTotal),
      currency: invoice.currency,
      ar_line_currency: lineCurrency,
      period_locked: lockedPeriods.has(entry.fiscal_period_id),
      confidence: scored.confidence,
      match_reason: scored.match_reason,
    })
  }

  candidates.sort((a, b) => b.confidence - a.confidence || a.entry_date.localeCompare(b.entry_date))
  return candidates.slice(0, limit)
}

function scoreCandidate(
  entry: VoucherRow,
  arCreditTotal: number,
  lineCurrency: string | null,
  ctx: CandidateContext
): { confidence: number; match_reason: string } | null {
  // OCR-style: invoice number appears in entry description.
  if (
    ctx.invoice.invoice_number &&
    descriptionMentionsInvoice(entry.description, ctx.invoice.invoice_number)
  ) {
    return {
      confidence: CONFIDENCE.OCR_REFERENCE_MATCH,
      match_reason: `Fakturanummer ${ctx.invoice.invoice_number} omnämnt i verifikatets beskrivning`,
    }
  }

  // Currency mismatch is a hard filter at validation time; candidate listing
  // still surfaces near-misses so the user sees them, but we only score them
  // for now if the line currency is absent (treated as invoice currency) or
  // matches the invoice currency.
  const lineCurrencyEffective = lineCurrency ?? ctx.invoice.currency
  if (lineCurrencyEffective !== ctx.invoice.currency) {
    return null
  }

  const exactRemaining = amountsMatchExact(arCreditTotal, ctx.remainingAmount)
  const exactTotal =
    !exactRemaining && amountsMatchExact(arCreditTotal, ctx.invoice.total)
  const fuzzyRemaining =
    !exactRemaining && !exactTotal && amountsMatchFuzzy(arCreditTotal, ctx.remainingAmount)

  const customerMatch = customerNameMatches(
    ctx.invoice.customer?.name,
    entry.description,
    null
  )

  let confidence = 0
  let reason = ''
  if (exactRemaining && customerMatch) {
    confidence = CONFIDENCE.EXACT_AMOUNT_CUSTOMER
    reason = `Exakt belopp (${formatNumber(arCreditTotal)} ${ctx.invoice.currency}) och kundnamn matchar`
  } else if (exactRemaining) {
    confidence = CONFIDENCE.EXACT_AMOUNT_ONLY
    reason = `Exakt belopp (${formatNumber(arCreditTotal)} ${ctx.invoice.currency})`
  } else if (exactTotal && customerMatch) {
    confidence = CONFIDENCE.FUZZY_AMOUNT_CUSTOMER
    reason = `Fakturans totalbelopp och kundnamn matchar`
  } else if (exactTotal) {
    confidence = CONFIDENCE.FUZZY_AMOUNT_ONLY + 0.05
    reason = `Fakturans totalbelopp matchar`
  } else if (fuzzyRemaining && customerMatch) {
    confidence = CONFIDENCE.FUZZY_AMOUNT_CUSTOMER
    reason = `Belopp nära (±1%) och kundnamn matchar`
  } else if (fuzzyRemaining) {
    confidence = CONFIDENCE.FUZZY_AMOUNT_ONLY
    reason = `Belopp nära (±1%)`
  } else {
    return null
  }

  // Bump for date proximity to due_date.
  if (isDateWithinDays(entry.entry_date, ctx.invoice.due_date, 7)) {
    confidence = Math.min(CONFIDENCE.OCR_REFERENCE_MATCH - 0.001, confidence + DATE_PROXIMITY_BUMP)
  }

  return { confidence, match_reason: reason }
}

export type ValidateResult =
  | {
      ok: true
      arCreditAmount: number
      arLineCurrency: string | null
      voucher: VoucherRow
      remainingAfter: number
      isFullyPaid: boolean
      paymentAmount: number
    }
  | {
      ok: false
      code: VoucherLinkErrorCode
      details?: Record<string, unknown>
    }

export type VoucherLinkErrorCode =
  | 'LINK_VOUCHER_INVOICE_NOT_FOUND'
  | 'LINK_VOUCHER_VOUCHER_NOT_FOUND'
  | 'LINK_VOUCHER_NOT_POSTED'
  | 'LINK_VOUCHER_NO_AR_CREDIT'
  | 'LINK_VOUCHER_ALREADY_LINKED'
  | 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING'
  | 'LINK_VOUCHER_CURRENCY_MISMATCH'
  | 'LINK_VOUCHER_INVOICE_FULLY_PAID'
  | 'LINK_VOUCHER_DB_ERROR'

/**
 * Validate that a journal entry can be linked as payment for an invoice.
 * Used by both the staging path (MCP tool) and the commit path (web route +
 * MCP commit handler) so the guards stay identical.
 */
export async function validateVoucherForInvoiceLink(
  supabase: SupabaseClient,
  companyId: string,
  invoice: Invoice & { customer?: Customer },
  journalEntryId: string
): Promise<ValidateResult> {
  const remainingAmount = computeRemaining(invoice)
  if (remainingAmount <= AMOUNT_TOLERANCE) {
    return { ok: false, code: 'LINK_VOUCHER_INVOICE_FULLY_PAID' }
  }

  const { data: voucher, error: voucherError } = await supabase
    .from('journal_entries')
    .select('id, voucher_series, voucher_number, entry_date, description, status, source_type, fiscal_period_id, company_id')
    .eq('id', journalEntryId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (voucherError || !voucher) {
    return { ok: false, code: 'LINK_VOUCHER_VOUCHER_NOT_FOUND' }
  }

  const v = voucher as VoucherRow & { company_id: string }
  if (v.status !== 'posted') {
    return { ok: false, code: 'LINK_VOUCHER_NOT_POSTED', details: { status: v.status } }
  }
  if (EXCLUDED_SOURCE_TYPES.includes(v.source_type ?? '')) {
    return { ok: false, code: 'LINK_VOUCHER_NO_AR_CREDIT', details: { source_type: v.source_type } }
  }

  const { data: lines, error: linesError } = await supabase
    .from('journal_entry_lines')
    .select('account_number, debit_amount, credit_amount, currency')
    .eq('journal_entry_id', journalEntryId)
  if (linesError || !lines || lines.length === 0) {
    return { ok: false, code: 'LINK_VOUCHER_NO_AR_CREDIT' }
  }

  let arCreditTotal = 0
  let lineCurrency: string | null = null
  for (const raw of lines) {
    const line = raw as { account_number: string; debit_amount: number | null; credit_amount: number | null; currency: string | null }
    if (!line.account_number?.startsWith(AR_ACCOUNT_PREFIX)) continue
    const credit = Number(line.credit_amount ?? 0)
    if (credit <= 0) continue
    arCreditTotal += credit
    if (!lineCurrency) lineCurrency = line.currency
  }
  arCreditTotal = round2(arCreditTotal)

  if (arCreditTotal <= 0) {
    return { ok: false, code: 'LINK_VOUCHER_NO_AR_CREDIT' }
  }

  const lineCurrencyEffective = lineCurrency ?? invoice.currency
  if (lineCurrencyEffective !== invoice.currency) {
    return {
      ok: false,
      code: 'LINK_VOUCHER_CURRENCY_MISMATCH',
      details: { invoice_currency: invoice.currency, line_currency: lineCurrencyEffective },
    }
  }

  if (arCreditTotal > remainingAmount + AMOUNT_TOLERANCE) {
    return {
      ok: false,
      code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      details: { ar_credit: arCreditTotal, remaining: round2(remainingAmount) },
    }
  }

  // Already linked to this invoice? (Final, authoritative check — the DB
  // partial unique index is the last line of defence at insert time.)
  const { data: existingLinks } = await supabase
    .from('invoice_payments')
    .select('id')
    .eq('company_id', companyId)
    .eq('invoice_id', invoice.id)
    .eq('journal_entry_id', journalEntryId)
    .limit(1)
  if (existingLinks && existingLinks.length > 0) {
    return { ok: false, code: 'LINK_VOUCHER_ALREADY_LINKED' }
  }

  const paymentAmount = Math.min(arCreditTotal, round2(remainingAmount))
  const remainingAfter = Math.max(0, round2(remainingAmount - paymentAmount))
  const isFullyPaid = remainingAfter <= AMOUNT_TOLERANCE

  return {
    ok: true,
    arCreditAmount: arCreditTotal,
    arLineCurrency: lineCurrency,
    voucher: v,
    remainingAfter,
    isFullyPaid,
    paymentAmount,
  }
}

export interface LinkInvoiceToVoucherParams {
  invoiceId: string
  journalEntryId: string
  notes?: string
}

export interface LinkInvoiceToVoucherResult {
  paymentId: string
  invoiceStatus: 'paid' | 'partially_paid'
  paidAmount: number
  remainingAmount: number
  paymentAmount: number
  journalEntryId: string
}

/**
 * Atomically link an existing posted verifikat to an invoice. Inserts an
 * invoice_payments row, advances the invoice's paid_amount/remaining_amount,
 * and emits invoice.match_confirmed (reusing the existing event so reminder
 * cancellation + automations fire without a new event channel).
 *
 * Re-validates inside the same call to defend against stage→commit drift —
 * voucher reversed, invoice paid by another flow, etc. Any structured
 * rejection is returned as { ok: false, code } so callers can map it to a
 * stable HTTP status + auto-reject the pending op.
 */
export async function linkInvoiceToVoucher(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: LinkInvoiceToVoucherParams
): Promise<
  | { ok: true; result: LinkInvoiceToVoucherResult }
  | { ok: false; code: VoucherLinkErrorCode; details?: Record<string, unknown> }
> {
  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select('*, customer:customers(*)')
    .eq('id', params.invoiceId)
    .eq('company_id', companyId)
    .single()
  if (invoiceError || !invoice) {
    return { ok: false, code: 'LINK_VOUCHER_INVOICE_NOT_FOUND', details: { invoice_id: params.invoiceId } }
  }

  if (!['sent', 'overdue', 'partially_paid'].includes(invoice.status)) {
    return { ok: false, code: 'LINK_VOUCHER_INVOICE_FULLY_PAID', details: { status: invoice.status } }
  }

  const validation = await validateVoucherForInvoiceLink(
    supabase,
    companyId,
    invoice as Invoice & { customer?: Customer },
    params.journalEntryId
  )
  if (!validation.ok) return validation

  const now = new Date().toISOString()
  const newPaidAmount = round2((invoice.paid_amount ?? 0) + validation.paymentAmount)
  const newRemaining = validation.remainingAfter
  const newStatus: 'paid' | 'partially_paid' = validation.isFullyPaid ? 'paid' : 'partially_paid'

  const { data: updatedRows, error: updateInvError } = await supabase
    .from('invoices')
    .update({
      status: newStatus,
      paid_at: validation.isFullyPaid ? now : invoice.paid_at,
      paid_amount: newPaidAmount,
      remaining_amount: newRemaining,
    })
    .eq('id', params.invoiceId)
    .eq('company_id', companyId)
    .in('status', ['sent', 'overdue', 'partially_paid'])
    .select('id')

  if (updateInvError) {
    // Real DB failure (RLS, network, constraint) — distinct from "voucher not
    // found" so the pending-op dispatcher retries instead of auto-rejecting.
    return { ok: false, code: 'LINK_VOUCHER_DB_ERROR', details: { reason: updateInvError.message } }
  }
  if (!updatedRows || updatedRows.length === 0) {
    return { ok: false, code: 'LINK_VOUCHER_INVOICE_FULLY_PAID' }
  }

  const { data: payment, error: insertError } = await supabase
    .from('invoice_payments')
    .insert({
      user_id: userId,
      company_id: companyId,
      invoice_id: params.invoiceId,
      payment_date: validation.voucher.entry_date,
      amount: validation.paymentAmount,
      currency: invoice.currency,
      exchange_rate: invoice.exchange_rate,
      journal_entry_id: params.journalEntryId,
      transaction_id: null,
      notes: params.notes ?? null,
    })
    .select('id')
    .single()

  if (insertError) {
    // Roll back the invoice update so we don't leave the row in a half-linked
    // state. The partial unique index raises 23505 if another linker won the
    // race between validation and insert.
    const { error: rollbackError } = await supabase
      .from('invoices')
      .update({
        status: invoice.status,
        paid_at: invoice.paid_at,
        paid_amount: invoice.paid_amount,
        remaining_amount: invoice.remaining_amount,
      })
      .eq('id', params.invoiceId)
      .eq('company_id', companyId)

    if (rollbackError) {
      // Rollback failed — the invoice is stuck advanced with no payment row.
      // Surface loudly so ops can reconcile manually; the insert error code
      // below still goes back to the caller for the original failure cause.
      log.error('voucher link rollback failed — invoice left in advanced state without payment row', {
        companyId,
        userId,
        invoiceId: params.invoiceId,
        journalEntryId: params.journalEntryId,
        insertError: insertError.message,
        rollbackError: rollbackError.message,
      })
    }

    if (insertError.code === '23505') {
      return { ok: false, code: 'LINK_VOUCHER_ALREADY_LINKED' }
    }
    return {
      ok: false,
      code: 'LINK_VOUCHER_DB_ERROR',
      details: { reason: insertError.message },
    }
  }

  try {
    await eventBus.emit({
      type: 'invoice.paid',
      payload: {
        invoice: invoice as Invoice,
        paymentAmount: validation.paymentAmount,
        paymentDate: validation.voucher.entry_date,
        userId,
        companyId,
      },
    })
  } catch {
    /* non-critical */
  }

  return {
    ok: true,
    result: {
      paymentId: (payment as { id: string }).id,
      invoiceStatus: newStatus,
      paidAmount: newPaidAmount,
      remainingAmount: newRemaining,
      paymentAmount: validation.paymentAmount,
      journalEntryId: params.journalEntryId,
    },
  }
}

// ── Helpers ─────────────────────────────────────────────────

function computeRemaining(invoice: Invoice): number {
  if (typeof invoice.remaining_amount === 'number' && invoice.remaining_amount > 0) {
    return invoice.remaining_amount
  }
  const paid = invoice.paid_amount ?? 0
  return Math.max(0, round2(invoice.total - paid))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function isDateWithinDays(a: string, b: string, days: number): boolean {
  const ad = new Date(a).getTime()
  const bd = new Date(b).getTime()
  if (Number.isNaN(ad) || Number.isNaN(bd)) return false
  return Math.abs(ad - bd) <= days * 24 * 3600 * 1000
}

function descriptionMentionsInvoice(description: string | null, invoiceNumber: string): boolean {
  if (!description || !invoiceNumber) return false
  const normalizedDesc = description.replace(/\s+/g, '').toLowerCase()
  const normalizedNum = invoiceNumber.replace(/\s+/g, '').toLowerCase()
  return normalizedDesc.includes(normalizedNum)
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}
