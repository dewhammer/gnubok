import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { eventBus } from '@/lib/events/bus'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { AcceptProposalSchema } from '@/lib/api/schemas'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { reValidateProposal } from '@/lib/ai/proposals/re-validate'
import { applyProposal } from '@/lib/ai/proposals/apply'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { gateAgentInbox } from '@/lib/ai/feature-flag'
import type {
  AIProposal,
  BookingProposalPayload,
  InvoiceInboxItem,
  MatchProposalPayload,
} from '@/types'

ensureInitialized()

/**
 * POST /api/ai/proposals/[id]/accept
 *
 * Accept a pending proposal:
 *   1. Optimistic lock on version to catch concurrent clicks.
 *   2. Re-validate (period open, transaction still unbooked, accounts active).
 *   3. Apply via lib/ai/proposals/apply.ts (engine call happens there).
 *   4. Mark status='accepted', set applied_entry_id, bump version.
 *   5. If `edits` provided and differ from proposal_json, record edit_diff
 *      and return a `learning_prompt` hint so the UI can ask
 *      "remember this booking for <counterparty>?".
 *   6. Emit ai_proposal.accepted so the orchestrator can chain match -> booking.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = gateAgentInbox()
  if (gate) return gate

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)
  const { id } = await params

  const validation = await validateBody(request, AcceptProposalSchema)
  if (!validation.success) return validation.response
  const { version, edits } = validation.data

  // Fetch the proposal (also enforces company scope).
  const { data: proposal, error: fetchError } = await supabase
    .from('ai_proposals')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle()

  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 })
  if (!proposal) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const typed = proposal as AIProposal

  if (typed.status !== 'pending') {
    return NextResponse.json(
      { error: 'Förslaget har redan hanterats.', status: typed.status },
      { status: 409 }
    )
  }

  if (typed.version !== version) {
    return NextResponse.json(
      { error: 'Förslaget har ändrats av en annan användare — ladda om.' },
      { status: 409 }
    )
  }

  // Re-validate current state — proposal might be stale.
  const check = await reValidateProposal(supabase, companyId, typed)
  if (!check.ok) {
    // Mark invalidated so it drops out of the pending inbox.
    await supabase
      .from('ai_proposals')
      .update({
        status: 'invalidated',
        invalidated_reason: check.code,
      })
      .eq('id', typed.id)
      .eq('version', version)
    return NextResponse.json(
      { error: check.message, code: check.code, details: check.details ?? null },
      { status: 409 }
    )
  }

  const inboxItem = check.inboxItem as InvoiceInboxItem

  // Merge edits into the original payload shape (edits are partial).
  let editedPayload: MatchProposalPayload | BookingProposalPayload | undefined
  if (edits) {
    if (typed.step_type === 'match') {
      const matchEdit = edits as { matched_transaction_id: string }
      const original = typed.proposal_json as MatchProposalPayload
      editedPayload = {
        ...original,
        matched_transaction_id: matchEdit.matched_transaction_id,
      }
    } else {
      editedPayload = edits as BookingProposalPayload
    }
  }

  // Compute edit diff if edits were supplied and differ.
  const editDiff = computeEditDiff(typed, editedPayload)

  // Apply (calls the engine for booking steps).
  let outcome
  try {
    outcome = await applyProposal(
      supabase,
      companyId,
      user.id,
      typed,
      inboxItem,
      editedPayload
    )
  } catch (err) {
    const typedResp = bookkeepingErrorResponse(err)
    if (typedResp) return typedResp
    const message = err instanceof Error ? err.message : 'Kunde inte tillämpa förslaget'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  // Mark proposal accepted with CAS on version.
  const appliedEntryId =
    outcome.kind === 'booking_applied' ? outcome.journalEntry.id : null

  const { data: updatedRows, error: updateError } = await supabase
    .from('ai_proposals')
    .update({
      status: 'accepted',
      accepted_at: new Date().toISOString(),
      accepted_by_user_id: user.id,
      version: typed.version + 1,
      applied_entry_id: appliedEntryId,
      edit_diff: editDiff,
    })
    .eq('id', typed.id)
    .eq('version', version)
    .select()

  if (updateError || !updatedRows || updatedRows.length === 0) {
    // The domain-level apply already happened; log loud but don't unwind
    // (storno would be disproportionate for a race on a status bit).
    console.error('[ai/accept] proposal status update failed after apply', updateError)
  }

  const finalProposal = (updatedRows?.[0] as AIProposal | undefined) ?? typed

  // Audit trail.
  try {
    if (inboxItem.correlation_id) {
      await appendProcessingHistory({
        companyId,
        correlationId: inboxItem.correlation_id,
        aggregateType: 'AIProposal',
        aggregateId: typed.id,
        eventType: 'AIProposalAccepted',
        payload: {
          proposal_id: typed.id,
          step_type: typed.step_type,
          edited: Boolean(editDiff),
          applied_entry_id: appliedEntryId,
        },
        actor: { type: 'user', id: user.id },
        occurredAt: new Date(),
      })
    }
  } catch (err) {
    console.error('[ai/accept] Failed to append AIProposalAccepted:', err)
  }

  // Emit event so orchestrator can chain match -> booking.
  try {
    await eventBus.emit({
      type: 'ai_proposal.accepted',
      payload: {
        proposal: finalProposal,
        appliedEntry: outcome.kind === 'booking_applied' ? outcome.journalEntry : null,
        userId: user.id,
        companyId,
      },
    })
  } catch (err) {
    console.error('[ai/accept] Event emit failed:', err)
  }

  return NextResponse.json({
    data: {
      proposal: finalProposal,
      applied_entry_id: appliedEntryId,
      learning_prompt:
        editDiff && typed.step_type === 'booking' && editedPayload
          ? buildLearningPromptHint(editedPayload as BookingProposalPayload, typed)
          : null,
    },
  })
}

// ── helpers ─────────────────────────────────────────────────────────

function computeEditDiff(
  proposal: AIProposal,
  edits: MatchProposalPayload | BookingProposalPayload | undefined
): Record<string, unknown> | null {
  if (!edits) return null
  const before = proposal.proposal_json as unknown
  const after = edits as unknown
  if (JSON.stringify(before) === JSON.stringify(after)) return null
  return { before, after }
}

/**
 * When the user edited a booking proposal, offer to save the corrected
 * shape as a counterparty template so next time's proposal starts from
 * the user's preference.
 */
function buildLearningPromptHint(
  edits: BookingProposalPayload,
  proposal: AIProposal
): { counterparty_name: string; debit_account: string; credit_account: string; vat_treatment: string | null } | null {
  const tpl = edits.counterparty_template_proposal
  if (!tpl) return null
  return {
    counterparty_name: tpl.counterparty_name,
    debit_account: tpl.debit_account,
    credit_account: tpl.credit_account,
    vat_treatment: tpl.vat_treatment,
  }
  // proposal is in signature for future refinement (e.g. embed original accounts for diff UI)
  void proposal
}
