/**
 * Match proposal generator for the ai-agent extension.
 *
 * Returns a MatchProposalResult when the LLM identifies a good candidate,
 * an AIRequestResult when input is insufficient (bad extraction) or no
 * candidates are available (user must upload the missing transaction first),
 * or null on Bedrock outage so the orchestrator emits a 'needs_manual' ask.
 */

import {
  ConverseCommand,
  type ContentBlock,
  type Message,
} from '@aws-sdk/client-bedrock-runtime'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { fetchCandidateTransactions, getMatchAnchors } from '@/extensions/general/inbox-smart-match/lib/fetch-candidates'
import type { ExtractedDocument } from '@/extensions/general/inbox-smart-match/lib/fetch-candidates'
import type {
  AIRequestResult,
  GenerateMatchContext,
  MatchProposalResult,
} from '@/lib/ai/proposal-service'
import type { MatchProposalAlternative } from '@/types'
import { getBedrockClient, getModelId, getMaxTokens } from './bedrock-client'
import {
  MATCH_PROMPT_VERSION,
  MATCH_SYSTEM_PROMPT,
  MATCH_TOOL_CONFIG,
} from './prompts/match-prompt'

export async function generateMatchForExtension(
  ctx: GenerateMatchContext
): Promise<MatchProposalResult | AIRequestResult | null> {
  const extracted = ctx.inboxItem.extracted_data as unknown as ExtractedDocument | null

  // Guard: extraction quality.
  const anchors = getMatchAnchors(extracted)
  if (!anchors) {
    return {
      kind: 'request',
      request: {
        request_type: 'reupload_document',
        message:
          'Jag kunde inte läsa av datum eller belopp från kvittot. Ladda upp en tydligare bild så försöker jag igen.',
      },
      provenance: { prompt_version: MATCH_PROMPT_VERSION },
    }
  }

  // Fetch candidates using the shared deterministic narrowing.
  const serviceClient = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  let candidates
  try {
    candidates = await fetchCandidateTransactions(serviceClient, ctx.companyId, extracted)
  } catch (err) {
    console.error('[ai-agent/match] fetchCandidateTransactions failed:', err)
    return null
  }

  if (candidates.length === 0) {
    return {
      kind: 'request',
      request: {
        request_type: 'pick_transaction',
        message:
          'Jag hittade ingen matchande banktransaktion. Vänta på nästa banksync eller välj manuellt.',
        options: { candidates: [] },
      },
      provenance: { prompt_version: MATCH_PROMPT_VERSION },
    }
  }

  // Call Bedrock.
  const receiptBrief = {
    merchant: anchors.counterpartyName,
    amount: anchors.amount,
    currency: anchors.currency,
    date: anchors.date,
    vat_amount: extracted?.totals?.vatAmount ?? null,
  }

  const candidateLines = candidates.map((c) => ({
    id: c.id,
    date: c.date,
    description: c.description,
    amount: c.amount,
    amount_sek: c.amount_sek,
    currency: c.currency,
    merchant_name: c.merchant_name,
  }))

  const userPrompt = `Kvitto:
${JSON.stringify(receiptBrief, null, 2)}

Kandidat-transaktioner:
${JSON.stringify(candidateLines, null, 2)}

Vilken matchar? Om ingen matchar, returnera matched=false.`

  const messages: Message[] = [{ role: 'user', content: [{ text: userPrompt }] }]

  let response
  try {
    response = await getBedrockClient().send(
      new ConverseCommand({
        modelId: getModelId(),
        messages,
        system: [{ text: MATCH_SYSTEM_PROMPT }],
        toolConfig: MATCH_TOOL_CONFIG,
        inferenceConfig: { maxTokens: getMaxTokens(), temperature: 0 },
      })
    )
  } catch (err) {
    console.error('[ai-agent/match] Bedrock call failed:', err)
    return null
  }

  const usage = {
    input_tokens: response.usage?.inputTokens ?? 0,
    output_tokens: response.usage?.outputTokens ?? 0,
  }

  const toolUse = response.output?.message?.content?.find(
    (b): b is ContentBlock.ToolUseMember => 'toolUse' in b && b.toolUse !== undefined
  )

  if (!toolUse?.toolUse?.input) {
    return null
  }

  const raw = toolUse.toolUse.input as Record<string, unknown>
  const matched = Boolean(raw.matched)
  const rawId = typeof raw.transaction_id === 'string' ? raw.transaction_id : null
  const confidence = clampConfidence(Number(raw.confidence))
  const reasoning = typeof raw.reasoning === 'string' ? raw.reasoning.trim() : ''

  // Resolve alternatives, filtering to only valid candidate IDs.
  const candidateIds = new Set(candidates.map((c) => c.id))
  const rawAlts = Array.isArray(raw.alternatives) ? raw.alternatives : []
  const alternatives: MatchProposalAlternative[] = rawAlts
    .map((a) => a as Record<string, unknown>)
    .filter((a) => typeof a.transaction_id === 'string' && candidateIds.has(a.transaction_id as string))
    .map((a) => ({
      transaction_id: a.transaction_id as string,
      confidence: clampConfidence(Number(a.confidence)),
      reasoning: typeof a.reasoning === 'string' ? a.reasoning.trim() : '',
    }))
    .slice(0, 3)

  if (!matched || !rawId || !candidateIds.has(rawId)) {
    // LLM declined or returned unresolvable ID — degrade to pick_transaction ask.
    return {
      kind: 'request',
      request: {
        request_type: 'pick_transaction',
        message:
          'AI:n är osäker på matchning. Välj manuellt bland kandidaterna eller vänta på fler banktransaktioner.',
        options: { candidates: candidateLines },
      },
      provenance: {
        model: getModelId(),
        prompt_version: MATCH_PROMPT_VERSION,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
      },
    }
  }

  return {
    kind: 'proposal',
    proposal: {
      matched_transaction_id: rawId,
      alternatives,
      top_confidence: confidence,
    },
    confidence,
    reasoning,
    provenance: {
      model: getModelId(),
      prompt_version: MATCH_PROMPT_VERSION,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
    },
  }
}

function clampConfidence(raw: number): number {
  if (!isFinite(raw)) return 0
  return Math.min(1, Math.max(0, raw / 100))
}
