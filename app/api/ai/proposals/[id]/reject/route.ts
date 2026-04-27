import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { eventBus } from '@/lib/events/bus'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { RejectProposalSchema } from '@/lib/api/schemas'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { gateAgentInbox } from '@/lib/ai/feature-flag'
import type { AIProposal, InvoiceInboxItem } from '@/types'

ensureInitialized()

/**
 * POST /api/ai/proposals/[id]/reject
 *
 * Mark a pending proposal as rejected. The orchestrator will NOT chain the
 * next step — the user has signalled the AI got this one wrong. Subsequent
 * action (upload new doc, manually categorize, etc.) is up to the user.
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

  const validation = await validateBody(request, RejectProposalSchema)
  if (!validation.success) return validation.response
  const { version, reason } = validation.data

  const { data: proposal } = await supabase
    .from('ai_proposals')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle()

  if (!proposal) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const typed = proposal as AIProposal

  if (typed.status !== 'pending') {
    return NextResponse.json(
      { error: 'Förslaget har redan hanterats.', status: typed.status },
      { status: 409 }
    )
  }

  const { data: updatedRows, error: updateError } = await supabase
    .from('ai_proposals')
    .update({
      status: 'rejected',
      rejected_at: new Date().toISOString(),
      invalidated_reason: reason ?? null,
      version: typed.version + 1,
    })
    .eq('id', typed.id)
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
      .eq('id', typed.subject_id)
      .maybeSingle()

    const item = inboxItem as Pick<InvoiceInboxItem, 'correlation_id'> | null

    if (item?.correlation_id) {
      await appendProcessingHistory({
        companyId,
        correlationId: item.correlation_id,
        aggregateType: 'AIProposal',
        aggregateId: typed.id,
        eventType: 'AIProposalRejected',
        payload: { proposal_id: typed.id, step_type: typed.step_type, reason: reason ?? null },
        actor: { type: 'user', id: user.id },
        occurredAt: new Date(),
      })
    }
  } catch (err) {
    console.error('[ai/reject] Failed to append AIProposalRejected:', err)
  }

  try {
    await eventBus.emit({
      type: 'ai_proposal.rejected',
      payload: { proposal: finalProposal, userId: user.id, companyId },
    })
  } catch { /* non-blocking */ }

  return NextResponse.json({ data: { proposal: finalProposal } })
}
