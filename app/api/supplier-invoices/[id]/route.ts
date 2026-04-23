import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { validateBody } from '@/lib/api/validate'
import { UpdateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { id } = await params

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const { data: invoice, error } = await supabase
    .from('supplier_invoices')
    .select(
      '*, supplier:suppliers(*), items:supplier_invoice_items(*), payments:supplier_invoice_payments(*), credited_original:supplier_invoices!credited_invoice_id(id, supplier_invoice_number, arrival_number)'
    )
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (error || !invoice) {
    return NextResponse.json({ error: 'Supplier invoice not found' }, { status: 404 })
  }

  return NextResponse.json({ data: invoice })
}

export async function PUT(
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

  // Only allow editing registered invoices
  const { data: existing } = await supabase
    .from('supplier_invoices')
    .select('status')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (existing.status !== 'registered') {
    return NextResponse.json(
      { error: 'Kan bara redigera registrerade fakturor' },
      { status: 400 }
    )
  }

  const validation = await validateBody(request, UpdateSupplierInvoiceSchema)
  if (!validation.success) return validation.response
  const body = validation.data

  const { data, error } = await supabase
    .from('supplier_invoices')
    .update(body)
    .eq('id', id)
    .eq('company_id', companyId)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}

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

  // Only allow deleting registered invoices without journal entries
  const { data: existing } = await supabase
    .from('supplier_invoices')
    .select('status, registration_journal_entry_id, is_credit_note')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Block direct deletion of credit notes — deleting just the row would orphan the
  // posted reversal JE and silently break momsdeklaration. The user must instead
  // run "Ångra kreditering" on the original, which storno-reverses the JE and
  // restores the original's status atomically.
  if (existing.is_credit_note) {
    return NextResponse.json(
      {
        error:
          'Kreditfakturor kan inte tas bort direkt. Gå till originalfakturan och välj "Ångra kreditering" för att frigöra numret och återställa bokföringen.',
      },
      { status: 400 }
    )
  }

  if (existing.status !== 'registered') {
    return NextResponse.json(
      { error: 'Kan bara ta bort registrerade fakturor' },
      { status: 400 }
    )
  }

  // Delete items first, then invoice
  await supabase.from('supplier_invoice_items').delete().eq('supplier_invoice_id', id)

  const { error } = await supabase
    .from('supplier_invoices')
    .delete()
    .eq('id', id)
    .eq('company_id', companyId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
