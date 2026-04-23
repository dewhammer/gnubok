import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { createSupplierCreditNoteEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import type { SupplierInvoice, SupplierInvoiceItem, AccountingMethod } from '@/types'

ensureInitialized()

export async function POST(
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

  // Fetch original invoice with supplier and items
  const { data: original, error: fetchError } = await supabase
    .from('supplier_invoices')
    .select('*, supplier:suppliers(*), items:supplier_invoice_items(*)')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !original) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (original.status === 'credited') {
    return NextResponse.json(
      { error: 'Fakturan har redan krediterats' },
      { status: 400 }
    )
  }

  // Get next arrival number
  const { data: arrivalNum } = await supabase
    .rpc('get_next_arrival_number', { p_company_id: companyId })

  // Create credit note invoice (negative amounts)
  const { data: creditNote, error: creditError } = await supabase
    .from('supplier_invoices')
    .insert({
      user_id: user.id,
      company_id: companyId,
      supplier_id: original.supplier_id,
      arrival_number: arrivalNum,
      supplier_invoice_number: `KREDIT-${original.supplier_invoice_number}`,
      invoice_date: new Date().toISOString().split('T')[0],
      due_date: new Date().toISOString().split('T')[0],
      status: 'registered',
      currency: original.currency,
      exchange_rate: original.exchange_rate,
      vat_treatment: original.vat_treatment,
      reverse_charge: original.reverse_charge,
      subtotal: original.subtotal,
      subtotal_sek: original.subtotal_sek,
      vat_amount: original.vat_amount,
      vat_amount_sek: original.vat_amount_sek,
      total: original.total,
      total_sek: original.total_sek,
      remaining_amount: 0,
      is_credit_note: true,
      credited_invoice_id: id,
    })
    .select()
    .single()

  if (creditError || !creditNote) {
    return NextResponse.json({ error: creditError?.message || 'Failed to create credit note' }, { status: 500 })
  }

  // Copy items to credit note
  const creditItems = (original.items || []).map((item: SupplierInvoiceItem) => ({
    supplier_invoice_id: creditNote.id,
    sort_order: item.sort_order,
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    unit_price: item.unit_price,
    line_total: item.line_total,
    account_number: item.account_number,
    vat_code: item.vat_code,
    vat_rate: item.vat_rate,
    vat_amount: item.vat_amount,
  }))

  await supabase.from('supplier_invoice_items').insert(creditItems)

  // Fetch accounting method
  const { data: settings } = await supabase
    .from('company_settings')
    .select('accounting_method')
    .eq('company_id', companyId)
    .single()

  const accountingMethod = (settings?.accounting_method as AccountingMethod) || 'accrual'

  // Create credit note journal entry (accrual only)
  // Cash method: skip — no original registration entry exists to reverse; deferred until refund
  let journalEntryId: string | null = null
  if (accountingMethod === 'accrual') {
    try {
      const journalEntry = await createSupplierCreditNoteEntry(
        supabase,
        companyId,
        user.id,
        creditNote as SupplierInvoice,
        creditItems as SupplierInvoiceItem[],
        original.supplier?.supplier_type || 'swedish_business',
        original.supplier?.name
      )
      if (journalEntry) {
        journalEntryId = journalEntry.id
        await supabase
          .from('supplier_invoices')
          .update({ registration_journal_entry_id: journalEntry.id })
          .eq('id', creditNote.id)
      }
    } catch (err) {
      // Roll back the just-inserted credit note (items cascade-delete) on
      // any JE failure. A creditfaktura row without a corresponding reversal
      // JE would leave ingående moms overstated for the period — same
      // momsdeklaration-integrity concern as the POST-route rollback.
      await supabase.from('supplier_invoices').delete().eq('id', creditNote.id).eq('company_id', companyId)

      const typed = bookkeepingErrorResponse(err)
      if (typed) return typed
      console.error('Failed to create credit note journal entry:', err)
      return NextResponse.json(
        { error: 'Kunde inte bokföra kreditfakturan — försök igen eller ändra datum om perioden är låst.' },
        { status: 500 }
      )
    }
  }

  // Update original invoice: reduce remaining_amount
  const newRemaining = Math.max(0, original.remaining_amount - original.total)
  const newStatus = newRemaining <= 0 ? 'credited' : original.status

  await supabase
    .from('supplier_invoices')
    .update({
      status: newStatus,
      remaining_amount: newRemaining,
    })
    .eq('id', id)

  try {
    await eventBus.emit({
      type: 'supplier_invoice.credited',
      payload: {
        supplierInvoice: original as SupplierInvoice,
        creditNote: creditNote as SupplierInvoice,
        companyId,
        userId: user.id,
      },
    })
  } catch {
    // Non-blocking
  }

  return NextResponse.json({
    data: creditNote,
    journal_entry_id: journalEntryId,
  })
}
