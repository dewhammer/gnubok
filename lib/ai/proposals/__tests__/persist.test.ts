import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock processing-history append BEFORE importing persist — the module
// grabs `createServiceClient` at import time, which needs env vars we
// don't care about here.
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue('evt-1'),
}))

import { insertProposal, insertRequest, skipPendingProposalsForSubject } from '../persist'
import type { MatchProposalPayload } from '@/types'

/**
 * Build a scripted supabase mock where each chained operation is tracked
 * so the test can inspect what was called. Each `.from(...)` returns a new
 * chain; the `.update(...)` and `.insert(...)` calls capture payloads;
 * the await resolves to a scripted result via the `results` queue.
 */
interface Call {
  table: string
  op: 'update' | 'insert' | 'select' | 'other'
  payload?: unknown
  filters: Array<{ key: string; value: unknown }>
}

function scriptedSupabase(results: Array<{ data?: unknown; error?: unknown }>) {
  const calls: Call[] = []
  let resultIdx = 0

  const makeChain = (table: string) => {
    const current: Call = { table, op: 'other', filters: [] }
    calls.push(current)
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          const next = results[resultIdx++] ?? { data: null, error: null }
          return (resolve: (v: unknown) => void) =>
            resolve({ data: next.data ?? null, error: next.error ?? null })
        }
        return (...args: unknown[]) => {
          if (prop === 'update') {
            current.op = 'update'
            current.payload = args[0]
          } else if (prop === 'insert') {
            current.op = 'insert'
            current.payload = args[0]
          } else if (prop === 'select') {
            current.op = current.op === 'other' ? 'select' : current.op
          } else if (prop === 'eq') {
            current.filters.push({ key: String(args[0]), value: args[1] })
          }
          return chain
        }
      },
    }
    const chain = new Proxy({}, handler)
    return chain
  }

  const client = {
    from: vi.fn().mockImplementation((table: string) => makeChain(table)),
  }

  return { client, calls }
}

describe('insertProposal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('invalidates prior pending before inserting new', async () => {
    const { client, calls } = scriptedSupabase([
      // update (invalidate)
      { data: null },
      // insert + select + single
      {
        data: {
          id: 'proposal-new',
          company_id: 'c1',
          user_id: 'u1',
          subject_type: 'inbox_item',
          subject_id: 'inbox-1',
          step_type: 'match',
          status: 'pending',
          version: 1,
          proposal_json: {},
          confidence: 0.9,
          reasoning: 'x',
          ai_request_id: null,
          model: 'm',
          prompt_version: 'v1',
          input_token_count: 0,
          output_token_count: 0,
          edit_diff: null,
          applied_entry_id: null,
          invalidated_reason: null,
          created_at: '2026-04-23T00:00:00Z',
          accepted_at: null,
          accepted_by_user_id: null,
          rejected_at: null,
          updated_at: '2026-04-23T00:00:00Z',
        },
      },
    ])

    const payload: MatchProposalPayload = {
      matched_transaction_id: 'tx-1',
      alternatives: [],
      top_confidence: 0.9,
    }

    const result = await insertProposal(
      client as unknown as import('@supabase/supabase-js').SupabaseClient,
      {
        companyId: 'c1',
        userId: 'u1',
        subjectType: 'inbox_item',
        subjectId: 'inbox-1',
        stepType: 'match',
        proposalJson: payload,
        confidence: 0.9,
        reasoning: 'x',
        model: 'm',
        promptVersion: 'v1',
        inputTokens: 0,
        outputTokens: 0,
      }
    )

    expect(result.id).toBe('proposal-new')

    // Expect two .from('ai_proposals') calls:
    //   1. update → invalidate prior
    //   2. insert → new row
    const aiProposalCalls = calls.filter((c) => c.table === 'ai_proposals')
    expect(aiProposalCalls).toHaveLength(2)
    expect(aiProposalCalls[0].op).toBe('update')
    expect(aiProposalCalls[0].payload).toMatchObject({
      status: 'invalidated',
      invalidated_reason: 'superseded_by_new_proposal',
    })
    expect(aiProposalCalls[1].op).toBe('insert')
    expect(aiProposalCalls[1].payload).toMatchObject({
      company_id: 'c1',
      subject_id: 'inbox-1',
      step_type: 'match',
      status: 'pending',
    })
  })

  it('throws when insert returns an error', async () => {
    const { client } = scriptedSupabase([
      { data: null }, // update OK
      { data: null, error: { message: 'boom' } }, // insert fails
    ])

    await expect(
      insertProposal(
        client as unknown as import('@supabase/supabase-js').SupabaseClient,
        {
          companyId: 'c1',
          userId: 'u1',
          subjectType: 'inbox_item',
          subjectId: 'inbox-1',
          stepType: 'match',
          proposalJson: { matched_transaction_id: 'tx-1', alternatives: [], top_confidence: 0.9 },
          confidence: 0.9,
          reasoning: 'x',
          model: 'm',
          promptVersion: 'v1',
          inputTokens: 0,
          outputTokens: 0,
        }
      )
    ).rejects.toThrow(/Failed to insert ai_proposal/)
  })
})

