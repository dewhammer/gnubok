import { NextResponse } from 'next/server'
import {
  createInvoicePaymentJournalEntry,
  createInvoiceCashEntry,
} from '@/lib/bookkeeping/invoice-entries'
import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { MarkInvoicePaidSchema } from '@/lib/api/schemas'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { CreateJournalEntryInput, EntityType, Invoice } from '@/types'

ensureInitialized()

/**
 * POST /api/invoices/[id]/mark-paid
 *
 * Manually marks an invoice as paid (for payments received outside bank sync).
 *
 * Faktureringsmetoden (accrual): Debit 1930, Credit 1510 (clearing entry)
 * Kontantmetoden (cash):         Debit 1930, Credit 30xx, Credit 26xx
 */
export const POST = withRouteContext(
  'invoice.mark_paid',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ invoiceId: id })

    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .select('*, customer:customers(*), items:invoice_items(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (invoiceError || !invoice) {
      return errorResponseFromCode('INVOICE_PAID_NOT_FOUND', opLog, { requestId })
    }

    if (invoice.status !== 'sent' && invoice.status !== 'overdue') {
      return errorResponseFromCode('INVOICE_PAID_NOT_PAYABLE', opLog, {
        requestId,
        details: { currentStatus: invoice.status },
      })
    }

    // Optional body. Backwards-compat: callers may POST with no body.
    let exchangeRateDifference: number | undefined
    let bodyPaymentDate: string | undefined
    let customLines: { account_number: string; debit_amount: number; credit_amount: number; line_description?: string }[] | undefined
    let rawBody: unknown
    try {
      const text = await request.text()
      if (text) rawBody = JSON.parse(text)
    } catch {
      // Empty / invalid body — fall through to defaults.
    }

    if (rawBody) {
      const parsed = MarkInvoicePaidSchema.safeParse(rawBody)
      if (!parsed.success) {
        opLog.warn('mark-paid validation failed', {
          issueCount: parsed.error.issues.length,
        })
        return NextResponse.json(
          { error: 'Ogiltig förfrågan', details: parsed.error.flatten() },
          { status: 400 },
        )
      }
      exchangeRateDifference = parsed.data.exchange_rate_difference
      bodyPaymentDate = parsed.data.payment_date
      customLines = parsed.data.lines
    }

    const now = new Date().toISOString()
    const paymentDate = bodyPaymentDate || now.split('T')[0]

    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method, entity_type')
      .eq('company_id', companyId)
      .single()

    const accountingMethod = settings?.accounting_method || 'accrual'
    const entityType = (settings?.entity_type as EntityType) || 'enskild_firma'

    const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'
    let journalEntryId: string | null = null

    if (isRealInvoice) {
      try {
        if (customLines) {
          const totalDebit = customLines.reduce((s, l) => s + l.debit_amount, 0)
          const totalCredit = customLines.reduce((s, l) => s + l.credit_amount, 0)
          if (Math.round((totalDebit - totalCredit) * 100) !== 0 || totalDebit <= 0) {
            return errorResponseFromCode('INVOICE_PAID_LINES_UNBALANCED', opLog, {
              requestId,
              details: { totalDebit, totalCredit },
            })
          }

          const fiscalPeriodId = await findFiscalPeriod(supabase, companyId!, paymentDate)
          if (!fiscalPeriodId) {
            return errorResponseFromCode('INVOICE_PAID_NO_FISCAL_PERIOD', opLog, {
              requestId,
              details: { paymentDate },
            })
          }
          const sourceType = accountingMethod === 'accrual' ? 'invoice_paid' : 'invoice_cash_payment'
          const input: CreateJournalEntryInput = {
            fiscal_period_id: fiscalPeriodId,
            entry_date: paymentDate,
            description: invoice.customer?.name
              ? `Inbetalning kundfaktura ${invoice.invoice_number}, ${invoice.customer.name}`
              : `Inbetalning kundfaktura ${invoice.invoice_number}`,
            source_type: sourceType,
            source_id: invoice.id,
            lines: customLines,
          }
          const journalEntry = await createJournalEntry(supabase, companyId!, user.id, input)
          journalEntryId = journalEntry?.id ?? null
        } else if (accountingMethod === 'accrual') {
          const journalEntry = await createInvoicePaymentJournalEntry(
            supabase, companyId!, user.id, invoice as Invoice, paymentDate,
            exchangeRateDifference, invoice.customer?.name,
          )
          journalEntryId = journalEntry?.id ?? null
        } else {
          const journalEntry = await createInvoiceCashEntry(
            supabase, companyId!, user.id, invoice as Invoice, paymentDate,
            entityType, invoice.customer?.name,
          )
          journalEntryId = journalEntry?.id ?? null
        }
      } catch (err) {
        if (isBookkeepingError(err)) {
          return errorResponse(err, opLog, { requestId })
        }
        opLog.error('failed to create payment journal entry', err as Error)
        return errorResponseFromCode('INVOICE_PAID_BOOK_FAILED', opLog, {
          requestId,
          details: { reason: err instanceof Error ? err.message : 'unknown' },
        })
      }
    }

    // CAS guard: only update if status is still in a payable state.
    const { data: updateResult, error: updateError } = await supabase
      .from('invoices')
      .update({
        status: 'paid',
        paid_at: now,
        paid_amount: invoice.total,
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .in('status', ['sent', 'overdue'])
      .select('id')

    if (updateError) {
      opLog.error('failed to update invoice status', updateError)
      return errorResponse(updateError, opLog, { requestId })
    }

    if (!updateResult || updateResult.length === 0) {
      // Status changed between read and write — cancel the orphaned JE and
      // document the voucher gap before reporting back.
      if (journalEntryId) {
        const { data: orphan } = await supabase
          .from('journal_entries')
          .select('fiscal_period_id, voucher_series, voucher_number')
          .eq('id', journalEntryId)
          .single()

        await supabase
          .from('journal_entries')
          .update({ status: 'cancelled' })
          .eq('id', journalEntryId)

        if (orphan) {
          await supabase.from('voucher_gap_explanations').insert({
            company_id: companyId,
            fiscal_period_id: orphan.fiscal_period_id,
            voucher_series: orphan.voucher_series || 'A',
            gap_number: orphan.voucher_number,
            explanation: 'Automatiskt makulerad: dubblettbokning förhindrad av samtidighetsskydd',
            created_by: user.id,
          })
        }
      }
      return errorResponseFromCode('INVOICE_PAID_RACE', opLog, { requestId })
    }

    return NextResponse.json({
      success: true,
      status: 'paid',
      paid_at: now,
      paid_amount: invoice.total,
      journal_entry_id: journalEntryId,
    })
  },
  { requireWrite: true },
)
