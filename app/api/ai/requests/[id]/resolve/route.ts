import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { ResolveRequestSchema } from '@/lib/api/schemas'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { gateAgentInbox } from '@/lib/ai/feature-flag'
import type { AIRequest, InvoiceInboxItem } from '@/types'

ensureInitialized()

/**
 * POST /api/ai/requests/[id]/resolve
 *
 * Mark an open ai_request as resolved. The response body is stored on the
 * row for audit, but the actual follow-up action (re-upload doc, pick a
 * transaction manually, set a VAT rate) is wired through the existing
 * domain endpoints — the UI calls those separately. This endpoint just
 * closes out the request card.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = gateAgentInbox()
  if (gate) return gate

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)
  const { id } = await params

  const validation = await validateBody(request, ResolveRequestSchema)
  if (!validation.success) return validation.response
  const { response } = validation.data

  const { data: req } = await supabase
    .from('ai_requests')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle()

  if (!req) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const typed = req as AIRequest
  if (typed.status !== 'open') {
    return NextResponse.json(
      { error: 'Begäran är redan hanterad.', status: typed.status },
      { status: 409 }
    )
  }

  const { data: updated, error: updateError } = await supabase
    .from('ai_requests')
    .update({
      status: 'resolved',
      resolved_at: new Date().toISOString(),
      resolved_by_user_id: user.id,
      response_json: response ?? null,
    })
    .eq('id', typed.id)
    .eq('status', 'open')
    .select()
    .maybeSingle()

  if (updateError || !updated) {
    return NextResponse.json({ error: 'Kunde inte uppdatera' }, { status: 500 })
  }

  // Audit.
  try {
    const { data: inbox } = await supabase
      .from('invoice_inbox_items')
      .select('correlation_id')
      .eq('id', typed.subject_id)
      .maybeSingle()
    const item = inbox as Pick<InvoiceInboxItem, 'correlation_id'> | null
    if (item?.correlation_id) {
      await appendProcessingHistory({
        companyId,
        correlationId: item.correlation_id,
        aggregateType: 'AIRequest',
        aggregateId: typed.id,
        eventType: 'AIRequestResolved',
        payload: {
          request_id: typed.id,
          request_type: typed.request_type,
          has_response: Boolean(response),
        },
        actor: { type: 'user', id: user.id },
        occurredAt: new Date(),
      })
    }
  } catch (err) {
    console.error('[ai/requests/resolve] Failed to append AIRequestResolved:', err)
  }

  return NextResponse.json({ data: { request: updated } })
}
