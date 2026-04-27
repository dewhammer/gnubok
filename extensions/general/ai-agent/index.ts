import type { Extension } from '@/lib/extensions/types'
import { registerAIProposalService } from '@/lib/ai/proposal-service'
import { BedrockAIProposalService } from './lib/bedrock-service'

// Register the Bedrock-backed implementation at extension load time.
// The orchestrator (lib/ai/orchestrator.ts) calls getAIProposalService() at
// event-handle time and will get this instance whenever the extension is
// enabled in extensions.config.json.
registerAIProposalService(new BedrockAIProposalService())

export const aiAgentExtension: Extension = {
  id: 'ai-agent',
  name: 'AI-agent (beta)',
  version: '0.1.0',
}
