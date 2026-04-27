import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { eventBus } from '@/lib/events/bus'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { BatchAcceptSchema } from '@/lib/api/schemas'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { reValidateProposal } from '@/lib/ai/proposals/re-validate'
import { applyProposal } from '@/lib/ai/proposals/apply'
import { gateAgentInbox } from '@/lib/ai/feature-flag'
import type { AIProposal, InvoiceInboxItem } from '@/types'

ensureInitialized()

interface BatchOutcomePerProposal {
  proposal_id: string
  ok: boolean
  error?: string
  code?: string
  applied_entry_id?: string | null
}

/**
 * POST /api/ai/proposals/batch-accept
 *
 * Accept multiple pending proposals in one click. Best-effort: each item is
 * independently re-validated and applied. The response contains per-item
 * outcomes so the UI can show checkmarks + specific failure messages
 * (e.g., "fiscal period closed since you loaded the page").
 *
 * No edits are supported in batch mode — edits require the user to open the
 * individual proposal and approve from there.
 */
export async function POST(request: Request) {
  const gate = gateAgentInbox()
  if (gate) return gate

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const validation = await validateBody(request, BatchAcceptSchema)
  if (!validation.success) return validation.response
  const { proposal_ids } = validation.data

  const outcomes: BatchOutcomePerProposal[] = []

  for (const proposalId of proposal_ids) {
    const outcome = await acceptOne(supabase, companyId, user.id, proposalId)
    outcomes.push(outcome)
  }

  return NextResponse.json({
    data: {
      outcomes,
      accepted: outcomes.filter((o) => o.ok).length,
      failed: outcomes.filter((o) => !o.ok).length,
    },
  })
}

async function acceptOne(
  supabase: Awaited<ReturnType<typeof createClient>>,
  companyId: string,
  userId: string,
  proposalId: string
): Promise<BatchOutcomePerProposal> {
  const { data: proposal } = await supabase
    .from('ai_proposals')
    .select('*')
    .eq('id', proposalId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (!proposal) return { proposal_id: proposalId, ok: false, error: 'Not found', code: 'not_found' }

  const typed = proposal as AIProposal
  if (typed.status !== 'pending') {
    return { proposal_id: proposalId, ok: false, error: `Already ${typed.status}`, code: 'not_pending' }
  }

  const check = await reValidateProposal(supabase, companyId, typed)
  if (!check.ok) {
    await supabase
      .from('ai_proposals')
      .update({ status: 'invalidated', invalidated_reason: check.code })
      .eq('id', typed.id)
      .eq('version', typed.version)
    return { proposal_id: proposalId, ok: false, error: check.message, code: check.code }
  }

  const inboxItem = check.inboxItem as InvoiceInboxItem

  let outcome
  try {
    outcome = await applyProposal(supabase, companyId, userId, typed, inboxItem)
  } catch (err) {
    return {
      proposal_id: proposalId,
      ok: false,
      error: err instanceof Error ? err.message : 'apply_failed',
      code: 'apply_failed',
    }
  }

  const appliedEntryId =
    outcome.kind === 'booking_applied' ? outcome.journalEntry.id : null

  const { data: updated } = await supabase
    .from('ai_proposals')
    .update({
      status: 'accepted',
      accepted_at: new Date().toISOString(),
      accepted_by_user_id: userId,
      version: typed.version + 1,
      applied_entry_id: appliedEntryId,
    })
    .eq('id', typed.id)
    .eq('version', typed.version)
    .select()
    .maybeSingle()

  try {
    await eventBus.emit({
      type: 'ai_proposal.accepted',
      payload: {
        proposal: (updated as AIProposal | null) ?? typed,
        appliedEntry: outcome.kind === 'booking_applied' ? outcome.journalEntry : null,
        userId,
        companyId,
      },
    })
  } catch { /* non-blocking */ }

  return { proposal_id: proposalId, ok: true, applied_entry_id: appliedEntryId }
}
