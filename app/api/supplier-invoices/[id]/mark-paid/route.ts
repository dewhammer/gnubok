import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import {
  createSupplierInvoicePaymentEntry,
  createSupplierInvoiceCashEntry,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { validateBody } from '@/lib/api/validate'
import { MarkSupplierInvoicePaidSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { SupplierInvoice, SupplierInvoiceItem } from '@/types'

ensureInitialized()

export const POST = withRouteContext(
  'supplier_invoice.mark_paid',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ supplierInvoiceId: id })

    const validation = await validateBody(request, MarkSupplierInvoicePaidSchema, {
      log: opLog,
      operation: 'supplier_invoice.mark_paid',
    })
    if (!validation.success) return validation.response
    const body = validation.data

    const { data: invoice, error: fetchError } = await supabase
      .from('supplier_invoices')
      .select('*, supplier:suppliers(*), items:supplier_invoice_items(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !invoice) {
      return errorResponseFromCode('SI_NOT_FOUND', opLog, { requestId })
    }

    if (!['registered', 'approved', 'partially_paid', 'overdue'].includes(invoice.status)) {
      return errorResponseFromCode('SI_PAID_NOT_PAYABLE', opLog, {
        requestId,
        details: { currentStatus: invoice.status },
      })
    }

    const paymentDate = body.payment_date || new Date().toISOString().split('T')[0]
    const paymentAmount = body.amount || invoice.remaining_amount
    const now = new Date().toISOString()

    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', companyId)
      .single()

    const accountingMethod = settings?.accounting_method || 'accrual'

    let journalEntryId: string | null = null

    try {
      if (accountingMethod === 'cash') {
        const journalEntry = await createSupplierInvoiceCashEntry(
          supabase, companyId!, user.id,
          invoice as SupplierInvoice,
          (invoice.items || []) as SupplierInvoiceItem[],
          paymentDate,
          invoice.supplier?.supplier_type || 'swedish_business',
          invoice.supplier?.name,
        )
        if (journalEntry) journalEntryId = journalEntry.id
      } else {
        const journalEntry = await createSupplierInvoicePaymentEntry(
          supabase, companyId!, user.id,
          invoice as SupplierInvoice,
          paymentAmount, paymentDate,
          body.exchange_rate_difference,
          invoice.supplier?.name,
        )
        if (journalEntry) journalEntryId = journalEntry.id
      }
    } catch (err) {
      if (isBookkeepingError(err)) {
        return errorResponse(err, opLog, { requestId })
      }
      opLog.error('failed to create payment journal entry', err as Error)
      return errorResponseFromCode('SI_PAID_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }

    const newRemaining = Math.round((invoice.remaining_amount - paymentAmount) * 100) / 100
    const newPaidAmount = Math.round((invoice.paid_amount + paymentAmount) * 100) / 100
    const isFullyPaid = newRemaining <= 0
    const newStatus = isFullyPaid ? 'paid' : 'partially_paid'

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
      opLog.error('supplier invoice update failed', updateError)
      return errorResponse(updateError, opLog, { requestId })
    }

    if (!updateResult || updateResult.length === 0) {
      // CAS guard: another request paid the invoice between our read and write.
      // Cancel the orphaned JE and document the voucher gap.
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
      return errorResponseFromCode('SI_PAID_ALREADY', opLog, {
        requestId,
        details: { reason: 'race' },
      })
    }

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
      opLog.warn('failed to record supplier_invoice_payments row', paymentError)
    }

    try {
      await eventBus.emit({
        type: 'supplier_invoice.paid',
        payload: { supplierInvoice: invoice as SupplierInvoice, paymentAmount, companyId: companyId!, userId: user.id },
      })
    } catch (err) {
      opLog.warn('supplier_invoice.paid event emission failed', err as Error)
    }

    return NextResponse.json({
      success: true,
      status: newStatus,
      paid_amount: newPaidAmount,
      remaining_amount: Math.max(0, newRemaining),
      journal_entry_id: journalEntryId,
    })
  },
  { requireWrite: true },
)
