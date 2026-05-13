/**
 * POST /api/v1/companies/{companyId}/reconciliation/bank/run
 *
 * Run the bank-reconciliation pipeline: look for bank-side transactions and
 * GL-side journal lines that pair up by amount + date proximity, then apply
 * the matches (set `transactions.journal_entry_id` for confirmed pairs).
 *
 * Dry-run returns the proposed matches without applying any of them — the
 * canonical way to preview a reconciliation before letting it write to the
 * ledger. Idempotent via mandatory Idempotency-Key.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { runReconciliation } from '@/lib/reconciliation/bank-reconciliation'

const RunRequest = z
  .object({
    date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  // Bound the window so a key with no explicit range can't trigger an
  // unbounded join across years. 366 days covers a full räkenskapsår + a
  // leap day; longer reconciliations should be paged.
  .refine(
    (d) => {
      if (!d.date_from || !d.date_to) return true
      const ms = new Date(d.date_to).getTime() - new Date(d.date_from).getTime()
      return ms >= 0 && ms <= 366 * 24 * 60 * 60 * 1000
    },
    { message: 'date range must be ≤ 366 days; page longer reconciliations.' },
  )

const MatchOut = z.object({
  transaction_id: z.string().uuid(),
  transaction_date: z.string(),
  transaction_description: z.string().nullable(),
  transaction_amount: z.number(),
  journal_entry_id: z.string().uuid(),
  voucher_number: z.number().int().nullable(),
  voucher_series: z.string().nullable(),
  entry_date: z.string(),
  entry_description: z.string().nullable(),
  method: z.string(),
  confidence: z.number(),
})

const RunResponse = z.object({
  matches: z.array(MatchOut),
  applied: z.number().int(),
  errors: z.array(z.string()),
})

registerEndpoint({
  operation: 'reconciliation.bank.run',
  method: 'POST',
  path: '/api/v1/companies/:companyId/reconciliation/bank/run',
  summary: 'Run the bank-reconciliation matcher.',
  description:
    'Walks all unbooked bank transactions in the requested date range and pairs them with open GL lines (1930-side) by amount + date proximity. Applies confirmed matches by setting transactions.journal_entry_id (the GL row already exists). Dry-runnable.',
  useWhen:
    'You want to auto-match outstanding bank transactions against existing journal entries — typically as the closing step of a sync. Dry-run first to inspect proposed matches.',
  doNotUseFor:
    'Creating new journal entries — this only links bank transactions to existing GL lines. Matching to invoices — use `:match-invoice` or `:match-supplier-invoice` for explicit invoice payments.',
  pitfalls: [
    'date_from / date_to default to the company\'s full bank history if omitted. Specify a window for predictable performance.',
    'Idempotency-Key is mandatory.',
    'matches.confidence is between 0 and 1; the matcher only applies matches above the internal threshold (currently ~0.85).',
  ],
  example: {
    request: { date_from: '2026-05-01', date_to: '2026-05-31' },
    response: {
      data: { matches: [], applied: 0, errors: [] },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:write',
  risk: 'medium',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  request: { body: RunRequest },
  response: { success: RunResponse },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'reconciliation.bank.run',
  async (request, ctx) => {
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      // Body is optional — an empty body is fine.
      rawBody = {}
    }
    const parsed = RunRequest.safeParse(rawBody)
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          })),
        },
      })
    }
    const body = parsed.data

    let result
    try {
      result = await runReconciliation(ctx.supabase, ctx.companyId!, ctx.userId, {
        dateFrom: body.date_from,
        dateTo: body.date_to,
        dryRun: ctx.dryRun,
      })
    } catch (err) {
      ctx.log.error('reconciliation.bank.run: pipeline failed', err as Error)
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }

    const matches = result.matches.map((m) => ({
      transaction_id: m.transaction.id,
      transaction_date: m.transaction.date,
      transaction_description: m.transaction.description ?? null,
      transaction_amount: m.transaction.amount,
      journal_entry_id: m.glLine.journal_entry_id,
      voucher_number: m.glLine.voucher_number ?? null,
      voucher_series: m.glLine.voucher_series ?? null,
      entry_date: m.glLine.entry_date,
      entry_description: m.glLine.entry_description ?? null,
      method: m.method,
      confidence: m.confidence,
    }))

    const payload = {
      matches,
      applied: result.applied,
      errors: result.errors,
    }

    if (ctx.dryRun) {
      return dryRunPreview(payload, { requestId: ctx.requestId, log: ctx.log })
    }
    return ok(payload, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
