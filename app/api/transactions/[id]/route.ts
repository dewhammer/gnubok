import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { UpdateTransactionTitleSchema } from '@/lib/api/schemas'
import { guardSandbox } from '@/lib/sandbox/guard'
import type { Transaction } from '@/types'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { id } = await params

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  // Fetch the transaction with ownership check
  const { data: transaction, error: fetchError } = await supabase
    .from('transactions')
    .select('id, journal_entry_id')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !transaction) {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  }

  // Guard: only unbooked transactions can be deleted
  if (transaction.journal_entry_id) {
    return NextResponse.json(
      { error: 'Cannot delete a booked transaction. Use reversal (storno) instead.' },
      { status: 409 }
    )
  }

  const { error: deleteError } = await supabase
    .from('transactions')
    .delete()
    .eq('id', id)
    .eq('company_id', companyId)

  if (deleteError) {
    return NextResponse.json({ error: 'Failed to delete transaction' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

/**
 * Edit a bank transaction's title (description).
 *
 * Legal under BFL only while the row is a mutable staging label — i.e. NOT yet
 * booked into a verifikat and NOT confirmed-matched to an invoice. Once booked
 * the description is räkenskapsinformation and corrections go through storno
 * (reverseEntry/correctEntry), so this route hard-blocks those rows. The bank's
 * original title is preserved immutably in original_description (set at ingest)
 * and is never written here; passing it back restores the "not edited" tag.
 */
export const PATCH = withRouteContext(
  'transaction.updateTitle',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId, user } = ctx

    const blocked = await guardSandbox(supabase, companyId)
    if (blocked) return blocked

    const validation = await validateBody(request, UpdateTransactionTitleSchema, {
      log,
      operation: 'transaction.updateTitle',
    })
    if (!validation.success) return validation.response
    const { description } = validation.data

    const { data: transaction, error: fetchError } = await supabase
      .from('transactions')
      .select('id, description, original_description, journal_entry_id, invoice_id, supplier_invoice_id')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !transaction) {
      return errorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', log, { requestId })
    }

    // Gate: editable only when neither booked nor confirmed-matched. (A
    // confirmed invoice/supplier-invoice match also sets journal_entry_id, but
    // we check all three for defense-in-depth.) An unbooked row has no fiscal
    // period, so the period-lock requirement is satisfied implicitly.
    if (transaction.journal_entry_id || transaction.invoice_id || transaction.supplier_invoice_id) {
      return errorResponseFromCode('TRANSACTION_TITLE_LOCKED', log, { requestId })
    }

    // Restoring to the bank original clears the "edited" tag; any other value
    // marks the title as user-edited. Compare against the TRIMMED original (the
    // incoming description is already trimmed by the schema) so a legacy
    // original carrying surrounding whitespace still restores cleanly.
    const isRestore =
      transaction.original_description != null &&
      description === transaction.original_description.trim()
    const titleEditedAt = isRestore ? null : new Date().toISOString()

    const { data: updated, error: updateError } = await supabase
      .from('transactions')
      .update({ description, title_edited_at: titleEditedAt })
      .eq('id', id)
      .eq('company_id', companyId)
      // Re-assert the FULL editable gate atomically against a concurrent book
      // or auto-match. Ingest's supplier auto-match can set supplier_invoice_id
      // WITHOUT journal_entry_id, so guarding journal_entry_id alone leaves a
      // narrow TOCTOU window — mirror the read-time gate here.
      .is('journal_entry_id', null)
      .is('invoice_id', null)
      .is('supplier_invoice_id', null)
      // Return only what the client renders (data minimisation — the row also
      // carries company_id and other internal fields the caller doesn't need).
      .select('id, description, title_edited_at')
      .maybeSingle<Pick<Transaction, 'id' | 'description' | 'title_edited_at'>>()

    if (updateError) {
      return errorResponse(updateError, log, { requestId })
    }
    if (!updated) {
      // 0 rows updated → the row was booked/matched between read and write.
      return errorResponseFromCode('TRANSACTION_TITLE_LOCKED', log, { requestId })
    }

    // Behandlingshistorik (BFNAR 2013:2 kap 8) — light-touch for a pre-verifikat
    // working label; updated_at (trigger) captures "when". We deliberately do
    // NOT log the description text: a bank label can carry PII (payee names,
    // reference numbers). The before-value stays recoverable in
    // original_description and the after-value is the row's current
    // description, so the log only needs to record that/which way it changed.
    log.info('transaction title edited', {
      transactionId: id,
      actor: user.id,
      restored: isRestore,
      previousLength: transaction.description?.length ?? 0,
      newLength: description.length,
    })

    return NextResponse.json({ data: updated })
  },
  { requireWrite: true },
)
