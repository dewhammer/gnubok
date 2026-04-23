import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import {
  createInvoicePaymentJournalEntry,
  createInvoiceCashEntry,
} from '@/lib/bookkeeping/invoice-entries'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import {
  AccountsNotInChartError,
  accountsNotInChartResponse,
  bookkeepingErrorResponse,
} from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { validateBody } from '@/lib/api/validate'
import { MatchInvoiceSchema } from '@/lib/api/schemas'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { eventBus } from '@/lib/events/bus'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import type { EntityType, Invoice, Transaction } from '@/types'

ensureInitialized()

/**
 * POST /api/transactions/[id]/match-invoice
 *
 * Confirms an invoice match for a transaction. Supports partial payments:
 * 1. If transaction has an auto-categorization journal entry, storno it first
 * 2. Links transaction to invoice (sets invoice_id)
 * 3. Updates invoice status to 'paid' or 'partially_paid'
 * 4. Records payment in invoice_payments table
 * 5. Creates journal entry for payment receipt
 *    - Debit 1930 Företagskonto (Bank)
 *    - Credit 1510 Kundfordringar (Accounts Receivable)
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { id: transactionId } = await params

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  // Parse and validate request body
  const validation = await validateBody(request, MatchInvoiceSchema)
  if (!validation.success) return validation.response
  const { invoice_id } = validation.data

  // Fetch the transaction (validates ownership)
  const { data: transaction, error: fetchTxError } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .single()

  if (fetchTxError || !transaction) {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  }

  // Verify transaction is income (amount > 0)
  if (transaction.amount <= 0) {
    return NextResponse.json(
      { error: 'Only income transactions can be matched to invoices' },
      { status: 400 }
    )
  }

  // Check if transaction is already linked to an invoice
  if (transaction.invoice_id) {
    return NextResponse.json(
      { error: 'Transaction is already linked to an invoice' },
      { status: 400 }
    )
  }

  // Fetch the invoice with items (validates ownership, items needed for per-line VAT)
  const { data: invoice, error: fetchInvError } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoice_id)
    .eq('company_id', companyId)
    .single()

  if (fetchInvError || !invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  // Verify invoice is in a matchable state (sent, overdue, or partially_paid)
  if (invoice.status !== 'sent' && invoice.status !== 'overdue' && invoice.status !== 'partially_paid') {
    return NextResponse.json(
      { error: 'Invoice is not in an unpaid state' },
      { status: 400 }
    )
  }

  // --- Commit 1: Storno conflicting auto-categorization journal entry ---
  // Order: storno MUST complete before any other state changes.
  // If storno fails, return 500 immediately — nothing else has been modified.
  if (transaction.journal_entry_id) {
    try {
      await reverseEntry(supabase, companyId, user.id, transaction.journal_entry_id)

      // Clear the journal_entry_id on the transaction
      const { error: clearJeError } = await supabase
        .from('transactions')
        .update({ journal_entry_id: null })
        .eq('id', transactionId)
      if (clearJeError) {
        console.error('Failed to clear journal_entry_id after storno:', clearJeError)
      }

      logMatchEvent(supabase, user.id, transactionId, 'storno_conflict_resolved', {
        invoiceId: invoice_id,
        previousState: { journal_entry_id: transaction.journal_entry_id },
        newState: { journal_entry_id: null },
      })
    } catch (err) {
      const typed = bookkeepingErrorResponse(err)
      if (typed) return typed
      console.error('Failed to storno conflicting journal entry:', err)
      return NextResponse.json(
        { error: 'Failed to reverse conflicting journal entry' },
        { status: 500 }
      )
    }
  }

  const now = new Date().toISOString()
  const paidAmount = transaction.amount

  // Calculate partial payment amounts
  const newPaidAmount = Math.round(((invoice.paid_amount || 0) + paidAmount) * 100) / 100
  const currentRemaining = invoice.remaining_amount ?? (invoice.total - (invoice.paid_amount || 0))
  const newRemaining = Math.max(0, Math.round((currentRemaining - paidAmount) * 100) / 100)
  const isFullyPaid = newRemaining <= 0
  const newStatus = isFullyPaid ? 'paid' : 'partially_paid'

  // Fetch accounting method
  const { data: settings } = await supabase
    .from('company_settings')
    .select('accounting_method, entity_type')
    .eq('company_id', companyId)
    .single()

  const accountingMethod = settings?.accounting_method || 'accrual'
  const entityType = (settings?.entity_type as EntityType) || 'enskild_firma'

  // Create journal entry for payment receipt (method-aware)
  let journalEntryId: string | null = null
  let journalEntryError: string | null = null

  try {
    if (accountingMethod === 'cash' && isFullyPaid) {
      // Kontantmetoden, full payment: combined revenue entry with per-line VAT rates
      const journalEntry = await createInvoiceCashEntry(
        supabase,
        companyId,
        user.id,
        invoice as Invoice,
        transaction.date,
        entityType,
        invoice.customer?.name
      )
      journalEntryId = journalEntry?.id ?? null
    } else if (accountingMethod === 'cash' && !isFullyPaid) {
      // Kontantmetoden, partial payment: use accrual-style clearing entry.
      // Under kontantmetoden, invoice creation produces no journal entry,
      // so 1510 has no prior balance. The debit 1930 / credit 1510 creates
      // a credit on 1510 with no offsetting debit — this is intentional.
      // 1510 is used as a temporary clearing account under cash method.
      // The full revenue + VAT recognition (with 1510 reversal) happens at
      // final payment when createInvoiceCashEntry is called.
      const journalEntry = await createInvoicePaymentJournalEntry(
        supabase,
        companyId,
        user.id,
        invoice as Invoice,
        transaction.date,
        undefined,
        invoice.customer?.name,
        paidAmount
      )
      journalEntryId = journalEntry?.id ?? null
    } else {
      // Faktureringsmetoden: clear receivable (Debit 1930, Credit 1510)
      const journalEntry = await createInvoicePaymentJournalEntry(
        supabase,
        companyId,
        user.id,
        invoice as Invoice,
        transaction.date,
        undefined,
        invoice.customer?.name,
        paidAmount
      )
      journalEntryId = journalEntry?.id ?? null
    }
  } catch (err) {
    // AccountsNotInChart returns the structured 400 so the UI can open the
    // account-activation dialog. Other errors are logged and attached to
    // `journal_entry_error` — the match itself is a valuable business event,
    // and the user can re-book the payment verifikation separately.
    if (err instanceof AccountsNotInChartError) {
      return accountsNotInChartResponse(err)
    }
    console.error('Failed to create payment journal entry:', err)
    const typedResp = bookkeepingErrorResponse(err)
    if (typedResp) {
      const body = (await typedResp.json()) as unknown
      journalEntryError = getErrorMessage(body, { context: 'invoice' })
    } else {
      journalEntryError = err instanceof Error ? err.message : 'Unknown error'
    }
    // Continue - we still want to update the invoice and transaction
  }

  // --- Commit 4: Optimistic lock on invoice status ---
  // Only update if invoice is still in a matchable state.
  // Prevents TOCTOU race where another request fully pays the invoice
  // between our fetch and this update.
  const { data: updatedRows, error: updateInvError } = await supabase
    .from('invoices')
    .update({
      status: newStatus,
      paid_at: isFullyPaid ? now : null,
      paid_amount: newPaidAmount,
      remaining_amount: newRemaining,
    })
    .eq('id', invoice_id)
    .in('status', ['sent', 'overdue', 'partially_paid'])
    .select('id')

  if (updateInvError) {
    console.error('Failed to update invoice:', updateInvError)
    return NextResponse.json(
      { error: 'Failed to update invoice status' },
      { status: 500 }
    )
  }

  if (!updatedRows || updatedRows.length === 0) {
    return NextResponse.json(
      { error: 'Invoice has already been fully paid or is no longer matchable' },
      { status: 409 }
    )
  }

  // Record payment in invoice_payments table
  const paymentNotes = (accountingMethod === 'cash' && !isFullyPaid)
    ? 'Kontantmetoden: intäkt bokförs vid slutbetalning'
    : null

  const { error: paymentInsertError } = await supabase
    .from('invoice_payments')
    .insert({
      user_id: user.id,
      company_id: companyId,
      invoice_id,
      payment_date: transaction.date,
      amount: paidAmount,
      currency: invoice.currency,
      exchange_rate: invoice.exchange_rate,
      journal_entry_id: journalEntryId,
      transaction_id: transactionId,
      notes: paymentNotes,
    })

  if (paymentInsertError) {
    // Catch unique constraint violation (same transaction matched to same invoice twice)
    if (paymentInsertError.code === '23505') {
      return NextResponse.json(
        { error: 'This transaction is already matched to this invoice' },
        { status: 409 }
      )
    }
    console.error('Failed to record invoice payment:', paymentInsertError)
    return NextResponse.json({ error: 'Failed to record invoice payment' }, { status: 500 })
  }

  // Update transaction to link to invoice and clear potential match
  const { error: updateTxError } = await supabase
    .from('transactions')
    .update({
      invoice_id: invoice_id,
      potential_invoice_id: null,
      journal_entry_id: journalEntryId,
      is_business: true,
      category: 'income_services',
    })
    .eq('id', transactionId)

  if (updateTxError) {
    console.error('Failed to update transaction:', updateTxError)
    return NextResponse.json(
      { error: 'Failed to link transaction to invoice' },
      { status: 500 }
    )
  }

  // Log the match event and emit event
  logMatchEvent(supabase, user.id, transactionId, 'matched', {
    invoiceId: invoice_id,
    matchConfidence: 1.0,
    matchMethod: 'manual_confirm',
    newState: { status: newStatus, paid_amount: newPaidAmount, remaining_amount: newRemaining },
  })

  try {
    eventBus.emit({
      type: 'invoice.match_confirmed',
      payload: {
        invoice: invoice as Invoice,
        transaction: transaction as Transaction,
        userId: user.id,
        companyId,
      },
    })
  } catch {
    // Event emission is non-critical
  }

  return NextResponse.json({
    success: true,
    invoice_status: newStatus,
    paid_at: isFullyPaid ? now : null,
    paid_amount: newPaidAmount,
    remaining_amount: newRemaining,
    journal_entry_id: journalEntryId,
    journal_entry_error: journalEntryError,
  })
}
