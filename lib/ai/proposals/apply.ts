/**
 * Apply path — what happens when a user accepts a pending proposal.
 *
 * - step='match': sets matched_transaction_id on the inbox item using the
 *   same columns as the existing smart-matcher (match_method, match_confidence,
 *   match_reasoning) so downstream consumers don't need to know whether the
 *   match came from AI or the deterministic matcher.
 *
 * - step='booking': creates a draft journal entry via the engine with
 *   created_via='ai_proposed' + source_proposal_id, then commits, then
 *   links the document. Mirrors the categorize API route's CAS guards.
 *
 * Re-validation MUST have already passed (call reValidateProposal() first).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  AIProposal,
  BookingProposalPayload,
  CreateJournalEntryInput,
  InvoiceInboxItem,
  JournalEntry,
  MatchProposalPayload,
} from '@/types'
import {
  createDraftEntry,
  commitEntry,
} from '@/lib/bookkeeping/engine'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('ai-proposals/apply')

export interface ApplyMatchOutcome {
  kind: 'match_applied'
  inboxItemId: string
  matchedTransactionId: string
}

export interface ApplyBookingOutcome {
  kind: 'booking_applied'
  inboxItemId: string
  journalEntry: JournalEntry
}

export type ApplyOutcome = ApplyMatchOutcome | ApplyBookingOutcome

/**
 * Apply a re-validated proposal. Writes the proposal's changes to the
 * domain tables (inbox_item, journal_entries, document_attachments).
 *
 * Callers should:
 *   1. Run reValidateProposal() first.
 *   2. Use this function's return value to update the proposal row
 *      (status='accepted', applied_entry_id).
 */
export async function applyProposal(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  proposal: AIProposal,
  inboxItem: InvoiceInboxItem,
  editedPayload?: MatchProposalPayload | BookingProposalPayload
): Promise<ApplyOutcome> {
  const payload = editedPayload ?? proposal.proposal_json

  if (proposal.step_type === 'match') {
    return applyMatch(supabase, inboxItem, payload as MatchProposalPayload, proposal)
  }

  if (proposal.step_type === 'booking') {
    return applyBooking(supabase, companyId, userId, inboxItem, payload as BookingProposalPayload, proposal)
  }

  throw new Error(`Unknown step_type: ${proposal.step_type}`)
}

async function applyMatch(
  supabase: SupabaseClient,
  inboxItem: InvoiceInboxItem,
  payload: MatchProposalPayload,
  proposal: AIProposal
): Promise<ApplyMatchOutcome> {
  const { error } = await supabase
    .from('invoice_inbox_items')
    .update({
      matched_transaction_id: payload.matched_transaction_id,
      match_method: 'llm',
      match_confidence: proposal.confidence,
      match_reasoning: proposal.reasoning,
    })
    .eq('id', inboxItem.id)

  if (error) {
    // 23505 = the existing smart-match partial unique index (the same
    // transaction was claimed by another inbox item since re-validation).
    throw new Error(`Failed to apply match: ${error.message}`)
  }

  return {
    kind: 'match_applied',
    inboxItemId: inboxItem.id,
    matchedTransactionId: payload.matched_transaction_id,
  }
}

async function applyBooking(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  inboxItem: InvoiceInboxItem,
  payload: BookingProposalPayload,
  proposal: AIProposal
): Promise<ApplyBookingOutcome> {
  // 1. Draft the entry with provenance.
  const input: CreateJournalEntryInput = {
    fiscal_period_id: payload.fiscal_period_id,
    entry_date: payload.entry_date,
    description: payload.description,
    source_type: 'bank_transaction',
    source_id: inboxItem.matched_transaction_id!,
    lines: payload.lines.map((l) => ({
      account_number: l.account_number,
      debit_amount: l.debit_amount,
      credit_amount: l.credit_amount,
      line_description: l.description,
    })),
    created_via: 'ai_proposed',
    source_proposal_id: proposal.id,
  }

  const draft = await createDraftEntry(supabase, companyId, userId, input)

  let entry: JournalEntry
  try {
    entry = await commitEntry(supabase, companyId, userId, draft.id)
  } catch (commitError) {
    // Mirror the safety net from createJournalEntry — cancel the orphan draft.
    try {
      await supabase
        .from('journal_entries')
        .update({ status: 'cancelled' })
        .eq('id', draft.id)
        .eq('status', 'draft')
    } catch {
      // Swallow — surface the original commit error
    }
    throw commitError
  }

  // 2. Link the document to the entry (mirror the categorize route pattern).
  if (inboxItem.document_id) {
    try {
      await linkToJournalEntry(supabase, companyId, inboxItem.document_id, entry.id)
    } catch (err) {
      log.error('Failed to link document to entry (entry stays posted):', err)
      // The entry is already posted; re-linking can be retried from the UI.
    }
  }

  // 3. Link the transaction to the entry (same CAS as categorize route).
  if (inboxItem.matched_transaction_id) {
    const { error: txError } = await supabase
      .from('transactions')
      .update({
        journal_entry_id: entry.id,
        is_business: true,
      })
      .eq('id', inboxItem.matched_transaction_id)
      .is('journal_entry_id', null)

    if (txError) {
      log.error('Failed to link transaction to entry:', txError)
    }
  }

  // 4. Mark the inbox item confirmed.
  await supabase
    .from('invoice_inbox_items')
    .update({ status: 'confirmed' })
    .eq('id', inboxItem.id)

  return {
    kind: 'booking_applied',
    inboxItemId: inboxItem.id,
    journalEntry: entry,
  }
}
