import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { CreateSalaryRunSchema } from '@/lib/api/schemas'
import { eventBus } from '@/lib/events'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

ensureInitialized()

export const GET = withRouteContext(
  'salary_run.list',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const year = searchParams.get('year')

    let query = supabase
      .from('salary_runs')
      .select('*')
      .eq('company_id', companyId)

    if (year) {
      query = query.eq('period_year', parseInt(year))
    }

    const { data, error } = await query
      .order('period_year', { ascending: false })
      .order('period_month', { ascending: false })

    if (error) {
      log.error('salary run list failed', error)
      return errorResponse(error, log, { requestId })
    }

    return NextResponse.json({ data })
  },
)

export const POST = withRouteContext(
  'salary_run.create',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, CreateSalaryRunSchema, {
      log,
      operation: 'salary_run.create',
    })
    if (!validation.success) return validation.response
    const body = validation.data

    const { data: existing } = await supabase
      .from('salary_runs')
      .select('id')
      .eq('company_id', companyId)
      .eq('period_year', body.period_year)
      .eq('period_month', body.period_month)
      .single()

    if (existing) {
      return errorResponseFromCode('CONFLICT', log, {
        requestId,
        details: {
          reason: 'salary_run_exists_for_period',
          existingId: existing.id,
          periodYear: body.period_year,
          periodMonth: body.period_month,
        },
      })
    }

    const { data: run, error } = await supabase
      .from('salary_runs')
      .insert({
        company_id: companyId,
        user_id: user.id,
        period_year: body.period_year,
        period_month: body.period_month,
        payment_date: body.payment_date,
        voucher_series: body.voucher_series,
        notes: body.notes || null,
      })
      .select()
      .single()

    if (error) {
      log.error('salary run insert failed', error)
      return errorResponseFromCode('SALARY_RUN_CREATE_FAILED', log, {
        requestId,
        details: { reason: error.message },
      })
    }

    await eventBus.emit({
      type: 'salary_run.created',
      payload: {
        salaryRunId: run.id,
        periodYear: body.period_year,
        periodMonth: body.period_month,
        userId: user.id,
        companyId: companyId!,
      },
    })

    return NextResponse.json({ data: run }, { status: 201 })
  },
  { requireWrite: true },
)
