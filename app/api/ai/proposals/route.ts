import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ensureInitialized } from '@/lib/init'
import { validateQuery } from '@/lib/api/validate'
import { ListProposalsQuerySchema } from '@/lib/api/schemas'
import { requireCompanyId } from '@/lib/company/context'
import { gateAgentInbox } from '@/lib/ai/feature-flag'

ensureInitialized()

/**
 * GET /api/ai/proposals
 *
 * List AI proposals for the active company, newest first.
 * Query params:
 *   status?:    pending | accepted | rejected | skipped | invalidated
 *   step_type?: match | booking
 *   limit?:     default 20, max 100
 *   offset?:    default 0
 *
 * Returns { data: AIProposal[], count: number }.
 */
export async function GET(request: Request) {
  const gate = gateAgentInbox()
  if (gate) return gate

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)

  const qs = validateQuery(request, ListProposalsQuerySchema)
  if (!qs.success) return qs.response
  const { status, step_type, limit, offset } = qs.data

  let query = supabase
    .from('ai_proposals')
    .select('*', { count: 'exact' })
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (status) query = query.eq('status', status)
  if (step_type) query = query.eq('step_type', step_type)

  const { data, error, count } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data, count: count ?? data?.length ?? 0 })
}
