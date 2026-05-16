/**
 * Guard against schema-strictness regression on MCP tool inputs.
 *
 * Every tool's `inputSchema` must declare `additionalProperties: false` so
 * agents receive a clear rejection on typos/hallucinated fields instead of a
 * silent ignore. This is item 8 of the agent-native API plan
 * (dev_docs/api_ai_architecture/PLAN.md).
 *
 * If this test fires on a newly authored tool, add the field to the tool's
 * top-level inputSchema. Don't relax the guard.
 */
import { describe, it, expect } from 'vitest'
import { tools } from '../server'

describe('MCP tool inputSchema strictness', () => {
  it('every tool inputSchema has additionalProperties: false at the top level', () => {
    const missing = tools
      .filter((t) => {
        const schema = t.inputSchema as Record<string, unknown> | undefined
        return !schema || schema.additionalProperties !== false
      })
      .map((t) => t.name)
    expect(missing).toEqual([])
  })
})
