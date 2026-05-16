import { describe, it, expect } from 'vitest'
import { tools } from '../server'

describe('tools/list payload size guard', () => {
  it('keeps the projected tools/list payload under the context-budget ceiling', () => {
    const projection = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
      annotations: t.annotations,
      ...(t._meta ? { _meta: t._meta } : {}),
    }))
    const payload = JSON.stringify({ tools: projection })
    const approxTokens = Math.round(payload.length / 4)
    // Ceiling raised from 20K → 25K when item 8 of the agent-native API plan landed
    // (additionalProperties: false on all 67 inputSchemas + period_status in the staged
    // operation envelope). Long-term answer to growth is item 15 (Tool Search +
    // defer_loading) — not relaxing this guard further. If this fires, prefer trimming
    // descriptions or leaning on gnubok_search_tools before bumping again.
    expect(approxTokens).toBeLessThan(25_000)
  })
})
