import { describe, it, expect, vi } from 'vitest'
import { reValidateProposal } from '../re-validate'
import type { AIProposal, BookingProposalPayload, MatchProposalPayload, InvoiceInboxItem } from '@/types'

// Minimal proposal factory.
function makeProposal(overrides: Partial<AIProposal> = {}): AIProposal {
  return {
    id: 'proposal-1',
    company_id: 'company-1',
    user_id: 'user-1',
    subject_type: 'inbox_item',
    subject_id: 'inbox-1',
    step_type: 'match',
    status: 'pending',
    version: 1,
    proposal_json: {
      matched_transaction_id: 'tx-1',
      alternatives: [],
      top_confidence: 0.9,
    } as MatchProposalPayload,
    confidence: 0.9,
    reasoning: 'test',
    ai_request_id: null,
    model: 'test',
    prompt_version: 'test-v1',
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
    ...overrides,
  }
}

function makeInboxItem(overrides: Partial<InvoiceInboxItem> = {}): InvoiceInboxItem {
  // Only the fields re-validate inspects need to be realistic.
  return {
    id: 'inbox-1',
    company_id: 'company-1',
    user_id: 'user-1',
    status: 'ready',
    source: 'upload',
    document_id: 'doc-1',
    document_type: 'receipt',
    extracted_data: null,
    confidence: null,
    matched_supplier_id: null,
    matched_transaction_id: null,
    match_confidence: null,
    match_method: null,
    match_reasoning: null,
    raw_llm_response: null,
    email_from: null,
    email_subject: null,
    email_received_at: null,
    email_body_text: null,
    resend_email_id: null,
    resend_attachment_id: null,
    raw_email_payload: null,
    correlation_id: null,
    created_supplier_invoice_id: null,
    error_message: null,
    created_at: '2026-04-23T00:00:00Z',
    updated_at: '2026-04-23T00:00:00Z',
    ...overrides,
  } as unknown as InvoiceInboxItem
}

/**
 * Build a scripted supabase mock where each `.from(table)` returns a chain
 * whose terminal awaits resolve in FIFO order from the `results` queue.
 */
function scriptedSupabase(results: Array<{ data: unknown; error?: unknown }>) {
  let i = 0
  const buildChain = (): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          const next = results[i++] ?? { data: null, error: null }
          return (resolve: (v: unknown) => void) =>
            resolve({ data: next.data ?? null, error: next.error ?? null })
        }
        return () => buildChain()
      },
    }
    return new Proxy({}, handler)
  }
  return {
    from: vi.fn().mockImplementation(() => buildChain()),
    rpc: vi.fn().mockImplementation(() => buildChain()),
  } as unknown as import('@supabase/supabase-js').SupabaseClient
}

