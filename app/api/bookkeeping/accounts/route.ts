import { createClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { NextResponse } from 'next/server'
import { validateBody } from '@/lib/api/validate'
import { CreateAccountSchema } from '@/lib/api/schemas'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const { searchParams } = new URL(request.url)
  const accountClass = searchParams.get('class')
  const activeOnly = searchParams.get('active') !== 'false'

  try {
    const data = await fetchAllRows(({ from, to }) => {
      let query = supabase
        .from('chart_of_accounts')
        .select('*')
        .eq('company_id', companyId)
        .order('sort_order')

      if (activeOnly) {
        query = query.eq('is_active', true)
      }

      if (accountClass) {
        query = query.eq('account_class', parseInt(accountClass))
      }

      return query.range(from, to)
    })

    return NextResponse.json({ data })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to fetch accounts' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const validation = await validateBody(request, CreateAccountSchema)
  if (!validation.success) return validation.response
  const body = validation.data

  const companyId = await requireCompanyId(supabase, user.id)

  const { data, error } = await supabase
    .from('chart_of_accounts')
    .insert({
      user_id: user.id,
      company_id: companyId,
      account_number: body.account_number,
      account_name: body.account_name,
      account_class: parseInt(body.account_number[0]),
      account_group: body.account_number.substring(0, 2),
      account_type: body.account_type,
      normal_balance: body.normal_balance,
      plan_type: body.plan_type || 'k1',
      is_system_account: false,
      description: body.description || null,
      default_vat_code: body.default_vat_code || null,
      sru_code: body.sru_code || null,
      sort_order: parseInt(body.account_number),
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: `Kontonummer ${body.account_number} finns redan i din kontoplan.` },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}
