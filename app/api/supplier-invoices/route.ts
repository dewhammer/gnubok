import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { createSupplierInvoiceRegistrationEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { AccountsNotInChartError, accountsNotInChartResponse } from '@/lib/bookkeeping/errors'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import type { SupplierInvoice, SupplierInvoiceItem } from '@/types'

ensureInitialized()

export async function GET(request: Request) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

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
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}

export async function POST(request: Request) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const validation = await validateBody(request, CreateSupplierInvoiceSchema)
  if (!validation.success) return validation.response
  const body = validation.data

  // Validate supplier exists and belongs to user
  const { data: supplier, error: supplierError } = await supabase
    .from('suppliers')
    .select('*')
    .eq('id', body.supplier_id)
    .eq('company_id', companyId)
    .single()

  if (supplierError || !supplier) {
    return NextResponse.json({ error: 'Supplier not found' }, { status: 404 })
  }

  // Get next arrival number
  const { data: arrivalNum, error: arrivalError } = await supabase
    .rpc('get_next_arrival_number', { p_company_id: companyId })

  if (arrivalError) {
    return NextResponse.json({ error: 'Failed to get arrival number' }, { status: 500 })
  }

  // Calculate totals from items (supports both amount-based and legacy quantity*price)
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

  // Insert supplier invoice
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
    // Translate the unique-index violation on (company_id, supplier_id, supplier_invoice_number)
    // into a structured 409 so the UI can offer to undo the credit chain rather than
    // leaving the user stuck on a generic 500. Other DB errors keep the existing 500 path.
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

      if (!existing) {
        // Race: row vanished between the failing insert and our lookup. Stay defensive.
        return NextResponse.json(
          {
            error: 'duplicate_supplier_invoice_number',
            message: `Det finns redan en faktura med nummer ${body.supplier_invoice_number} från denna leverantör.`,
          },
          { status: 409 }
        )
      }

      let creditNoteId: string | null = null
      if (existing.status === 'credited') {
        const { data: creditNote } = await supabase
          .from('supplier_invoices')
          .select('id')
          .eq('company_id', companyId)
          .eq('credited_invoice_id', existing.id)
          .eq('is_credit_note', true)
          .maybeSingle()
        creditNoteId = creditNote?.id ?? null
      }

      const statusLabels: Record<string, string> = {
        registered: 'registrerad',
        approved: 'godkänd',
        paid: 'betald',
        partially_paid: 'delbetald',
        overdue: 'förfallen',
        disputed: 'tvist',
        credited: 'krediterad',
      }
      const statusLabel = statusLabels[existing.status] || existing.status
      const message =
        existing.status === 'credited'
          ? `Det finns redan en faktura med nummer ${existing.supplier_invoice_number} från denna leverantör (krediterad). Du kan ångra krediteringen för att frigöra numret, eller använda ett annat nummer.`
          : `Det finns redan en faktura med nummer ${existing.supplier_invoice_number} från denna leverantör (status: ${statusLabel}). Använd ett annat nummer.`

      return NextResponse.json(
        {
          error: 'duplicate_supplier_invoice_number',
          message,
          existing: {
            id: existing.id,
            supplier_invoice_number: existing.supplier_invoice_number,
            status: existing.status,
            credit_note_id: creditNoteId,
          },
        },
        { status: 409 }
      )
    }

    return NextResponse.json({ error: invoiceError?.message || 'Failed to create invoice' }, { status: 500 })
  }

  // Insert line items
  const itemInserts = items.map((item) => ({
    supplier_invoice_id: invoice.id,
    ...item,
  }))

  const { error: itemsError } = await supabase
    .from('supplier_invoice_items')
    .insert(itemInserts)

  if (itemsError) {
    // Clean up invoice on items failure
    await supabase.from('supplier_invoices').delete().eq('id', invoice.id)
    return NextResponse.json({ error: itemsError.message }, { status: 500 })
  }

  // Accrual method: create registration journal entry
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
        companyId,
        user.id,
        invoice as SupplierInvoice,
        items as SupplierInvoiceItem[],
        supplier.supplier_type,
        supplier.name
      )
      if (journalEntry) {
        registrationJournalEntryId = journalEntry.id
        await supabase
          .from('supplier_invoices')
          .update({ registration_journal_entry_id: journalEntry.id })
          .eq('id', invoice.id)
      }
    } catch (err) {
      // Roll back the just-inserted supplier invoice (+ items via ON DELETE
      // CASCADE) on any JE failure so we never leave a supplier_invoices row
      // that has no registration JE. Under accrual method an orphan row
      // means leverantörsskuld (2440) and ingående moms (2641) go unposted,
      // which silently understates the momsdeklaration for the period.
      await supabase.from('supplier_invoices').delete().eq('id', invoice.id).eq('company_id', companyId)

      if (err instanceof AccountsNotInChartError) {
        return accountsNotInChartResponse(err)
      }
      console.error('Failed to create registration journal entry:', err)
      return NextResponse.json(
        { error: 'Kunde inte bokföra leverantörsfakturan — försök igen eller ändra datum om perioden är låst.' },
        { status: 500 }
      )
    }
  }

  try {
    await eventBus.emit({
      type: 'supplier_invoice.registered',
      payload: { supplierInvoice: invoice as SupplierInvoice, companyId, userId: user.id },
    })
  } catch {
    // Non-blocking — event emission failure should not affect the response
  }

  return NextResponse.json({
    data: {
      ...invoice,
      items: itemInserts,
      registration_journal_entry_id: registrationJournalEntryId,
    },
  })
}
