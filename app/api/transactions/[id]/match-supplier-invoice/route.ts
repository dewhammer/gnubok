import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import {
  createSupplierInvoicePaymentEntry,
  createSupplierInvoiceCashEntry,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { validateBody } from '@/lib/api/validate'
import { MatchSupplierInvoiceSchema } from '@/lib/api/schemas'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { eventBus } from '@/lib/events/bus'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import type { SupplierInvoice, SupplierInvoiceItem, Transaction } from '@/types'

ensureInitialized()

/**
 * POST /api/transactions/[id]/match-supplier-invoice
 *
 * Match a negative transaction (expense) to a supplier invoice.
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

  const validation = await validateBody(request, MatchSupplierInvoiceSchema)
  if (!validation.success) return validation.response
  const { supplier_invoice_id } = validation.data

  // Fetch the transaction
  const { data: transaction, error: fetchTxError } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .single()

  if (fetchTxError || !transaction) {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  }

  // Verify transaction is an expense (amount < 0)
  if (transaction.amount >= 0) {
    return NextResponse.json(
      { error: 'Bara utgiftstransaktioner kan matchas mot leverantörsfakturor' },
      { status: 400 }
    )
  }

  if (transaction.supplier_invoice_id) {
    return NextResponse.json(
      { error: 'Transaktionen är redan kopplad till en leverantörsfaktura' },
      { status: 400 }
    )
  }

  // Fetch the invoice with supplier and items
  const { data: invoice, error: fetchInvError } = await supabase
    .from('supplier_invoices')
    .select('*, supplier:suppliers(*), items:supplier_invoice_items(*)')
    .eq('id', supplier_invoice_id)
    .eq('company_id', companyId)
    .single()

  if (fetchInvError || !invoice) {
    return NextResponse.json({ error: 'Supplier invoice not found' }, { status: 404 })
  }

  if (invoice.status === 'paid' || invoice.status === 'credited') {
    return NextResponse.json(
      { error: 'Leverantörsfakturan är redan betald' },
      { status: 400 }
    )
  }

  const paymentAmount = Math.abs(transaction.amount)
  const now = new Date().toISOString()

  // Get accounting method
  const { data: settings } = await supabase
    .from('company_settings')
    .select('accounting_method')
    .eq('company_id', companyId)
    .single()

  const accountingMethod = settings?.accounting_method || 'accrual'

  // Create journal entry
  let journalEntryId: string | null = null

  try {
    if (accountingMethod === 'cash') {
      const journalEntry = await createSupplierInvoiceCashEntry(
        supabase,
        companyId,
        user.id,
        invoice as SupplierInvoice,
        (invoice.items || []) as SupplierInvoiceItem[],
        transaction.date,
        invoice.supplier?.supplier_type || 'swedish_business'
      )
      if (journalEntry) journalEntryId = journalEntry.id
    } else {
      const journalEntry = await createSupplierInvoicePaymentEntry(
        supabase,
        companyId,
        user.id,
        invoice as SupplierInvoice,
        paymentAmount,
        transaction.date
      )
      if (journalEntry) journalEntryId = journalEntry.id
    }
  } catch (err) {
    const typed = bookkeepingErrorResponse(err)
    if (typed) return typed
    console.error('Failed to create payment journal entry:', err)
  }

  // Optimistic lock: only update if invoice is still in a matchable state
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
    return NextResponse.json({ error: 'Failed to update supplier invoice' }, { status: 500 })
  }

  if (!updatedRows || updatedRows.length === 0) {
    return NextResponse.json(
      { error: 'Supplier invoice has already been fully paid or is no longer matchable' },
      { status: 409 }
    )
  }

  // Record payment — catch unique constraint violation
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
      return NextResponse.json(
        { error: 'This transaction is already matched to this supplier invoice' },
        { status: 409 }
      )
    }
    console.error('Failed to record supplier invoice payment:', paymentInsertError)
    return NextResponse.json({ error: 'Failed to record invoice payment' }, { status: 500 })
  }

  // Update transaction
  const { error: updateTxError } = await supabase
    .from('transactions')
    .update({
      supplier_invoice_id,
      journal_entry_id: journalEntryId,
      is_business: true,
    })
    .eq('id', transactionId)

  if (updateTxError) {
    return NextResponse.json({ error: 'Failed to link transaction' }, { status: 500 })
  }

  // Log the match event and emit event
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
  } catch {
    // Event emission is non-critical
  }

  return NextResponse.json({
    success: true,
    invoice_status: newStatus,
    paid_amount: newPaidAmount,
    remaining_amount: newRemaining,
    journal_entry_id: journalEntryId,
  })
}
