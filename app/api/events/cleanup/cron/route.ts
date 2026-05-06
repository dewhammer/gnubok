import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse } from '@/lib/errors/get-structured-error'

/**
 * GET /api/events/cleanup/cron — daily 02:00 UTC.
 * Removes event_log rows older than 30 days.
 */
export const GET = withCronContext('cron.events_cleanup', async (_request, ctx) => {
  const supabase = createServiceClient()

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 30)

  const { error, count } = await supabase
    .from('event_log')
    .delete({ count: 'exact' })
    .lt('created_at', cutoff.toISOString())

  if (error) {
    ctx.log.error('event log cleanup failed', error)
    return errorResponse(error, ctx.log, { requestId: ctx.requestId })
  }

  const deleted = count ?? 0
  ctx.log.info('event log cleanup summary', { deleted, cutoff: cutoff.toISOString() })

  return NextResponse.json({ success: true, deleted })
})
