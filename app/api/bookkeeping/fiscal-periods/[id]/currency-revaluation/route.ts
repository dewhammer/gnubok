import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import {
  previewCurrencyRevaluation,
  executeCurrencyRevaluation,
} from '@/lib/bookkeeping/currency-revaluation'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'

/**
 * GET: Preview currency revaluation for a fiscal period
 */
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

  try {
    // Fetch period to get closing date
    const { data: period, error: periodError } = await supabase
      .from('fiscal_periods')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (periodError || !period) {
      return NextResponse.json({ error: 'Fiscal period not found' }, { status: 404 })
    }

    const preview = await previewCurrencyRevaluation(supabase, companyId, period.period_end)
    return NextResponse.json({ data: preview })
  } catch (err) {
    const typed = bookkeepingErrorResponse(err)
    if (typed) return typed
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to preview currency revaluation' },
      { status: 400 }
    )
  }
}

/**
 * POST: Execute currency revaluation for a fiscal period
 */
export async function POST(
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

  try {
    // Fetch period to get closing date
    const { data: period, error: periodError } = await supabase
      .from('fiscal_periods')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (periodError || !period) {
      return NextResponse.json({ error: 'Fiscal period not found' }, { status: 404 })
    }

    if (period.is_closed) {
      return NextResponse.json({ error: 'Period is already closed' }, { status: 400 })
    }

    const result = await executeCurrencyRevaluation(supabase, companyId, period.period_end, id, user.id)

    if (!result) {
      return NextResponse.json({ data: null, message: 'No foreign currency items to revalue' })
    }

    return NextResponse.json({ data: result })
  } catch (err) {
    const typed = bookkeepingErrorResponse(err)
    if (typed) return typed
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to execute currency revaluation' },
      { status: 400 }
    )
  }
}
