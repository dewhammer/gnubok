import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { ensureInitialized } from '@/lib/init'
import { eventBus } from '@/lib/events/bus'
import { getErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const { data, error } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 404 })
  }

  return NextResponse.json({ data })
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const { data, error } = await supabase.rpc('delete_last_voucher', {
    p_company_id: companyId,
    p_entry_id: id,
  })

  if (error) {
    return NextResponse.json(
      { error: getErrorMessage(error, { context: 'journal_entry', statusCode: 400 }) },
      { status: 400 }
    )
  }

  await eventBus.emit({
    type: 'journal_entry.deleted',
    payload: {
      entryId: id,
      voucherSeries: data.voucher_series,
      voucherNumber: data.voucher_number,
      userId: user.id,
      companyId,
    },
  })

  return NextResponse.json({ data })
}
