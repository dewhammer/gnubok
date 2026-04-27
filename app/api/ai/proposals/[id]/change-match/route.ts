import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { ChangeMatchProposalSchema } from '@/lib/api/schemas'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { gateAgentInbox } from '@/lib/ai/feature-flag'
import type { AIProposal, InvoiceInboxItem, MatchProposalPayload } from '@/types'

ensureInitialized()

/**
 * POST /api/ai/proposals/[id]/change-match
 *
 * Swap the matched_transaction_id on a pending match proposal without
 * accepting it. Lets the user verify a different candidate (AI alternative,
 * AI-regenerated, or manually picked) before hitting Godkänn.
 *
 * - Keeps status='pending' so the user still has to explicitly accept.
 * - Bumps version (optimistic lock) and records edit_diff with before/after +
 *   source so we can later measure how often the AI's top pick gets overridden
 *   and by which merchant/path.
 * - Sets confidence to 1.0 (user-picked transactions are certain).
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

  const validation = await validateBody(request, ChangeMatchProposalSchema)
  if (!validation.success) return validation.response
  const { version, matched_transaction_id, source } = validation.data

  const { data: proposalRow } = await supabase
    .from('ai_proposals')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle()

  if (!proposalRow) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const proposal = proposalRow as AIProposal

  if (proposal.status !== 'pending') {
    return NextResponse.json(
      { error: 'Förslaget har redan hanterats.', status: proposal.status },
      { status: 409 }
    )
  }

  if (proposal.step_type !== 'match') {
    return NextResponse.json(
      { error: 'Bara match-förslag kan byta transaktion.' },
      { status: 400 }
    )
  }

  if (proposal.version !== version) {
    return NextResponse.json(
      { error: 'Förslaget har ändrats av en annan användare — ladda om.' },
      { status: 409 }
    )
  }

  // Validate the new transaction: same company, uncategorized, no journal entry.
  const { data: tx } = await supabase
    .from('transactions')
    .select('id, company_id, journal_entry_id')
    .eq('id', matched_transaction_id)
    .eq('company_id', companyId)
    .maybeSingle()

  if (!tx) {
    return NextResponse.json(
      { error: 'Transaktionen hittades inte.' },
      { status: 404 }
    )
  }

  if (tx.journal_entry_id) {
    return NextResponse.json(
      { error: 'Transaktionen är redan bokförd.' },
      { status: 409 }
    )
  }

  const originalPayload = proposal.proposal_json as MatchProposalPayload

  // No-op? Return current state.
  if (originalPayload.matched_transaction_id === matched_transaction_id) {
    return NextResponse.json({ data: { proposal } })
  }

  const newPayload: MatchProposalPayload = {
    ...originalPayload,
    matched_transaction_id,
    top_confidence: 1,
  }

  const editDiff = {
    before: originalPayload,
    after: newPayload,
    source,
    changed_at: new Date().toISOString(),
    changed_by_user_id: user.id,
  }

  const { data: updatedRows, error: updateError } = await supabase
    .from('ai_proposals')
    .update({
      proposal_json: newPayload,
      confidence: 1,
      edit_diff: editDiff,
      version: proposal.version + 1,
    })
    .eq('id', proposal.id)
    .eq('version', version)
    .select()

  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })
  if (!updatedRows || updatedRows.length === 0) {
    return NextResponse.json(
      { error: 'Förslaget har ändrats av en annan användare — ladda om.' },
      { status: 409 }
    )
  }

  const finalProposal = updatedRows[0] as AIProposal

  // Audit trail.
  try {
    const { data: inboxItem } = await supabase
      .from('invoice_inbox_items')
      .select('correlation_id')
      .eq('id', proposal.subject_id)
      .maybeSingle()

    const item = inboxItem as Pick<InvoiceInboxItem, 'correlation_id'> | null

    if (item?.correlation_id) {
      await appendProcessingHistory({
        companyId,
        correlationId: item.correlation_id,
        aggregateType: 'AIProposal',
        aggregateId: proposal.id,
        eventType: 'AIProposalMatchChanged',
        payload: {
          proposal_id: proposal.id,
          from_transaction_id: originalPayload.matched_transaction_id,
          to_transaction_id: matched_transaction_id,
          source,
        },
        actor: { type: 'user', id: user.id },
        occurredAt: new Date(),
      })
    }
  } catch (err) {
    console.error('[ai/change-match] Failed to append AIProposalMatchChanged:', err)
  }

  return NextResponse.json({ data: { proposal: finalProposal } })
}
