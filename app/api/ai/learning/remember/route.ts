import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { RememberLearningSchema } from '@/lib/api/schemas'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { calculateConfidence } from '@/lib/bookkeeping/counterparty-templates'
import { gateAgentInbox } from '@/lib/ai/feature-flag'
import type { AIProposal } from '@/types'

ensureInitialized()

/**
 * POST /api/ai/learning/remember
 *
 * Called from the UI's learning-prompt dialog after a user edited and
 * accepted an AI booking proposal. Upserts a categorization_templates row
 * with source='ai_corrected' so next time's proposal for the same
 * counterparty starts from the user's preference.
 *
 * This is the ONLY path that creates an ai_corrected template — the
 * "silent learning" rule means every template with this source represents
 * an explicit user choice.
 */
export async function POST(request: Request) {
  const gate = gateAgentInbox()
  if (gate) return gate

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const validation = await validateBody(request, RememberLearningSchema)
  if (!validation.success) return validation.response
  const {
    proposal_id,
    counterparty_name,
    debit_account,
    credit_account,
    vat_treatment,
    category,
  } = validation.data

  // Verify the proposal is accepted + belongs to this company.
  const { data: proposal } = await supabase
    .from('ai_proposals')
    .select('*')
    .eq('id', proposal_id)
    .eq('company_id', companyId)
    .maybeSingle()

  if (!proposal) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const typed = proposal as AIProposal
  if (typed.status !== 'accepted') {
    return NextResponse.json(
      { error: 'Endast accepterade förslag kan lagras som mall.' },
      { status: 400 }
    )
  }
  if (typed.step_type !== 'booking') {
    return NextResponse.json(
      { error: 'Endast bokföringssteget kan lagras som mall.' },
      { status: 400 }
    )
  }

  // Upsert the template. Existing row for the same (user_id, counterparty_name)
  // gets its source bumped up and occurrence incremented.
  const { data: existing } = await supabase
    .from('categorization_templates')
    .select('*')
    .eq('user_id', user.id)
    .eq('counterparty_name', counterparty_name)
    .maybeSingle()

  const today = new Date().toISOString().slice(0, 10)

  if (existing) {
    const newOccurrence = existing.occurrence_count + 1
    await supabase
      .from('categorization_templates')
      .update({
        debit_account,
        credit_account,
        vat_treatment,
        category,
        source: 'ai_corrected',
        occurrence_count: newOccurrence,
        confidence: calculateConfidence(newOccurrence),
        last_seen_date: today,
        is_active: true,
      })
      .eq('id', existing.id)

    return NextResponse.json({ data: { template_id: existing.id, updated: true } })
  }

  const { data: created, error: insertError } = await supabase
    .from('categorization_templates')
    .insert({
      user_id: user.id,
      company_id: companyId,
      counterparty_name,
      counterparty_aliases: [counterparty_name],
      debit_account,
      credit_account,
      vat_treatment,
      category,
      source: 'ai_corrected',
      occurrence_count: 1,
      confidence: calculateConfidence(1),
      last_seen_date: today,
      is_active: true,
    })
    .select()
    .single()

  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 })

  return NextResponse.json({ data: { template_id: created.id, updated: false } })
}
