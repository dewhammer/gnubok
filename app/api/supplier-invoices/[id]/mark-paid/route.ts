import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import {
  createSupplierInvoicePaymentEntry,
  createSupplierInvoiceCashEntry,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { validateBody } from '@/lib/api/validate'
import { MarkSupplierInvoicePaidSchema } from '@/lib/api/schemas'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import type { SupplierInvoice, SupplierInvoiceItem } from '@/types'

ensureInitialized()

export async function POST(
  request: Request,
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

  const validation = await validateBody(request, MarkSupplierInvoicePaidSchema)
  if (!validation.success) return validation.response
  const body = validation.data

  // Fetch invoice with supplier and items
  const { data: invoice, error: fetchError } = await supabase
    .from('supplier_invoices')
    .select('*, supplier:suppliers(*), items:supplier_invoice_items(*)')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !invoice) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (!['registered', 'approved', 'partially_paid', 'overdue'].includes(invoice.status)) {
    return NextResponse.json(
      { error: 'Fakturan kan inte markeras som betald i nuvarande status' },
      { status: 400 }
    )
  }

  const paymentDate = body.payment_date || new Date().toISOString().split('T')[0]
  const paymentAmount = body.amount || invoice.remaining_amount
  const now = new Date().toISOString()

  // Fetch accounting method
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
        paymentDate,
        invoice.supplier?.supplier_type || 'swedish_business',
        invoice.supplier?.name
      )
      if (journalEntry) journalEntryId = journalEntry.id
    } else {
      const journalEntry = await createSupplierInvoicePaymentEntry(
        supabase,
        companyId,
        user.id,
        invoice as SupplierInvoice,
        paymentAmount,
        paymentDate,
        body.exchange_rate_difference,
        invoice.supplier?.name
      )
      if (journalEntry) journalEntryId = journalEntry.id
    }
  } catch (err) {
    const typed = bookkeepingErrorResponse(err)
    if (typed) return typed
    console.error('Failed to create payment journal entry:', err)
    return NextResponse.json(
      { error: 'Kunde inte bokföra betalningen' },
      { status: 500 }
    )
  }

  // Calculate new remaining amount
  const newRemaining = Math.round((invoice.remaining_amount - paymentAmount) * 100) / 100
  const newPaidAmount = Math.round((invoice.paid_amount + paymentAmount) * 100) / 100
  const isFullyPaid = newRemaining <= 0
  const newStatus = isFullyPaid ? 'paid' : 'partially_paid'

  // Update invoice (CAS guard: only if status hasn't changed since we read it)
  const { data: updateResult, error: updateError } = await supabase
    .from('supplier_invoices')
    .update({
      status: newStatus,
      remaining_amount: Math.max(0, newRemaining),
      paid_amount: newPaidAmount,
      paid_at: isFullyPaid ? now : null,
      payment_journal_entry_id: journalEntryId,
    })
    .eq('id', id)
    .eq('company_id', companyId)
    .in('status', ['registered', 'approved', 'partially_paid', 'overdue'])
    .select('id')

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  // CAS guard: status changed between our read and write
  if (!updateResult || updateResult.length === 0) {
    if (journalEntryId) {
      const { data: orphan } = await supabase
        .from('journal_entries')
        .select('fiscal_period_id, voucher_series, voucher_number')
        .eq('id', journalEntryId)
        .single()

      await supabase
        .from('journal_entries')
        .update({ status: 'cancelled' })
        .eq('id', journalEntryId)

      if (orphan) {
        await supabase.from('voucher_gap_explanations').insert({
          company_id: companyId,
          fiscal_period_id: orphan.fiscal_period_id,
          voucher_series: orphan.voucher_series || 'A',
          gap_number: orphan.voucher_number,
          explanation: 'Automatiskt makulerad: dubblettbokning förhindrad av samtidighetsskydd',
          created_by: user.id,
        })
      }
    }
    return NextResponse.json(
      { error: 'Fakturan har redan betalats av en annan förfrågan' },
      { status: 409 }
    )
  }

  // Record payment
  const { error: paymentError } = await supabase
    .from('supplier_invoice_payments')
    .insert({
      user_id: user.id,
      company_id: companyId,
      supplier_invoice_id: id,
      payment_date: paymentDate,
      amount: paymentAmount,
      currency: invoice.currency,
      exchange_rate_difference: body.exchange_rate_difference || 0,
      journal_entry_id: journalEntryId,
      notes: body.notes || null,
    })

  if (paymentError) {
    console.error('Failed to record payment:', paymentError)
  }

  try {
    await eventBus.emit({
      type: 'supplier_invoice.paid',
      payload: { supplierInvoice: invoice as SupplierInvoice, paymentAmount, companyId, userId: user.id },
    })
  } catch {
    // Non-blocking
  }

  return NextResponse.json({
    success: true,
    status: newStatus,
    paid_amount: newPaidAmount,
    remaining_amount: Math.max(0, newRemaining),
    journal_entry_id: journalEntryId,
  })
}
