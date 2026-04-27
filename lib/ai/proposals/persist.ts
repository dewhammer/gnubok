/**
 * Persistence helpers for ai_proposals and ai_requests.
 *
 * - Inserts new proposals, invalidating any prior pending proposal for the
 *   same (subject, step) first to keep the partial unique index happy.
 * - Inserts new ai_requests with the same idempotency on (subject, request_type).
 * - Appends processing_history audit events so the timeline on the inbox
 *   item tells the full story: DocumentIngested -> DocumentClassified ->
 *   AIProposalGenerated -> AIProposalAccepted -> JournalEntryPosted.
 *
 * All writes use the caller's Supabase client — service role for orchestrator
 * context (RLS bypassed), user client for API route context (RLS enforced).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  AIProposal,
  AIProposalStepType,
  AIRequest,
  AIRequestType,
  AISubjectType,
  InvoiceInboxItem,
  MatchProposalPayload,
  BookingProposalPayload,
} from '@/types'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { createLogger } from '@/lib/logger'

const log = createLogger('ai-proposals/persist')

// ── Proposal insert ──────────────────────────────────────────────────

export interface InsertProposalInput {
  companyId: string
  userId: string
  subjectType: AISubjectType
  subjectId: string
  stepType: AIProposalStepType
  proposalJson: MatchProposalPayload | BookingProposalPayload
  confidence: number
  reasoning: string
  model: string
  promptVersion: string
  inputTokens: number
  outputTokens: number
  aiRequestId?: string | null
  correlationId?: string
}

/**
 * Insert a new pending proposal. Invalidates any prior pending proposal for
 * the same (subject, step) first so the partial unique index accepts the
 * new row and the audit trail reflects the replacement.
 */
export async function insertProposal(
  supabase: SupabaseClient,
  input: InsertProposalInput
): Promise<AIProposal> {
  // 1. Invalidate any prior pending proposal for this (subject, step).
  await supabase
    .from('ai_proposals')
    .update({
      status: 'invalidated',
      invalidated_reason: 'superseded_by_new_proposal',
    })
    .eq('subject_type', input.subjectType)
    .eq('subject_id', input.subjectId)
    .eq('step_type', input.stepType)
    .eq('status', 'pending')

  // 2. Insert the new proposal.
  const { data, error } = await supabase
    .from('ai_proposals')
    .insert({
      company_id: input.companyId,
      user_id: input.userId,
      subject_type: input.subjectType,
      subject_id: input.subjectId,
      step_type: input.stepType,
      status: 'pending',
      proposal_json: input.proposalJson,
      confidence: input.confidence,
      reasoning: input.reasoning,
      model: input.model,
      prompt_version: input.promptVersion,
      input_token_count: input.inputTokens,
      output_token_count: input.outputTokens,
      ai_request_id: input.aiRequestId ?? null,
    })
    .select()
    .single()

  if (error || !data) {
    throw new Error(`Failed to insert ai_proposal: ${error?.message}`)
  }

  const proposal = data as AIProposal

  // 3. Audit: AIProposalGenerated
  if (input.correlationId) {
    try {
      await appendProcessingHistory({
        companyId: input.companyId,
        correlationId: input.correlationId,
        aggregateType: 'AIProposal',
        aggregateId: proposal.id,
        eventType: 'AIProposalGenerated',
        payload: {
          proposal_id: proposal.id,
          subject_type: input.subjectType,
          subject_id: input.subjectId,
          step_type: input.stepType,
          confidence: input.confidence,
          model: input.model,
          prompt_version: input.promptVersion,
          input_tokens: input.inputTokens,
          output_tokens: input.outputTokens,
        },
        actor: { type: 'llm', id: 'ai-agent' },
        occurredAt: new Date(),
      })
    } catch (err) {
      log.error('Failed to append AIProposalGenerated:', err)
    }
  }

  return proposal
}

// ── Request insert ───────────────────────────────────────────────────

export interface InsertRequestInput {
  companyId: string
  subjectType: AISubjectType
  subjectId: string
  requestType: AIRequestType
  message: string
  requiredFields?: Record<string, unknown>
  options?: Record<string, unknown>
  model?: string
  promptVersion?: string
  correlationId?: string
}

export async function insertRequest(
  supabase: SupabaseClient,
  input: InsertRequestInput
): Promise<AIRequest> {
  // Idempotency: if an open request of the same (subject, request_type) exists,
  // update it in place rather than erroring on the partial unique index.
  const { data: existing } = await supabase
    .from('ai_requests')
    .select('id')
    .eq('subject_type', input.subjectType)
    .eq('subject_id', input.subjectId)
    .eq('request_type', input.requestType)
    .eq('status', 'open')
    .maybeSingle()

  if (existing) {
    const { data: updated, error: updateError } = await supabase
      .from('ai_requests')
      .update({
        message: input.message,
        required_fields: input.requiredFields ?? null,
        options: input.options ?? null,
        model: input.model ?? null,
        prompt_version: input.promptVersion ?? null,
      })
      .eq('id', existing.id)
      .select()
      .single()

    if (updateError || !updated) {
      throw new Error(`Failed to update ai_request: ${updateError?.message}`)
    }
    return updated as AIRequest
  }

  const { data, error } = await supabase
    .from('ai_requests')
    .insert({
      company_id: input.companyId,
      subject_type: input.subjectType,
      subject_id: input.subjectId,
      request_type: input.requestType,
      message: input.message,
      required_fields: input.requiredFields ?? null,
      options: input.options ?? null,
      model: input.model ?? null,
      prompt_version: input.promptVersion ?? null,
      status: 'open',
    })
    .select()
    .single()

  if (error || !data) {
    throw new Error(`Failed to insert ai_request: ${error?.message}`)
  }

  const request = data as AIRequest

  if (input.correlationId) {
    try {
      await appendProcessingHistory({
        companyId: input.companyId,
        correlationId: input.correlationId,
        aggregateType: 'AIRequest',
        aggregateId: request.id,
        eventType: 'AIRequestCreated',
        payload: {
          request_id: request.id,
          subject_type: input.subjectType,
          subject_id: input.subjectId,
          request_type: input.requestType,
        },
        actor: { type: 'llm', id: 'ai-agent' },
        occurredAt: new Date(),
      })
    } catch (err) {
      log.error('Failed to append AIRequestCreated:', err)
    }
  }

  return request
}

// ── Helpers ─────────────────────────────────────────────────────────

export async function fetchInboxItem(
  supabase: SupabaseClient,
  companyId: string,
  inboxItemId: string
): Promise<InvoiceInboxItem | null> {
  const { data } = await supabase
    .from('invoice_inbox_items')
    .select('*')
    .eq('id', inboxItemId)
    .eq('company_id', companyId)
    .maybeSingle()
  return data as InvoiceInboxItem | null
}

/**
 * Mark all pending proposals for an inbox item as skipped. Used when the
 * user bypassed the AI flow and took a manual action (categorize,
 * match-invoice, match-supplier-invoice) on the linked transaction.
 */
export async function skipPendingProposalsForSubject(
  supabase: SupabaseClient,
  subjectType: AISubjectType,
  subjectId: string,
  reason: string
): Promise<void> {
  await supabase
    .from('ai_proposals')
    .update({
      status: 'skipped',
      invalidated_reason: reason,
    })
    .eq('subject_type', subjectType)
    .eq('subject_id', subjectId)
    .eq('status', 'pending')
}
