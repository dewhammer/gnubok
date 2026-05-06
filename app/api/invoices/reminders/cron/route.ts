import { NextResponse } from 'next/server'
import { processOverdueReminders } from '@/lib/invoices/reminder-processor'
import { getEmailService } from '@/lib/email/service'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * GET/POST /api/invoices/reminders/cron — daily 08:00 UTC.
 * Sends overdue invoice reminders. POST exists so the dashboard can
 * trigger a run manually.
 */
export const GET = withCronContext('cron.invoice_reminders', async (_request, ctx) => {
  if (!getEmailService().isConfigured()) {
    ctx.log.error('email service not configured; skipping reminder run')
    return errorResponseFromCode('INVOICE_SEND_EMAIL_NOT_CONFIGURED', ctx.log, {
      requestId: ctx.requestId,
    })
  }

  const result = await processOverdueReminders()

  ctx.log.info('reminder cron summary', {
    processed: result.processed,
    sent: result.sent,
    failed: result.failed,
  })

  return NextResponse.json({
    success: true,
    processed: result.processed,
    sent: result.sent,
    failed: result.failed,
    results: result.results.map((r) => ({
      invoiceNumber: r.invoiceNumber,
      reminderLevel: r.reminderLevel,
      success: r.success,
      error: r.error,
    })),
  })
})

export const POST = GET