describe('reValidateProposal', () => {
  it('inbox item missing → fails with inbox_item_missing', async () => {
    const proposal = makeProposal()
    const supabase = scriptedSupabase([{ data: null }])

    const result = await reValidateProposal(supabase, 'company-1', proposal)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('inbox_item_missing')
  })

  it('inbox item already confirmed → fails with inbox_item_already_booked', async () => {
    const proposal = makeProposal()
    const supabase = scriptedSupabase([
      { data: makeInboxItem({ status: 'confirmed' }) },
    ])

    const result = await reValidateProposal(supabase, 'company-1', proposal)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('inbox_item_already_booked')
  })

  it('match proposal → transaction missing → fails', async () => {
    const proposal = makeProposal({ step_type: 'match' })
    const supabase = scriptedSupabase([
      { data: makeInboxItem() },
      { data: null }, // transaction lookup → not found
    ])

    const result = await reValidateProposal(supabase, 'company-1', proposal)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('transaction_missing')
  })

  it('match proposal → transaction already booked → fails', async () => {
    const proposal = makeProposal({ step_type: 'match' })
    const supabase = scriptedSupabase([
      { data: makeInboxItem() },
      { data: { id: 'tx-1', journal_entry_id: 'entry-1', company_id: 'company-1' } },
    ])

    const result = await reValidateProposal(supabase, 'company-1', proposal)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('transaction_already_booked')
  })

  it('match proposal → happy path → ok', async () => {
    const proposal = makeProposal({ step_type: 'match' })
    const supabase = scriptedSupabase([
      { data: makeInboxItem() },
      { data: { id: 'tx-1', journal_entry_id: null, company_id: 'company-1' } },
      { data: null }, // no other inbox item claims this transaction
    ])

    const result = await reValidateProposal(supabase, 'company-1', proposal)

    expect(result.ok).toBe(true)
  })

  it('booking proposal → no matched_transaction_id → step_prerequisite_missing', async () => {
    const proposal = makeProposal({
      step_type: 'booking',
      proposal_json: {
        lines: [
          { account_number: '5410', debit_amount: 100, credit_amount: 0, description: 'x' },
          { account_number: '1930', debit_amount: 0, credit_amount: 100, description: 'x' },
        ],
        vat_treatment: 'exempt',
        default_private: false,
        counterparty_template_proposal: null,
        fiscal_period_id: 'period-1',
        entry_date: '2026-04-23',
        description: 'test',
      } as BookingProposalPayload,
    })
    const supabase = scriptedSupabase([{ data: makeInboxItem({ matched_transaction_id: null }) }])

    const result = await reValidateProposal(supabase, 'company-1', proposal)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('step_prerequisite_missing')
  })

  it('booking proposal → period closed → period_missing_or_closed', async () => {
    const proposal = makeProposal({
      step_type: 'booking',
      proposal_json: {
        lines: [
          { account_number: '5410', debit_amount: 100, credit_amount: 0, description: 'x' },
          { account_number: '1930', debit_amount: 0, credit_amount: 100, description: 'x' },
        ],
        vat_treatment: 'exempt',
        default_private: false,
        counterparty_template_proposal: null,
        fiscal_period_id: 'period-1',
        entry_date: '2026-04-23',
        description: 'test',
      } as BookingProposalPayload,
    })
    const supabase = scriptedSupabase([
      { data: makeInboxItem({ matched_transaction_id: 'tx-1' }) },
      { data: { id: 'tx-1', journal_entry_id: null } },
      { data: { id: 'period-1', is_closed: true, locked_at: null } },
    ])

    const result = await reValidateProposal(supabase, 'company-1', proposal)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('period_missing_or_closed')
  })

  it('booking proposal → grocery merchant + reduced_12 + 2026-04-15 → livsmedel_vat_rate_stale', async () => {
    const proposal = makeProposal({
      step_type: 'booking',
      proposal_json: {
        lines: [
          { account_number: '4010', debit_amount: 80, credit_amount: 0, description: 'Matvaror ICA Maxi' },
          { account_number: '2641', debit_amount: 9.6, credit_amount: 0, description: 'Ingående moms 12%' },
          { account_number: '1930', debit_amount: 0, credit_amount: 89.6, description: 'ICA Maxi' },
        ],
        vat_treatment: 'reduced_12',
        default_private: false,
        counterparty_template_proposal: null,
        fiscal_period_id: 'period-1',
        entry_date: '2026-04-15',
        description: 'ICA Maxi — matvaror',
      } as BookingProposalPayload,
    })
    const supabase = scriptedSupabase([
      { data: makeInboxItem({ matched_transaction_id: 'tx-1', extracted_data: { merchant_name: 'ICA Maxi Lindhagen' } }) },
      { data: { id: 'tx-1', journal_entry_id: null } },
      { data: { id: 'period-1', is_closed: false, locked_at: null } },
      { data: [
        { account_number: '4010', is_active: true },
        { account_number: '2641', is_active: true },
        { account_number: '1930', is_active: true },
      ] },
    ])

    const result = await reValidateProposal(supabase, 'company-1', proposal)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('livsmedel_vat_rate_stale')
      expect(result.details?.expected).toBe('reduced_6')
    }
  })

  it('booking proposal → grocery merchant + reduced_6 + 2026-04-15 → ok', async () => {
    const proposal = makeProposal({
      step_type: 'booking',
      proposal_json: {
        lines: [
          { account_number: '4010', debit_amount: 80, credit_amount: 0, description: 'Matvaror ICA' },
          { account_number: '2641', debit_amount: 4.8, credit_amount: 0, description: 'Ingående moms 6%' },
          { account_number: '1930', debit_amount: 0, credit_amount: 84.8, description: 'ICA' },
        ],
        vat_treatment: 'reduced_6',
        default_private: false,
        counterparty_template_proposal: null,
        fiscal_period_id: 'period-1',
        entry_date: '2026-04-15',
        description: 'ICA Maxi — matvaror',
      } as BookingProposalPayload,
    })
    const supabase = scriptedSupabase([
      { data: makeInboxItem({ matched_transaction_id: 'tx-1', extracted_data: { merchant_name: 'ICA Maxi' } }) },
      { data: { id: 'tx-1', journal_entry_id: null } },
      { data: { id: 'period-1', is_closed: false, locked_at: null } },
      { data: [
        { account_number: '4010', is_active: true },
        { account_number: '2641', is_active: true },
        { account_number: '1930', is_active: true },
      ] },
    ])

    const result = await reValidateProposal(supabase, 'company-1', proposal)

    expect(result.ok).toBe(true)
  })

  it('booking proposal → grocery merchant + reduced_6 + 2025-12-15 → livsmedel_vat_rate_stale', async () => {
    const proposal = makeProposal({
      step_type: 'booking',
      proposal_json: {
        lines: [
          { account_number: '4010', debit_amount: 80, credit_amount: 0, description: 'Matvaror Coop' },
          { account_number: '2641', debit_amount: 4.8, credit_amount: 0, description: 'Ingående moms 6%' },
          { account_number: '1930', debit_amount: 0, credit_amount: 84.8, description: 'Coop' },
        ],
        vat_treatment: 'reduced_6',
        default_private: false,
        counterparty_template_proposal: null,
        fiscal_period_id: 'period-1',
        entry_date: '2025-12-15',
        description: 'Coop — matvaror',
      } as BookingProposalPayload,
    })
    const supabase = scriptedSupabase([
      { data: makeInboxItem({ matched_transaction_id: 'tx-1', extracted_data: { merchant_name: 'Coop Konsum' } }) },
      { data: { id: 'tx-1', journal_entry_id: null } },
      { data: { id: 'period-1', is_closed: false, locked_at: null } },
      { data: [
        { account_number: '4010', is_active: true },
        { account_number: '2641', is_active: true },
        { account_number: '1930', is_active: true },
      ] },
    ])

    const result = await reValidateProposal(supabase, 'company-1', proposal)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('livsmedel_vat_rate_stale')
      expect(result.details?.expected).toBe('reduced_12')
    }
  })

  it('booking proposal → restaurang + reduced_6 → livsmedel_vat_rate_stale', async () => {
    const proposal = makeProposal({
      step_type: 'booking',
      proposal_json: {
        lines: [
          { account_number: '5810', debit_amount: 80, credit_amount: 0, description: 'Lunch på restaurang' },
          { account_number: '2641', debit_amount: 4.8, credit_amount: 0, description: 'Ingående moms 6%' },
          { account_number: '1930', debit_amount: 0, credit_amount: 84.8, description: 'Restaurang' },
        ],
        vat_treatment: 'reduced_6',
        default_private: false,
        counterparty_template_proposal: null,
        fiscal_period_id: 'period-1',
        entry_date: '2026-04-15',
        description: 'Restaurang Frantzén — lunch',
      } as BookingProposalPayload,
    })
    const supabase = scriptedSupabase([
      { data: makeInboxItem({ matched_transaction_id: 'tx-1', extracted_data: { merchant_name: 'Restaurang Frantzén' } }) },
      { data: { id: 'tx-1', journal_entry_id: null } },
      { data: { id: 'period-1', is_closed: false, locked_at: null } },
      { data: [
        { account_number: '5810', is_active: true },
        { account_number: '2641', is_active: true },
        { account_number: '1930', is_active: true },
      ] },
    ])

    const result = await reValidateProposal(supabase, 'company-1', proposal)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('livsmedel_vat_rate_stale')
      expect(result.details?.signal).toBe('restaurang')
    }
  })

  it('booking proposal → restaurang + reduced_12 → ok (servering stays at 12%)', async () => {
    const proposal = makeProposal({
      step_type: 'booking',
      proposal_json: {
        lines: [
          { account_number: '5810', debit_amount: 80, credit_amount: 0, description: 'Lunch' },
          { account_number: '2641', debit_amount: 9.6, credit_amount: 0, description: 'Ingående moms 12%' },
          { account_number: '1930', debit_amount: 0, credit_amount: 89.6, description: 'Restaurang' },
        ],
        vat_treatment: 'reduced_12',
        default_private: false,
        counterparty_template_proposal: null,
        fiscal_period_id: 'period-1',
        entry_date: '2026-04-15',
        description: 'Restaurang — lunch',
      } as BookingProposalPayload,
    })
    const supabase = scriptedSupabase([
      { data: makeInboxItem({ matched_transaction_id: 'tx-1', extracted_data: { merchant_name: 'Restaurang Frantzén' } }) },
      { data: { id: 'tx-1', journal_entry_id: null } },
      { data: { id: 'period-1', is_closed: false, locked_at: null } },
      { data: [
        { account_number: '5810', is_active: true },
        { account_number: '2641', is_active: true },
        { account_number: '1930', is_active: true },
      ] },
    ])

    const result = await reValidateProposal(supabase, 'company-1', proposal)

    expect(result.ok).toBe(true)
  })

  it('booking proposal → inactive account → account_missing_or_inactive', async () => {
    const proposal = makeProposal({
      step_type: 'booking',
      proposal_json: {
        lines: [
          { account_number: '5410', debit_amount: 100, credit_amount: 0, description: 'x' },
          { account_number: '1930', debit_amount: 0, credit_amount: 100, description: 'x' },
        ],
        vat_treatment: 'exempt',
        default_private: false,
        counterparty_template_proposal: null,
        fiscal_period_id: 'period-1',
        entry_date: '2026-04-23',
        description: 'test',
      } as BookingProposalPayload,
    })
    const supabase = scriptedSupabase([
      { data: makeInboxItem({ matched_transaction_id: 'tx-1' }) },
      { data: { id: 'tx-1', journal_entry_id: null } },
      { data: { id: 'period-1', is_closed: false, locked_at: null } },
      // Only 1930 is active; 5410 missing from results.
      { data: [{ account_number: '1930', is_active: true }] },
    ])

    const result = await reValidateProposal(supabase, 'company-1', proposal)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('account_missing_or_inactive')
      expect(result.details?.missing_accounts).toEqual(['5410'])
    }
  })
})
