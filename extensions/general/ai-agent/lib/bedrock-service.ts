/**
 * BedrockAIProposalService — the AIProposalService implementation registered
 * by the ai-agent extension. Each method dispatches to the relevant generator
 * and returns whatever the generator produced (proposal / request / null).
 */

import type {
  AIProposalService,
  AIRequestResult,
  BookingProposalResult,
  GenerateBookingContext,
  GenerateMatchContext,
  MatchProposalResult,
} from '@/lib/ai/proposal-service'
import { generateMatchForExtension } from './generate-match'
import { generateBookingForExtension } from './generate-booking'

export class BedrockAIProposalService implements AIProposalService {
  isEnabled(): boolean {
    // The extension only loads when enabled in extensions.config.json, so any
    // registered instance is enabled by definition. We still gate on AWS
    // credentials so a misconfigured env surfaces as "null -> needs_manual"
    // rather than a Bedrock exception per call.
    return Boolean(
      process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      process.env.AWS_REGION
    )
  }

  async generateMatchProposal(
    ctx: GenerateMatchContext
  ): Promise<MatchProposalResult | AIRequestResult | null> {
    if (!this.isEnabled()) return null
    return generateMatchForExtension(ctx)
  }

  async generateBookingProposal(
    ctx: GenerateBookingContext
  ): Promise<BookingProposalResult | AIRequestResult | null> {
    if (!this.isEnabled()) return null
    return generateBookingForExtension(ctx)
  }
}
