/**
 * AI Proposal Service Interface
 *
 * Core defines the contract. The `ai-agent` extension registers a real
 * implementation backed by Bedrock. Without the extension, the noop service
 * is used — every call returns `null` and the orchestrator degrades by
 * issuing a `needs_manual` ai_request so the user sees the item and knows
 * they need to process it manually.
 *
 * Mirrors the pattern in lib/email/service.ts.
 */

import type {
  InvoiceInboxItem,
  Transaction,
  MatchProposalPayload,
  BookingProposalPayload,
  AIRequestType,
  CategorizationTemplate,
  PickTransactionOption,
} from '@/types'

// Shared fields any LLM call returns for audit.
export interface ProposalProvenance {
  model: string
  prompt_version: string
  input_tokens: number
  output_tokens: number
}

// When the AI produces a concrete suggestion.
export interface MatchProposalResult {
  kind: 'proposal'
  proposal: MatchProposalPayload
  confidence: number
  reasoning: string
  provenance: ProposalProvenance
}

export interface BookingProposalResult {
  kind: 'proposal'
  proposal: BookingProposalPayload
  confidence: number
  reasoning: string
  provenance: ProposalProvenance
}

// When the AI would rather ask the user than guess.
export interface AIRequestResult {
  kind: 'request'
  request: {
    request_type: AIRequestType
    message: string
    required_fields?: Record<string, unknown>
    options?: Record<string, unknown> | { candidates: PickTransactionOption[] }
  }
  provenance: Partial<ProposalProvenance>
}

// Context passed to each generator. Keeping the contract tight so extensions
// can't accidentally see more than they need.
export interface GenerateMatchContext {
  inboxItem: InvoiceInboxItem
  userId: string
  companyId: string
}

export interface GenerateBookingContext {
  inboxItem: InvoiceInboxItem
  matchedTransaction: Transaction
  existingTemplates: CategorizationTemplate[]
  entityType: 'enskild_firma' | 'aktiebolag'
  userId: string
  companyId: string
}

export interface AIProposalService {
  /** True when a real (non-noop) implementation is registered and ready. */
  isEnabled(): boolean

  /**
   * Propose which bank transaction matches an incoming receipt.
   * Returns null on service outage (orchestrator will issue needs_manual).
   */
  generateMatchProposal(
    ctx: GenerateMatchContext
  ): Promise<MatchProposalResult | AIRequestResult | null>

  /**
   * Propose how to book the matched transaction (accounts, VAT, lines).
   * Returns null on service outage (orchestrator will issue needs_manual).
   */
  generateBookingProposal(
    ctx: GenerateBookingContext
  ): Promise<BookingProposalResult | AIRequestResult | null>
}

class NoopAIProposalService implements AIProposalService {
  isEnabled(): boolean {
    return false
  }
  async generateMatchProposal(): Promise<null> {
    return null
  }
  async generateBookingProposal(): Promise<null> {
    return null
  }
}

let service: AIProposalService = new NoopAIProposalService()

export function getAIProposalService(): AIProposalService {
  return service
}

export function registerAIProposalService(svc: AIProposalService): void {
  service = svc
}

/** Reset to noop — for tests only. */
export function _resetAIProposalService(): void {
  service = new NoopAIProposalService()
}
