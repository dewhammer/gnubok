import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { gateAgentInbox } from '@/lib/ai/feature-flag'

ensureInitialized()

/**
 * GET /api/ai/proposals/[id]
 *
 * Returns the full proposal row plus the linked inbox item and, when
 * applicable, the matched transaction and already-applied journal entry.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = gateAgentInbox()
  if (gate) return gate

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)
  const { id } = await params

  const { data: proposal, error } = await supabase
    .from('ai_proposals')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!proposal) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Load the inbox item (only subject_type in v1) for context.
  const { data: inboxItem } = await supabase
    .from('invoice_inbox_items')
    .select('*, document:document_attachments!document_id(*)')
    .eq('id', proposal.subject_id)
    .eq('company_id', companyId)
    .maybeSingle()

  // Load the matched transaction if the inbox item has one.
  let transaction = null
  if (inboxItem?.matched_transaction_id) {
    const { data: tx } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', inboxItem.matched_transaction_id)
      .eq('company_id', companyId)
      .maybeSingle()
    transaction = tx
  }

  // For accepted booking proposals, fetch the applied journal entry.
  let journalEntry = null
  if (proposal.applied_entry_id) {
    const { data: entry } = await supabase
      .from('journal_entries')
      .select('*, lines:journal_entry_lines(*)')
      .eq('id', proposal.applied_entry_id)
      .eq('company_id', companyId)
      .maybeSingle()
    journalEntry = entry
  }

  return NextResponse.json({
    data: {
      proposal,
      inbox_item: inboxItem ?? null,
      transaction,
      journal_entry: journalEntry,
    },
  })
}
