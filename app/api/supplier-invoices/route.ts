import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { createSupplierInvoiceRegistrationEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { SupplierInvoice, SupplierInvoiceItem } from '@/types'

ensureInitialized()

export const GET = withRouteContext(
  'supplier_invoice.list',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')

    let query = supabase
      .from('supplier_invoices')
      .select('*, supplier:suppliers(id, name)')
      .eq('company_id', companyId)

    if (status && status !== 'all') {
      if (status === 'to_pay') {
        query = query.in('status', ['approved', 'overdue'])
      } else {
        query = query.eq('status', status)
      }
    }

    const { data, error } = await query.order('due_date', { ascending: true })

    if (error) {
      log.error('supplier_invoice list failed', error)
      return errorResponse(error, log, { requestId })
    }

    return NextResponse.json({ data })
  },
)

export const POST = withRouteContext(
  'supplier_invoice.create',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, CreateSupplierInvoiceSchema, {
      log,
      operation: 'supplier_invoice.create',
    })
    if (!validation.success) return validation.response
    const body = validation.data

    const { data: supplier, error: supplierError } = await supabase
      .from('suppliers')
      .select('*')
      .eq('id', body.supplier_id)
      .eq('company_id', companyId)
      .single()

    if (supplierError || !supplier) {
      return errorResponseFromCode('SUPPLIER_NOT_FOUND', log, { requestId })
    }

    const { data: arrivalNum, error: arrivalError } = await supabase
      .rpc('get_next_arrival_number', { p_company_id: companyId })

    if (arrivalError) {
      log.error('arrival number generation failed', arrivalError)
      return errorResponseFromCode('SI_CREATE_FAILED', log, {
        requestId,
        details: { reason: arrivalError.message, step: 'arrival_number' },
      })
    }

    const items = body.items.map((item, index) => {
      const vatRate = item.vat_rate ?? 0.25
      const lineTotal = item.amount != null
        ? Math.round(item.amount * 100) / 100
        : Math.round((item.quantity ?? 1) * (item.unit_price ?? 0) * 100) / 100
      const vatAmount = Math.round(lineTotal * vatRate * 100) / 100
      return {
        sort_order: index,
        description: item.description,
        quantity: item.amount != null ? 1 : (item.quantity ?? 1),
        unit: item.amount != null ? 'st' : (item.unit || 'st'),
        unit_price: item.amount != null ? lineTotal : (item.unit_price ?? 0),
        line_total: lineTotal,
        account_number: item.account_number,
        vat_code: item.vat_code || null,
        vat_rate: vatRate,
        vat_amount: vatAmount,
      }
    })

    const subtotal = items.reduce((sum, i) => sum + i.line_total, 0)
    const vatAmount = items.reduce((sum, i) => sum + i.vat_amount, 0)
    const total = Math.round((subtotal + vatAmount) * 100) / 100

    const exchangeRate = body.exchange_rate || null
    const subtotalSek = exchangeRate ? Math.round(subtotal * exchangeRate * 100) / 100 : null
    const vatAmountSek = exchangeRate ? Math.round(vatAmount * exchangeRate * 100) / 100 : null
    const totalSek = exchangeRate ? Math.round(total * exchangeRate * 100) / 100 : null

    const { data: invoice, error: invoiceError } = await supabase
      .from('supplier_invoices')
      .insert({
        user_id: user.id,
        company_id: companyId,
        supplier_id: body.supplier_id,
        arrival_number: arrivalNum,
        supplier_invoice_number: body.supplier_invoice_number,
        invoice_date: body.invoice_date,
        due_date: body.due_date,
        delivery_date: body.delivery_date || null,
        status: 'registered',
        currency: body.currency || 'SEK',
        exchange_rate: exchangeRate,
        vat_treatment: body.vat_treatment || 'standard_25',
        reverse_charge: body.reverse_charge || false,
        payment_reference: body.payment_reference || null,
        subtotal: Math.round(subtotal * 100) / 100,
        subtotal_sek: subtotalSek,
        vat_amount: Math.round(vatAmount * 100) / 100,
        vat_amount_sek: vatAmountSek,
        total: Math.round(total * 100) / 100,
        total_sek: totalSek,
        remaining_amount: Math.round(total * 100) / 100,
        notes: body.notes || null,
      })
      .select()
      .single()

    if (invoiceError || !invoice) {
      // Special-case the unique-index violation on (company_id, supplier_id,
      // supplier_invoice_number). The UI uses the embedded `existing` object
      // to offer "undo crediting" — preserve that shape inside `details`.
      const pgErr = invoiceError as { code?: string; message?: string } | null
      const isDuplicateNumber =
        pgErr?.code === '23505' &&
        (pgErr.message || '').includes('idx_supplier_invoices_company_supplier_number')

      if (isDuplicateNumber) {
        const { data: existing } = await supabase
          .from('supplier_invoices')
          .select('id, supplier_invoice_number, status')
          .eq('company_id', companyId)
          .eq('supplier_id', body.supplier_id)
          .eq('supplier_invoice_number', body.supplier_invoice_number)
          .maybeSingle()

        let creditNoteId: string | null = null
        if (existing?.status === 'credited') {
          const { data: creditNote } = await supabase
            .from('supplier_invoices')
            .select('id')
            .eq('company_id', companyId)
            .eq('credited_invoice_id', existing.id)
            .eq('is_credit_note', true)
            .maybeSingle()
          creditNoteId = creditNote?.id ?? null
        }

        return errorResponseFromCode('SI_CREATE_DUPLICATE_INVOICE_NUMBER', log, {
          requestId,
          details: {
            supplierId: body.supplier_id,
            supplierInvoiceNumber: body.supplier_invoice_number,
            existing: existing
              ? {
                  id: existing.id,
                  supplier_invoice_number: existing.supplier_invoice_number,
                  status: existing.status,
                  credit_note_id: creditNoteId,
                }
              : null,
          },
        })
      }

      log.error('supplier invoice insert failed', invoiceError)
      return errorResponseFromCode('SI_CREATE_FAILED', log, {
        requestId,
        details: { reason: invoiceError?.message || 'unknown' },
      })
    }

    const itemInserts = items.map((item) => ({
      supplier_invoice_id: invoice.id,
      ...item,
    }))

    const { error: itemsError } = await supabase
      .from('supplier_invoice_items')
      .insert(itemInserts)

    if (itemsError) {
      // Roll back the parent on items failure to avoid orphan rows.
      await supabase.from('supplier_invoices').delete().eq('id', invoice.id)
      log.error('supplier invoice items insert failed; rolled back', itemsError, {
        invoiceId: invoice.id,
      })
      return errorResponseFromCode('SI_CREATE_FAILED', log, {
        requestId,
        details: { reason: itemsError.message, step: 'items_insert' },
      })
    }

    // Accrual method: create the registration journal entry. JE failure here
    // is fatal — an orphan supplier_invoices row without a registration JE
    // silently understates leverantörsskuld (2440) and ingående moms (2641)
    // for the momsdeklaration. Roll back instead.
    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', companyId)
      .single()

    const accountingMethod = settings?.accounting_method || 'accrual'
    let registrationJournalEntryId: string | null = null

    if (accountingMethod === 'accrual') {
      try {
        const journalEntry = await createSupplierInvoiceRegistrationEntry(
          supabase,
          companyId!,
          user.id,
          invoice as SupplierInvoice,
          items as SupplierInvoiceItem[],
          supplier.supplier_type,
          supplier.name,
        )
        if (journalEntry) {
          registrationJournalEntryId = journalEntry.id
          await supabase
            .from('supplier_invoices')
            .update({ registration_journal_entry_id: journalEntry.id })
            .eq('id', invoice.id)
        }
      } catch (err) {
        await supabase.from('supplier_invoices').delete().eq('id', invoice.id).eq('company_id', companyId)
        if (isBookkeepingError(err)) {
          return errorResponse(err, log, { requestId })
        }
        log.error('failed to create registration journal entry', err as Error, {
          invoiceId: invoice.id,
        })
        return errorResponseFromCode('SI_CREATE_FAILED', log, {
          requestId,
          details: {
            reason: err instanceof Error ? err.message : 'unknown',
            step: 'registration_journal_entry',
          },
        })
      }
    }

    try {
      await eventBus.emit({
        type: 'supplier_invoice.registered',
        payload: { supplierInvoice: invoice as SupplierInvoice, companyId: companyId!, userId: user.id },
      })
    } catch (err) {
      log.warn('supplier_invoice.registered event emission failed', err as Error)
    }

    return NextResponse.json({
      data: {
        ...invoice,
        items: itemInserts,
        registration_journal_entry_id: registrationJournalEntryId,
      },
    })
  },
  { requireWrite: true },
)
