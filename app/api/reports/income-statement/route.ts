import { NextResponse } from 'next/server'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

export const GET = withRouteContext(
  'report.income_statement',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const periodId = searchParams.get('period_id')

    if (!periodId) {
      return errorResponseFromCode('REPORT_PERIOD_REQUIRED', log, { requestId })
    }

    const opLog = log.child({ periodId })

    const { data: period } = await supabase
      .from('fiscal_periods')
      .select('period_start, period_end')
      .eq('id', periodId)
      .eq('company_id', companyId)
      .single()

    try {
      const result = await generateIncomeStatement(supabase, companyId!, periodId)

      if (period) {
        result.period = {
          start: period.period_start,
          end: period.period_end,
        }
      }

      return NextResponse.json({ data: result })
    } catch (err) {
      opLog.error('income statement generation failed', err as Error)
      return errorResponseFromCode('REPORT_GENERATION_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
  },
)
