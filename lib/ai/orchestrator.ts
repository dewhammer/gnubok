/**
 * AI agent orchestrator — event handler that wires the proposal lifecycle.
 *
 * Subscribes to:
 *   - inbox_item.classified   → generate match proposal (receipts, ai_flow_enabled)
 *   - ai_proposal.accepted    → chain match -> booking
 *   - transaction.categorized → skip pending proposals for that transaction's inbox item
 *
 * The generators themselves live in the ai-agent extension (Bedrock). When
 * the extension is not loaded (prod, or feature off), the service's noop
 * returns null and we issue a 'needs_manual' ai_request so the user still
 * sees the item needs action — no silent failure.
 */

import { createClient as createServiceClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events/bus'
import type { EventPayload } from '@/lib/events/types'
import { getAIProposalService } from '@/lib/ai/proposal-service'
import {
  insertProposal,
  insertRequest,
  skipPendingProposalsForSubject,
} from '@/lib/ai/proposals/persist'
import { createLogger } from '@/lib/logger'
import type {
  InvoiceInboxItem,
  Transaction,
  CategorizationTemplate,
  AIProposal,
} from '@/types'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  AIRequestResult,
  BookingProposalResult,
  MatchProposalResult,
} from '@/lib/ai/proposal-service'

const log = createLogger('ai-orchestrator')

/**
 * Service-role client for orchestrator writes.
 * Mirrors inbox-smart-match — the handler runs server-side and needs to
 * bypass RLS to write to ai_proposals, ai_requests, and read settings.
 */