describe('insertRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('updates existing open request with the same (subject, type) instead of inserting', async () => {
    const { client, calls } = scriptedSupabase([
      // existing lookup
      { data: { id: 'req-existing' } },
      // update
      {
        data: {
          id: 'req-existing',
          company_id: 'c1',
          subject_type: 'inbox_item',
          subject_id: 'inbox-1',
          request_type: 'needs_manual',
          message: 'updated',
          required_fields: null,
          options: null,
          status: 'open',
          response_json: null,
          resolved_at: null,
          resolved_by_user_id: null,
          model: null,
          prompt_version: null,
          created_at: '2026-04-23T00:00:00Z',
          updated_at: '2026-04-23T00:00:00Z',
        },
      },
    ])

    const result = await insertRequest(
      client as unknown as import('@supabase/supabase-js').SupabaseClient,
      {
        companyId: 'c1',
        subjectType: 'inbox_item',
        subjectId: 'inbox-1',
        requestType: 'needs_manual',
        message: 'updated',
      }
    )

    expect(result.id).toBe('req-existing')

    const updateCall = calls.find((c) => c.table === 'ai_requests' && c.op === 'update')
    expect(updateCall).toBeDefined()
    expect(updateCall!.payload).toMatchObject({ message: 'updated' })

    // No insert was performed (would have been a second ai_requests call with op=insert).
    const insertCall = calls.find((c) => c.table === 'ai_requests' && c.op === 'insert')
    expect(insertCall).toBeUndefined()
  })

  it('inserts a new request when none exists', async () => {
    const { client, calls } = scriptedSupabase([
      // existing lookup → none
      { data: null },
      // insert
      {
        data: {
          id: 'req-new',
          company_id: 'c1',
          subject_type: 'inbox_item',
          subject_id: 'inbox-1',
          request_type: 'reupload_document',
          message: 'new ask',
          required_fields: null,
          options: null,
          status: 'open',
          response_json: null,
          resolved_at: null,
          resolved_by_user_id: null,
          model: null,
          prompt_version: null,
          created_at: '2026-04-23T00:00:00Z',
          updated_at: '2026-04-23T00:00:00Z',
        },
      },
    ])

    const result = await insertRequest(
      client as unknown as import('@supabase/supabase-js').SupabaseClient,
      {
        companyId: 'c1',
        subjectType: 'inbox_item',
        subjectId: 'inbox-1',
        requestType: 'reupload_document',
        message: 'new ask',
      }
    )

    expect(result.id).toBe('req-new')
    const insertCall = calls.find((c) => c.table === 'ai_requests' && c.op === 'insert')
    expect(insertCall).toBeDefined()
  })
})

describe('skipPendingProposalsForSubject', () => {
  it('updates all pending proposals for the subject to skipped', async () => {
    const { client, calls } = scriptedSupabase([{ data: null }])

    await skipPendingProposalsForSubject(
      client as unknown as import('@supabase/supabase-js').SupabaseClient,
      'inbox_item',
      'inbox-1',
      'user_went_manual'
    )

    const call = calls.find((c) => c.table === 'ai_proposals')
    expect(call?.op).toBe('update')
    expect(call?.payload).toMatchObject({
      status: 'skipped',
      invalidated_reason: 'user_went_manual',
    })
  })
})
