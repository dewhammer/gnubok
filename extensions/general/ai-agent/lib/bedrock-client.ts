/**
 * Shared Bedrock Converse client for the ai-agent extension.
 * Mirrors inbox-smart-match's setup so the model + env var conventions stay
 * consistent across all LLM-backed extensions.
 */

import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime'

let _client: BedrockRuntimeClient | null = null

export function getBedrockClient(): BedrockRuntimeClient {
  if (!_client) {
    _client = new BedrockRuntimeClient({
      region: process.env.AWS_REGION || 'eu-north-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    })
  }
  return _client
}

export function getModelId(): string {
  return process.env.BEDROCK_MODEL_ID || 'eu.anthropic.claude-sonnet-4-6'
}

export function getMaxTokens(): number {
  return parseInt(process.env.BEDROCK_MAX_TOKENS || '2048', 10)
}
