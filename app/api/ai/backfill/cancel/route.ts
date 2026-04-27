import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { gateAgentInbox } from '@/lib/ai/feature-flag'

ensureInitialized()

/**
 * POST /api/ai/backfill/cancel
 *
 * Set the kill switch flag on company_settings. The running backfill loop
 * checks this between items and exits cleanly. Already-generated proposals
 * stay — the cancel just stops further generation.
 */
export async function POST() {
  const gate = gateAgentInbox()
  if (gate) return gate

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const { error } = await supabase
    .from('company_settings')
    .update({ ai_backfill_cancel_requested: true })
    .eq('company_id', companyId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data: { cancelled: true } })
}
