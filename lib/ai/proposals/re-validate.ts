/**
 * Re-validation at accept time.
 *
 * A pending proposal can become stale between generation and accept:
 *   * matched transaction gets deleted or already booked
 *   * fiscal period closed or locked
 *   * account deactivated in the chart
 *   * inbox item already linked to a journal entry via a manual path
 *
 * This module runs the relevant checks and returns a typed error the API
 * route translates to a structured response the UI can act on (e.g.,
 * "period closed — reopen it or change the entry date").
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  AIProposal,
  BookingProposalPayload,
  MatchProposalPayload,
  InvoiceInboxItem,
} from '@/types'

export type ValidationFailureCode =
  | 'inbox_item_missing'
  | 'inbox_item_already_booked'
  | 'transaction_missing'
  | 'transaction_already_booked'
  | 'transaction_already_matched_elsewhere'
  | 'period_missing_or_closed'
  | 'account_missing_or_inactive'
  | 'receipt_file_missing'
  | 'step_prerequisite_missing'
  | 'livsmedel_vat_rate_stale'

export interface ValidationSuccess {
  ok: true
  inboxItem: InvoiceInboxItem
}

export interface ValidationFailure {
  ok: false
  code: ValidationFailureCode
  message: string
  details?: Record<string, unknown>
}

export type ValidationResult = ValidationSuccess | ValidationFailure

export async function reValidateProposal(
  supabase: SupabaseClient,
  companyId: string,
  proposal: AIProposal
): Promise<ValidationResult> {
  if (proposal.subject_type !== 'inbox_item') {
    return {
      ok: false,
      code: 'step_prerequisite_missing',
      message: 'Endast inkorgsobjekt stöds i denna version.',
    }
  }

  // Common: the inbox item still exists.
  const { data: inboxItem, error: inboxError } = await supabase
    .from('invoice_inbox_items')
    .select('*')
    .eq('id', proposal.subject_id)
    .eq('company_id', companyId)
    .maybeSingle()

  if (inboxError || !inboxItem) {
    return {
      ok: false,
      code: 'inbox_item_missing',
      message: 'Kvittot/fakturan finns inte längre.',
    }
  }

  const item = inboxItem as InvoiceInboxItem

  // If the document has already been booked via another path, skip.
  if (item.status === 'confirmed') {
    return {
      ok: false,
      code: 'inbox_item_already_booked',
      message: 'Detta dokument är redan bokfört manuellt.',
    }
  }

  if (proposal.step_type === 'match') {
    return reValidateMatch(supabase, companyId, item, proposal.proposal_json as MatchProposalPayload)
  }

  if (proposal.step_type === 'booking') {
    return reValidateBooking(supabase, companyId, item, proposal.proposal_json as BookingProposalPayload)
  }

  return {
    ok: false,
    code: 'step_prerequisite_missing',
    message: `Okänt stegtyp: ${proposal.step_type}`,
  }
}

async function reValidateMatch(
  supabase: SupabaseClient,
  companyId: string,
  item: InvoiceInboxItem,
  payload: MatchProposalPayload
): Promise<ValidationResult> {
  // BFL 5 kap 7§: every verifikation requires an underlying source document.
  // Block the match accept when no receipt file is attached so the user
  // can't reach the booking step without proof. The UI shows an upload
  // affordance in the receipt detail modal for this exact case.
  if (!item.document_id) {
    return {
      ok: false,
      code: 'receipt_file_missing',
      message: 'Kvittobild krävs innan du kan koppla transaktionen. Ladda upp en bild av kvittot först.',
    }
  }

  const txId = payload.matched_transaction_id

  const { data: tx } = await supabase
    .from('transactions')
    .select('id, journal_entry_id, company_id')
    .eq('id', txId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (!tx) {
    return {
      ok: false,
      code: 'transaction_missing',
      message: 'Den föreslagna transaktionen finns inte längre.',
    }
  }

  if (tx.journal_entry_id) {
    return {
      ok: false,
      code: 'transaction_already_booked',
      message: 'Transaktionen är redan bokförd.',
    }
  }

  // Another inbox item may have claimed this transaction via the existing
  // smart-match partial unique index.
  const { data: claimingInbox } = await supabase
    .from('invoice_inbox_items')
    .select('id')
    .eq('matched_transaction_id', txId)
    .eq('company_id', companyId)
    .neq('id', item.id)
    .maybeSingle()

  if (claimingInbox) {
    return {
      ok: false,
      code: 'transaction_already_matched_elsewhere',
      message: 'Transaktionen är redan matchad till ett annat dokument.',
    }
  }

  return { ok: true, inboxItem: item }
}

async function reValidateBooking(
  supabase: SupabaseClient,
  companyId: string,
  item: InvoiceInboxItem,
  payload: BookingProposalPayload
): Promise<ValidationResult> {
  if (!item.matched_transaction_id) {
    return {
      ok: false,
      code: 'step_prerequisite_missing',
      message: 'Ingen matchande transaktion — stäng först matchningssteget.',
    }
  }

  // The transaction still exists and is still unbooked.
  const { data: tx } = await supabase
    .from('transactions')
    .select('id, journal_entry_id')
    .eq('id', item.matched_transaction_id)
    .eq('company_id', companyId)
    .maybeSingle()

  if (!tx) {
    return {
      ok: false,
      code: 'transaction_missing',
      message: 'Den matchade transaktionen finns inte längre.',
    }
  }

  if (tx.journal_entry_id) {
    return {
      ok: false,
      code: 'transaction_already_booked',
      message: 'Transaktionen har redan bokförts.',
    }
  }

  // Fiscal period is open.
  const { data: period } = await supabase
    .from('fiscal_periods')
    .select('id, is_closed, locked_at')
    .eq('id', payload.fiscal_period_id)
    .eq('company_id', companyId)
    .maybeSingle()

  if (!period || period.is_closed || period.locked_at) {
    return {
      ok: false,
      code: 'period_missing_or_closed',
      message: 'Räkenskapsåret är låst eller finns inte längre.',
    }
  }

  // All accounts in the proposed lines are active in the chart.
  const accountNumbers = [...new Set(payload.lines.map((l) => l.account_number))]
  const { data: accounts } = await supabase
    .from('chart_of_accounts')
    .select('account_number, is_active')
    .eq('company_id', companyId)
    .in('account_number', accountNumbers)

  const foundActive = new Set(
    (accounts || []).filter((a) => a.is_active).map((a) => a.account_number)
  )
  const missing = accountNumbers.filter((n) => !foundActive.has(n))

  if (missing.length > 0) {
    return {
      ok: false,
      code: 'account_missing_or_inactive',
      message: `Kontona saknas eller är inaktiva: ${missing.join(', ')}`,
      details: { missing_accounts: missing },
    }
  }

  const livsmedelMismatch = detectLivsmedelRateMismatch(item, payload)
  if (livsmedelMismatch) {
    return {
      ok: false,
      code: 'livsmedel_vat_rate_stale',
      message: livsmedelMismatch.message,
      details: livsmedelMismatch.details,
    }
  }

  return { ok: true, inboxItem: item }
}

// Sweden's livsmedel VAT temporarily drops from 12% to 6% between
// 2026-04-01 and 2027-12-31 (Prop. 2025/26:55). Restaurang/servering stays
// at 12% throughout. This guard catches AI proposals where the rate label
// is stale relative to the entry date for clearly-grocery merchants. The
// prompt is the primary defence; this is the safety net for prompt drift.
const LIVSMEDEL_REDUCED_START = '2026-04-01'
const LIVSMEDEL_REDUCED_END = '2027-12-31'

const GROCERY_CHAIN_KEYWORDS = [
  'ica maxi',
  'ica kvantum',
  'ica supermarket',
  'ica nära',
  'ica',
  'coop',
  'hemköp',
  'willys',
  'lidl',
  'city gross',
  'tempo',
  'mathem',
  'mat.se',
  'matse',
  'netto',
  'matöppet',
]

const RESTAURANG_KEYWORDS = [
  'restaurang',
  'servering',
  'pizzeria',
  'bistro',
  'lunchrestaurang',
  'sushi',
  'café',
  'kafé',
  'cafe',
]

function detectLivsmedelRateMismatch(
  item: InvoiceInboxItem,
  payload: BookingProposalPayload
): { message: string; details: Record<string, unknown> } | null {
  const treatment = payload.vat_treatment
  if (treatment !== 'reduced_12' && treatment !== 'reduced_6') return null

  const haystack = [
    payload.description ?? '',
    ...payload.lines.map((l) => l.description ?? ''),
    JSON.stringify(item.extracted_data ?? {}),
  ]
    .join(' ')
    .toLowerCase()

  const isGrocery = GROCERY_CHAIN_KEYWORDS.some((k) => haystack.includes(k))
  const isRestaurang = RESTAURANG_KEYWORDS.some((k) => haystack.includes(k))

  // If both signals fire, treat as ambiguous and let it through — the
  // user will review on the inbox card anyway.
  if (isGrocery === isRestaurang) return null

  const date = payload.entry_date
  const inReducedWindow = date >= LIVSMEDEL_REDUCED_START && date <= LIVSMEDEL_REDUCED_END

  if (isGrocery && treatment === 'reduced_12' && inReducedWindow) {
    return {
      message:
        'Momssatsen 12 % stämmer inte — livsmedel ska bokföras med 6 % moms från 1 april 2026 t.o.m. 31 december 2027. Justera förslaget eller bokför manuellt.',
      details: { signal: 'grocery', treatment, entry_date: date, expected: 'reduced_6' },
    }
  }

  if (isGrocery && treatment === 'reduced_6' && !inReducedWindow) {
    return {
      message:
        'Momssatsen 6 % gäller endast för livsmedel mellan 1 april 2026 och 31 december 2027. Övriga datum ska bokföras med 12 %.',
      details: { signal: 'grocery', treatment, entry_date: date, expected: 'reduced_12' },
    }
  }

  if (isRestaurang && treatment === 'reduced_6') {
    return {
      message:
        'Restaurang- och serveringstjänster har 12 % moms (omfattas inte av livsmedelssänkningen). Justera förslaget eller bokför manuellt.',
      details: { signal: 'restaurang', treatment, entry_date: date, expected: 'reduced_12' },
    }
  }

  return null
}
