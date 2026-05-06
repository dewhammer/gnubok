import { NextResponse } from 'next/server'
import {
  validateYearEndReadiness,
  previewYearEndClosing,
  executeYearEndClosing,
} from '@/lib/core/bookkeeping/year-end-service'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

/** GET: validate readiness + preview the year-end entries. */
export const GET = withRouteContext(
  'period.year_end_preview',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ periodId: id })

    try {
      const [validation, preview] = await Promise.all([
        validateYearEndReadiness(supabase, companyId!, user.id, id),
        previewYearEndClosing(supabase, companyId!, user.id, id),
      ])
      return NextResponse.json({ data: { validation, preview } })
    } catch (err) {
      opLog.error('year-end preview failed', err as Error)
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', opLog, { requestId })
      }
      return errorResponseFromCode('YEAR_END_PREVIEW_FAILED', opLog, {
        requestId,
        details: { reason: message },
      })
    }
  },
)

/** POST: actually run year-end closing. */
export const POST = withRouteContext(
  'period.year_end',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ periodId: id })

    try {
      const result = await executeYearEndClosing(supabase, companyId!, user.id, id)
      return NextResponse.json({ data: result })
    } catch (err) {
      opLog.error('year-end execution failed', err as Error)
      const message = err instanceof Error ? err.message : ''
      if (/prior.*open/i.test(message)) {
        return errorResponseFromCode('YEAR_END_PRIOR_PERIOD_OPEN', opLog, {
          requestId,
          details: { reason: message },
        })
      }
      if (/not balanced|unbalanced/i.test(message)) {
        return errorResponseFromCode('YEAR_END_UNBALANCED_TRIAL', opLog, {
          requestId,
          details: { reason: message },
        })
      }
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', opLog, { requestId })
      }
      // Fall through bookkeeping/Zod/etc to errorResponse, but cap to YEAR_END_FAILED.
      const fallback = errorResponse(err, opLog, { requestId })
      if (fallback.status === 500) {
        return errorResponseFromCode('YEAR_END_FAILED', opLog, {
          requestId,
          details: { reason: message },
        })
      }
      return fallback
    }
  },
  { requireWrite: true },
)
