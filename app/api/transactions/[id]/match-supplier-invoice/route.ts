import { NextResponse } from 'next/server'
import {
  createSupplierInvoicePaymentEntry,
  createSupplierInvoiceCashEntry,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { MatchSupplierInvoiceSchema } from '@/lib/api/schemas'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { eventBus } from '@/lib/events/bus'
import { ensureInitialized } from '@/lib/init'
import type { SupplierInvoice, SupplierInvoiceItem, Transaction } from '@/types'

ensureInitialized()

/**
 * POST /api/transactions/[id]/match-supplier-invoice
 *
 * Match a negative transaction (expense) to a supplier invoice.
 */
export const POST = withRouteContext(
  'transaction.match_supplier_invoice',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id: transactionId } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, MatchSupplierInvoiceSchema, {
      log,
      operation: 'transaction.match_supplier_invoice',
    })
    if (!validation.success) return validation.response
    const { supplier_invoice_id } = validation.data

    const txLog = log.child({ transactionId, supplierInvoiceId: supplier_invoice_id })

    const { data: transaction, error: fetchTxError } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .single()

    if (fetchTxError || !transaction) {
      return errorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', txLog, { requestId })
    }

    if (transaction.amount >= 0) {
      return errorResponseFromCode('MATCH_SI_NOT_EXPENSE', txLog, {
        requestId,
        details: { amount: transaction.amount },
      })
    }

    if (transaction.supplier_invoice_id) {
      return errorResponseFromCode('MATCH_SI_TX_ALREADY_LINKED', txLog, {
        requestId,
        details: { existingSupplierInvoiceId: transaction.supplier_invoice_id },
      })
    }

    const { data: invoice, error: fetchInvError } = await supabase
      .from('supplier_invoices')
      .select('*, supplier:suppliers(*), items:supplier_invoice_items(*)')
      .eq('id', supplier_invoice_id)
      .eq('company_id', companyId)
      .single()

    if (fetchInvError || !invoice) {
      return errorResponseFromCode('MATCH_SI_NOT_FOUND', txLog, { requestId })
    }

    if (invoice.status === 'paid' || invoice.status === 'credited') {
      return errorResponseFromCode('MATCH_SI_ALREADY_PAID', txLog, {
        requestId,
        details: { currentStatus: invoice.status },
      })
    }

    const paymentAmount = Math.abs(transaction.amount)
    const now = new Date().toISOString()

    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', companyId)
      .single()

    const accountingMethod = settings?.accounting_method || 'accrual'

    let journalEntryId: string | null = null
    let journalEntryError: string | null = null

    try {
      if (accountingMethod === 'cash') {
        const journalEntry = await createSupplierInvoiceCashEntry(
          supabase, companyId, user.id, invoice as SupplierInvoice,
          (invoice.items || []) as SupplierInvoiceItem[],
          transaction.date,
          invoice.supplier?.supplier_type || 'swedish_business',
        )
        if (journalEntry) journalEntryId = journalEntry.id
      } else {
        const journalEntry = await createSupplierInvoicePaymentEntry(
          supabase, companyId, user.id, invoice as SupplierInvoice,
          paymentAmount, transaction.date,
        )
        if (journalEntry) journalEntryId = journalEntry.id
      }
    } catch (err) {
      txLog.error('failed to create supplier invoice payment journal entry', err as Error)
      // Bookkeeping errors with structured codes get a Swedish translation;
      // otherwise pass-through. Match still proceeds — the user can re-book.
      if (isBookkeepingError(err)) {
        journalEntryError = getErrorMessage(err, { context: 'supplier_invoice' })
      } else {
        journalEntryError = err instanceof Error ? err.message : 'Unknown error'
      }
    }

    const newRemaining = Math.max(0, Math.round((invoice.remaining_amount - paymentAmount) * 100) / 100)
    const newPaidAmount = Math.round((invoice.paid_amount + paymentAmount) * 100) / 100
    const isFullyPaid = newRemaining <= 0
    const newStatus = isFullyPaid ? 'paid' : 'partially_paid'

    const { data: updatedRows, error: updateInvError } = await supabase
      .from('supplier_invoices')
      .update({
        status: newStatus,
        remaining_amount: newRemaining,
        paid_amount: newPaidAmount,
        paid_at: isFullyPaid ? now : null,
        payment_journal_entry_id: journalEntryId,
        transaction_id: transactionId,
      })
      .eq('id', supplier_invoice_id)
      .in('status', ['registered', 'approved', 'partially_paid'])
      .select('id')

    if (updateInvError) {
      txLog.error('failed to update supplier invoice', updateInvError)
      return errorResponse(updateInvError, txLog, { requestId })
    }

    if (!updatedRows || updatedRows.length === 0) {
      return errorResponseFromCode('MATCH_SI_NOT_OPEN', txLog, { requestId })
    }

    const { error: paymentInsertError } = await supabase
      .from('supplier_invoice_payments')
      .insert({
        user_id: user.id,
        company_id: companyId,
        supplier_invoice_id,
        payment_date: transaction.date,
        amount: paymentAmount,
        currency: invoice.currency,
        journal_entry_id: journalEntryId,
        transaction_id: transactionId,
      })

    if (paymentInsertError) {
      if (paymentInsertError.code === '23505') {
        return errorResponseFromCode('MATCH_SI_DUPLICATE_PAYMENT', txLog, { requestId })
      }
      txLog.error('failed to record supplier invoice payment', paymentInsertError)
      return errorResponseFromCode('MATCH_SI_RECORD_PAYMENT_FAILED', txLog, { requestId })
    }

    const { error: updateTxError } = await supabase
      .from('transactions')
      .update({
        supplier_invoice_id,
        journal_entry_id: journalEntryId,
        is_business: true,
      })
      .eq('id', transactionId)

    if (updateTxError) {
      txLog.error('failed to link transaction to supplier invoice', updateTxError)
      return errorResponseFromCode('MATCH_SI_LINK_TX_FAILED', txLog, { requestId })
    }

    logMatchEvent(supabase, user.id, transactionId, 'matched', {
      supplierInvoiceId: supplier_invoice_id,
      matchConfidence: 1.0,
      matchMethod: 'manual_confirm',
      newState: { status: newStatus, paid_amount: newPaidAmount, remaining_amount: newRemaining },
    })

    try {
      eventBus.emit({
        type: 'supplier_invoice.match_confirmed',
        payload: {
          supplierInvoice: invoice as SupplierInvoice,
          transaction: transaction as Transaction,
          userId: user.id,
          companyId,
        },
      })
    } catch (err) {
      txLog.warn('supplier_invoice.match_confirmed event emission failed', err as Error)
    }

    if (journalEntryError) {
      txLog.warn('supplier invoice match recorded but payment JE failed', {
        message: journalEntryError,
      })
    }

    return NextResponse.json({
      success: true,
      invoice_status: newStatus,
      paid_amount: newPaidAmount,
      remaining_amount: newRemaining,
      journal_entry_id: journalEntryId,
      ...(journalEntryError ? { journal_entry_error: journalEntryError } : {}),
    })
  },
  { requireWrite: true },
)
