import { NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import {
  generateMatchProposalFor,
  generateBookingProposalFor,
} from '@/lib/ai/orchestrator'
import { gateAgentInbox } from '@/lib/ai/feature-flag'
import type {
  InvoiceInboxItem,
  Transaction,
  CategorizationTemplate,
} from '@/types'
import type { SupabaseClient } from '@supabase/supabase-js'

ensureInitialized()

/**
 * POST /api/ai/backfill/receipts
 *
 * Generate AI proposals for the existing receipt backlog:
 *   - inbox items with document_type='receipt' and status='ready' that
 *     have no pending match proposal → generate match
 *   - items with matched_transaction_id and no booked journal entry but
 *     no pending booking proposal → generate booking
 *
 * Fire-and-forget: returns immediately with `{ queued }`. The loop
 * iterates in the background, checking `company_settings.ai_backfill_cancel_requested`
 * between items so the user can stop it. Idempotent via the partial
 * unique index on (subject, step) WHERE pending — re-clicking does no harm.
 *
 * NOTE: relies on long-lived Node/Vercel worker to complete the loop. For
 * v1 dev-only this is acceptable; a proper job queue is a follow-up.
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

  // Gate on the per-company flag.
  const { data: settings } = await supabase
    .from('company_settings')
    .select('ai_flow_enabled, ai_backfill_cancel_requested')
    .eq('company_id', companyId)
    .maybeSingle()

  if (!settings?.ai_flow_enabled) {
    return NextResponse.json(
      { error: 'AI-agenten är inte aktiverad.' },
      { status: 400 }
    )
  }

  // Reset the cancel flag so a previous cancel doesn't kill this run.
  await supabase
    .from('company_settings')
    .update({ ai_backfill_cancel_requested: false })
    .eq('company_id', companyId)

  // Count eligible items up front for the response.
  const { data: eligibleMatch } = await supabase
    .from('invoice_inbox_items')
    .select('id')
    .eq('company_id', companyId)
    .eq('document_type', 'receipt')
    .eq('status', 'ready')
    .is('matched_transaction_id', null)

  const { data: eligibleBooking } = await supabase
    .from('invoice_inbox_items')
    .select('id')
    .eq('company_id', companyId)
    .eq('document_type', 'receipt')
    .eq('status', 'ready')
    .not('matched_transaction_id', 'is', null)

  const matchCount = eligibleMatch?.length ?? 0
  const bookingCount = eligibleBooking?.length ?? 0

  // Kick off the background loop. Intentionally NOT awaited.
  runBackfill(companyId, user.id).catch((err) => {
    console.error('[ai/backfill/receipts] loop failed:', err)
  })

  return NextResponse.json({
    data: {
      queued_match: matchCount,
      queued_booking: bookingCount,
    },
  })
}

/**
 * Run the backfill loop using a service-role client so the orchestrator's
 * inserts bypass RLS (mirrors how orchestrator writes from event handlers).
 */
async function runBackfill(companyId: string, userId: string): Promise<void> {
  const service: SupabaseClient = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Pass 1: generate match proposals.
  const { data: matchItems } = await service
    .from('invoice_inbox_items')
    .select('*')
    .eq('company_id', companyId)
    .eq('document_type', 'receipt')
    .eq('status', 'ready')
    .is('matched_transaction_id', null)

  for (const item of (matchItems || []) as InvoiceInboxItem[]) {
    if (await isCancelled(service, companyId)) return

    // Skip if a pending match proposal already exists.
    const { data: existing } = await service
      .from('ai_proposals')
      .select('id')
      .eq('subject_type', 'inbox_item')
      .eq('subject_id', item.id)
      .eq('step_type', 'match')
      .eq('status', 'pending')
      .maybeSingle()

    if (existing) continue

    try {
      await generateMatchProposalFor(service, {
        inboxItem: item,
        correlationId: item.correlation_id ?? undefined,
        userId,
        companyId,
      })
    } catch (err) {
      console.error(`[ai/backfill] match failed for ${item.id}:`, err)
    }
  }

  // Pass 2: generate booking proposals for already-matched items.
  const { data: bookingItems } = await service
    .from('invoice_inbox_items')
    .select('*')
    .eq('company_id', companyId)
    .eq('document_type', 'receipt')
    .eq('status', 'ready')
    .not('matched_transaction_id', 'is', null)

  const { data: settings } = await service
    .from('company_settings')
    .select('entity_type')
    .eq('company_id', companyId)
    .maybeSingle()
  const entityType: 'enskild_firma' | 'aktiebolag' =
    (settings?.entity_type as 'enskild_firma' | 'aktiebolag') || 'enskild_firma'

  const { data: templates } = await service
    .from('categorization_templates')
    .select('*')
    .eq('company_id', companyId)
    .eq('is_active', true)

  for (const item of (bookingItems || []) as InvoiceInboxItem[]) {
    if (await isCancelled(service, companyId)) return

    const { data: existing } = await service
      .from('ai_proposals')
      .select('id')
      .eq('subject_type', 'inbox_item')
      .eq('subject_id', item.id)
      .eq('step_type', 'booking')
      .eq('status', 'pending')
      .maybeSingle()

    if (existing) continue

    const { data: tx } = await service
      .from('transactions')
      .select('*')
      .eq('id', item.matched_transaction_id!)
      .eq('company_id', companyId)
      .maybeSingle()

    if (!tx || (tx as Transaction).journal_entry_id) continue

    try {
      await generateBookingProposalFor(service, {
        inboxItem: item,
        matchedTransaction: tx as Transaction,
        existingTemplates: (templates || []) as CategorizationTemplate[],
        entityType,
        correlationId: item.correlation_id ?? undefined,
        userId,
        companyId,
      })
    } catch (err) {
      console.error(`[ai/backfill] booking failed for ${item.id}:`, err)
    }
  }
}

async function isCancelled(
  service: SupabaseClient,
  companyId: string
): Promise<boolean> {
  const { data } = await service
    .from('company_settings')
    .select('ai_backfill_cancel_requested')
    .eq('company_id', companyId)
    .maybeSingle()
  return Boolean(data?.ai_backfill_cancel_requested)
}