function getServiceClient(): SupabaseClient {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// ── inbox_item.classified handler ────────────────────────────────────

async function handleInboxItemClassified(
  payload: EventPayload<'inbox_item.classified'>
): Promise<void> {
  const { inboxItem, documentType, correlationId, userId, companyId } = payload

  // v1 scope: only receipts.
  if (documentType !== 'receipt') return

  const supabase = getServiceClient()

  // Per-company gate.
  const { data: settings } = await supabase
    .from('company_settings')
    .select('ai_flow_enabled')
    .eq('company_id', companyId)
    .maybeSingle()

  if (!settings?.ai_flow_enabled) return

  await generateMatchProposalFor(supabase, {
    inboxItem,
    correlationId,
    userId,
    companyId,
  })
}

// ── ai_proposal.accepted handler (chain match -> booking) ───────────

async function handleProposalAccepted(
  payload: EventPayload<'ai_proposal.accepted'>
): Promise<void> {
  const { proposal, userId, companyId } = payload

  if (proposal.step_type !== 'match') return
  if (proposal.subject_type !== 'inbox_item') return

  const supabase = getServiceClient()

  // Load the inbox item + the matched transaction to feed the booking prompt.
  const { data: inboxItem } = await supabase
    .from('invoice_inbox_items')
    .select('*')
    .eq('id', proposal.subject_id)
    .eq('company_id', companyId)
    .maybeSingle()

  if (!inboxItem || !(inboxItem as InvoiceInboxItem).matched_transaction_id) {
    log.warn(`match accepted but no matched_transaction_id on inbox item ${proposal.subject_id}`)
    return
  }

  const item = inboxItem as InvoiceInboxItem

  // Defense in depth: don't chain to booking without a source document.
  // reValidateMatch already blocks this at accept time, but a stale accepted
  // proposal (from before the gate existed) could still reach here.
  if (!item.document_id) {
    log.warn(`refusing to chain booking for inbox item ${item.id} — no source document attached`)
    return
  }

  const { data: tx } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', item.matched_transaction_id!)
    .eq('company_id', companyId)
    .maybeSingle()

  if (!tx) {
    log.warn(`match accepted but transaction ${item.matched_transaction_id} not found`)
    return
  }

  // Existing counterparty templates to inform the booking prompt.
  const { data: templates } = await supabase
    .from('categorization_templates')
    .select('*')
    .eq('company_id', companyId)
    .eq('is_active', true)

  // Entity type for account routing.
  const { data: settings } = await supabase
    .from('company_settings')
    .select('entity_type')
    .eq('company_id', companyId)
    .maybeSingle()

  const entityType: 'enskild_firma' | 'aktiebolag' =
    (settings?.entity_type as 'enskild_firma' | 'aktiebolag') || 'enskild_firma'

  await generateBookingProposalFor(supabase, {
    inboxItem: item,
    matchedTransaction: tx as Transaction,
    existingTemplates: (templates || []) as CategorizationTemplate[],
    entityType,
    correlationId: item.correlation_id ?? undefined,
    userId,
    companyId,
  })
}

// ── transaction.categorized handler (skip on manual takeover) ───────

async function handleTransactionCategorized(
  payload: EventPayload<'transaction.categorized'>
): Promise<void> {
  const { transaction, companyId } = payload

  const supabase = getServiceClient()

  // Find any inbox items matched to this transaction with pending proposals.
  const { data: items } = await supabase
    .from('invoice_inbox_items')
    .select('id')
    .eq('company_id', companyId)
    .eq('matched_transaction_id', transaction.id)

  if (!items || items.length === 0) return

  for (const item of items) {
    await skipPendingProposalsForSubject(supabase, 'inbox_item', item.id, 'user_went_manual')
  }
}

// ── Generator dispatch ───────────────────────────────────────────────

interface GenerateMatchArgs {
  inboxItem: InvoiceInboxItem
  correlationId?: string
  userId: string
  companyId: string
}

async function generateMatchProposalFor(
  supabase: SupabaseClient,
  args: GenerateMatchArgs
): Promise<void> {
  const { inboxItem, correlationId, userId, companyId } = args

  const service = getAIProposalService()
  const result = await service.generateMatchProposal({ inboxItem, userId, companyId })

  if (result === null) {
    // Service outage or no extension loaded → needs_manual ask.
    await insertRequest(supabase, {
      companyId,
      subjectType: 'inbox_item',
      subjectId: inboxItem.id,
      requestType: 'needs_manual',
      message: 'AI-agenten är inte tillgänglig just nu — hantera manuellt.',
      correlationId,
    })
    return
  }

  if (result.kind === 'request') {
    await insertRequest(supabase, {
      companyId,
      subjectType: 'inbox_item',
      subjectId: inboxItem.id,
      requestType: result.request.request_type,
      message: result.request.message,
      requiredFields: result.request.required_fields,
      options: result.request.options as Record<string, unknown> | undefined,
      model: result.provenance.model,
      promptVersion: result.provenance.prompt_version,
      correlationId,
    })
    return
  }

  const proposal = await persistMatchProposal(supabase, result, {
    userId,
    companyId,
    subjectId: inboxItem.id,
    correlationId,
  })

  // Emit for metrics / audit subscribers.
  try {
    await eventBus.emit({
      type: 'ai_proposal.generated',
      payload: { proposal, userId, companyId },
    })
  } catch { /* non-blocking */ }
}

interface GenerateBookingArgs {
  inboxItem: InvoiceInboxItem
  matchedTransaction: Transaction
  existingTemplates: CategorizationTemplate[]
  entityType: 'enskild_firma' | 'aktiebolag'
  correlationId?: string
  userId: string
  companyId: string
}

async function generateBookingProposalFor(
  supabase: SupabaseClient,
  args: GenerateBookingArgs
): Promise<void> {
  const { inboxItem, matchedTransaction, existingTemplates, entityType, correlationId, userId, companyId } = args

  const service = getAIProposalService()
  const result = await service.generateBookingProposal({
    inboxItem,
    matchedTransaction,
    existingTemplates,
    entityType,
    userId,
    companyId,
  })

  if (result === null) {
    await insertRequest(supabase, {
      companyId,
      subjectType: 'inbox_item',
      subjectId: inboxItem.id,
      requestType: 'needs_manual',
      message: 'AI-agenten är inte tillgänglig just nu — bokför manuellt.',
      correlationId,
    })
    return
  }

  if (result.kind === 'request') {
    await insertRequest(supabase, {
      companyId,
      subjectType: 'inbox_item',
      subjectId: inboxItem.id,
      requestType: result.request.request_type,
      message: result.request.message,
      requiredFields: result.request.required_fields,
      options: result.request.options as Record<string, unknown> | undefined,
      model: result.provenance.model,
      promptVersion: result.provenance.prompt_version,
      correlationId,
    })
    return
  }

  const proposal = await persistBookingProposal(supabase, result, {
    userId,
    companyId,
    subjectId: inboxItem.id,
    correlationId,
  })

  try {
    await eventBus.emit({
      type: 'ai_proposal.generated',
      payload: { proposal, userId, companyId },
    })
  } catch { /* non-blocking */ }
}

// ── Persist helpers ──────────────────────────────────────────────────

interface PersistArgs {
  userId: string
  companyId: string
  subjectId: string
  correlationId?: string
}

async function persistMatchProposal(
  supabase: SupabaseClient,
  result: MatchProposalResult,
  args: PersistArgs
): Promise<AIProposal> {
  return insertProposal(supabase, {
    companyId: args.companyId,
    userId: args.userId,
    subjectType: 'inbox_item',
    subjectId: args.subjectId,
    stepType: 'match',
    proposalJson: result.proposal,
    confidence: result.confidence,
    reasoning: result.reasoning,
    model: result.provenance.model,
    promptVersion: result.provenance.prompt_version,
    inputTokens: result.provenance.input_tokens,
    outputTokens: result.provenance.output_tokens,
    correlationId: args.correlationId,
  })
}

async function persistBookingProposal(
  supabase: SupabaseClient,
  result: BookingProposalResult,
  args: PersistArgs
): Promise<AIProposal> {
  return insertProposal(supabase, {
    companyId: args.companyId,
    userId: args.userId,
    subjectType: 'inbox_item',
    subjectId: args.subjectId,
    stepType: 'booking',
    proposalJson: result.proposal,
    confidence: result.confidence,
    reasoning: result.reasoning,
    model: result.provenance.model,
    promptVersion: result.provenance.prompt_version,
    inputTokens: result.provenance.input_tokens,
    outputTokens: result.provenance.output_tokens,
    correlationId: args.correlationId,
  })
}

// ── Registration ─────────────────────────────────────────────────────

/**
 * Register the AI orchestrator on the core event bus. Called from lib/init.ts
 * alongside the other core handlers.
 */
export function registerAIProposalHandler(): () => void {
  const unsubs: Array<() => void> = [
    eventBus.on('inbox_item.classified', handleInboxItemClassified),
    eventBus.on('ai_proposal.accepted', handleProposalAccepted),
    eventBus.on('transaction.categorized', handleTransactionCategorized),
  ]

  return () => {
    unsubs.forEach((u) => u())
  }
}

// Exports for direct use from API routes (e.g., /api/ai/backfill/receipts).
export { generateMatchProposalFor, generateBookingProposalFor }
// Also re-export the unused result types so TS keeps them imported.
export type { MatchProposalResult, BookingProposalResult, AIRequestResult }
