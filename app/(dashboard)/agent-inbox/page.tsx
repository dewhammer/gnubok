import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { ensureInitialized } from '@/lib/init'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { isAgentInboxEnabled } from '@/lib/ai/feature-flag'
import { requireCompanyId } from '@/lib/company/context'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Sparkles } from 'lucide-react'
import AgentInbox from '@/components/agent-inbox/AgentInbox'
import type { AIProposal, AIRequest, InvoiceInboxItem, Transaction, DocumentAttachment, MatchProposalPayload } from '@/types'

ensureInitialized()

// Expanded card data the client component needs to render each proposal's
// context (receipt thumbnail + matched transaction summary).
export interface AgentInboxItemView {
  proposal: AIProposal | null
  request: AIRequest | null
  inbox_item: InvoiceInboxItem & { document: DocumentAttachment | null }
  transaction: Transaction | null
}

export default async function AgentInboxPage() {
  // Hard gate: extension not enabled at build time, OR the feature flag is
  // off in this environment (prod by default) → 404.
  if (!ENABLED_EXTENSION_IDS.has('ai-agent') || !isAgentInboxEnabled()) {
    notFound()
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const companyId = await requireCompanyId(supabase, user.id)

  // Soft gate: per-company toggle. If not enabled, show an empty-state
  // pointing to settings rather than 404 — the extension exists, the user
  // just hasn't opted in yet.
  const { data: settings } = await supabase
    .from('company_settings')
    .select('ai_flow_enabled')
    .eq('company_id', companyId)
    .maybeSingle()

  if (!settings?.ai_flow_enabled) {
    return (
      <div className="container mx-auto p-4 sm:p-8 max-w-5xl">
        <PageHeader
          title="Agent-inkorg"
          description="AI föreslår bokföring — du godkänner varje steg."
        />
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="p-5 rounded-full bg-muted mb-6">
              <Sparkles className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium mb-2">AI-agenten är inte aktiverad</h3>
            <p className="text-sm text-muted-foreground text-center max-w-sm mb-6">
              Aktivera AI-agenten under bokföringsinställningar. Varje transaktion blir då ett
              granskningsförslag istället för automatisk bokföring.
            </p>
            <Button asChild>
              <Link href="/settings/bookkeeping">Gå till inställningar</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Load all pending proposals + open requests for the company, newest first.
  const [{ data: proposals }, { data: requests }] = await Promise.all([
    supabase
      .from('ai_proposals')
      .select('*')
      .eq('company_id', companyId)
      .in('status', ['pending'])
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('ai_requests')
      .select('*')
      .eq('company_id', companyId)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(50),
  ])

  const typedProposals = (proposals ?? []) as AIProposal[]
  const typedRequests = (requests ?? []) as AIRequest[]

  // Collect subject_ids and fetch inbox items + transactions in one pass.
  const subjectIds = new Set<string>([
    ...typedProposals.map((p) => p.subject_id),
    ...typedRequests.map((r) => r.subject_id),
  ])

  const items: AgentInboxItemView[] = []
  if (subjectIds.size > 0) {
    const { data: inboxRows } = await supabase
      .from('invoice_inbox_items')
      .select('*, document:document_attachments!document_id(*)')
      .in('id', [...subjectIds])
      .eq('company_id', companyId)

    const inboxMap = new Map<string, InvoiceInboxItem & { document: DocumentAttachment | null }>()
    for (const row of inboxRows ?? []) {
      inboxMap.set(row.id, row as InvoiceInboxItem & { document: DocumentAttachment | null })
    }

    // Collect transaction IDs from two sources:
    //   1. inbox_item.matched_transaction_id — set after a match is accepted
    //      (used by booking cards to show the paired transaction).
    //   2. proposal_json.matched_transaction_id on pending match proposals —
    //      the transaction the AI is *proposing*; needed so match cards can
    //      show a human-readable description instead of a raw UUID.
    const matchedTxIds = [
      ...new Set([
        ...[...inboxMap.values()]
          .map((i) => i.matched_transaction_id)
          .filter((id): id is string => Boolean(id)),
        ...typedProposals
          .filter((p) => p.step_type === 'match')
          .map((p) => (p.proposal_json as MatchProposalPayload).matched_transaction_id)
          .filter((id): id is string => Boolean(id)),
      ]),
    ]

    const txMap = new Map<string, Transaction>()
    if (matchedTxIds.length > 0) {
      const { data: txRows } = await supabase
        .from('transactions')
        .select('*')
        .in('id', matchedTxIds)
        .eq('company_id', companyId)
      for (const tx of txRows ?? []) txMap.set(tx.id, tx as Transaction)
    }

    // Build the view: one card per (subject, step). Proposals first, requests second.
    for (const proposal of typedProposals) {
      const inbox = inboxMap.get(proposal.subject_id)
      if (!inbox) continue
      // Match cards render the transaction being *proposed*; booking cards render
      // the transaction already accepted on the inbox item.
      const txId = proposal.step_type === 'match'
        ? (proposal.proposal_json as MatchProposalPayload).matched_transaction_id
        : inbox.matched_transaction_id
      items.push({
        proposal,
        request: null,
        inbox_item: inbox,
        transaction: txId ? txMap.get(txId) ?? null : null,
      })
    }
    for (const request of typedRequests) {
      const inbox = inboxMap.get(request.subject_id)
      if (!inbox) continue
      items.push({
        proposal: null,
        request,
        inbox_item: inbox,
        transaction: inbox.matched_transaction_id ? txMap.get(inbox.matched_transaction_id) ?? null : null,
      })
    }
  }

  return <AgentInbox initialItems={items} />
}
