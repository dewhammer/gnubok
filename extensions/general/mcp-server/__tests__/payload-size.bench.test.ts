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
    // Ceiling chosen with headroom over the current ~11K-token payload.
    // If this fires, either tools were added or descriptions drifted back to verbose;
    // re-trim or rely on gnubok_search_tools for progressive disclosure.
    expect(approxTokens).toBeLessThan(20_000)
  })
})
