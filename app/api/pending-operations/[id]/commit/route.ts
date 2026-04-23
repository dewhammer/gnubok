import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { buildMappingResultFromCategory } from '@/lib/bookkeeping/category-mapping'
import { createTransactionJournalEntry } from '@/lib/bookkeeping/transaction-entries'
import { upsertCounterpartyTemplate } from '@/lib/bookkeeping/counterparty-templates'
import { getVatRules, getAvailableVatRates } from '@/lib/invoices/vat-rules'
import { fetchExchangeRate, convertToSEK } from '@/lib/currency/riksbanken'
import { validateVatNumber } from '@/lib/vat/vies-client'
import {
  createInvoicePaymentJournalEntry,
  createInvoiceCashEntry,
  createInvoiceJournalEntry,
} from '@/lib/bookkeeping/invoice-entries'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import {
  AccountsNotInChartError,
  bookkeepingErrorResponse,
  isBookkeepingError,
} from '@/lib/bookkeeping/errors'
import { getEmailService } from '@/lib/email/service'
import {
  generateInvoiceEmailHtml,
  generateInvoiceEmailText,
  generateInvoiceEmailSubject,
} from '@/lib/email/invoice-templates'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { renderToBuffer } from '@react-pdf/renderer'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { createLogger } from '@/lib/logger'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import type {
  Transaction,
  TransactionCategory,
  EntityType,
  VatTreatment,
  Currency,
  Invoice,
  Customer,
  PendingOperation,
  CompanySettings,
  InvoiceItem,
} from '@/types'

const log = createLogger('pending-operations/commit')

ensureInitialized()

/**
 * Record a best-effort processing_history breadcrumb when the invoice's
 * accrual journal entry couldn't be booked. The pending-operation itself
 * still succeeds (invoice email delivered / status set), but the JE is
 * missing — which in the accrual case means revenue (3001) and utgående
 * moms (2611) are unposted for the period, understating the momsdeklaration.
 *
 * The event makes the gap visible and actionable: an operator or bokföring
 * consultant can query processing_history for `InvoiceJournalEntrySkipped`
 * and re-book the missing verifikation (via the activation dialog or
 * manually) before the momsdeklaration is filed. Swallows its own errors
 * to preserve the non-blocking contract with the caller.
 */
async function recordSkippedInvoiceJournalEntry(
  invoiceId: string,
  companyId: string,
  userId: string,
  operation: 'send_invoice' | 'mark_invoice_sent',
  err: unknown
): Promise<void> {
  try {
    const reasonCode = err instanceof AccountsNotInChartError
      ? 'accounts_not_in_chart'
      : 'journal_entry_error'
    const accountNumbers = err instanceof AccountsNotInChartError ? err.accountNumbers : undefined
    await appendProcessingHistory({
      companyId,
      correlationId: invoiceId,
      aggregateType: 'System',
      aggregateId: invoiceId,
      eventType: 'InvoiceJournalEntrySkipped',
      payload: {
        invoice_id: invoiceId,
        operation,
        reason_code: reasonCode,
        ...(accountNumbers ? { account_numbers: accountNumbers } : {}),
      },
      actor: { type: 'user', id: userId },
      occurredAt: new Date(),
    })
  } catch (historyErr) {
    log.warn('Failed to append InvoiceJournalEntrySkipped to processing_history', historyErr)
  }
}

/**
 * Ensure a fiscal period exists for the given date, create one if needed.
 * Same logic as app/api/transactions/[id]/categorize/route.ts
 */
async function ensureFiscalPeriod(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  companyId: string,
  date: string,
  fiscalYearStartMonth: number = 1
): Promise<boolean> {
  const { data: existing } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('company_id', companyId)
    .lte('period_start', date)
    .gte('period_end', date)
    .eq('is_closed', false)
    .limit(1)

  if (existing && existing.length > 0) return true

  const txDate = new Date(date)
  const txMonth = txDate.getMonth() + 1
  const txYear = txDate.getFullYear()

  let periodStartYear: number
  if (fiscalYearStartMonth === 1) {
    periodStartYear = txYear
  } else if (txMonth >= fiscalYearStartMonth) {
    periodStartYear = txYear
  } else {
    periodStartYear = txYear - 1
  }

  const startMonth = String(fiscalYearStartMonth).padStart(2, '0')
  const periodStart = `${periodStartYear}-${startMonth}-01`

  const endYear = fiscalYearStartMonth === 1 ? periodStartYear : periodStartYear + 1
  const endMonth = fiscalYearStartMonth === 1 ? 12 : fiscalYearStartMonth - 1
  const lastDay = new Date(endYear, endMonth, 0).getDate()
  const periodEnd = `${endYear}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

  const periodName = fiscalYearStartMonth === 1
    ? `Räkenskapsår ${periodStartYear}`
    : `Räkenskapsår ${periodStartYear}/${endYear}`

  const { error } = await supabase
    .from('fiscal_periods')
    .upsert({
      user_id: userId,
      company_id: companyId,
      name: periodName,
      period_start: periodStart,
      period_end: periodEnd,
    }, { onConflict: 'user_id,period_start,period_end' })

  if (error) {
    log.error('Failed to create fiscal period:', error)
    return false
  }
  return true
}

// ── Commit executors ──────────────────────────────────────────

async function commitCategorizeTransaction(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<{ data?: Record<string, unknown>; error?: string; status?: number }> {
  const txId = params.transaction_id as string
  const category = params.category as TransactionCategory
  const vatTreatment = params.vat_treatment as VatTreatment | undefined

  // Fetch transaction — guard against double-commit
  const { data: transaction, error: fetchError } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', txId)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !transaction) {
    return { error: 'Transaction not found — it may have been deleted.', status: 404 }
  }

  if (transaction.journal_entry_id) {
    return { error: 'Transaction already has a journal entry — it was categorized in the meantime.', status: 409 }
  }

  const isBusiness = category !== 'private'

  // Fetch company settings
  const { data: settings } = await supabase
    .from('company_settings')
    .select('entity_type, fiscal_year_start_month')
    .eq('company_id', companyId)
    .single()

  const entityType: EntityType = (settings?.entity_type as EntityType) || 'enskild_firma'
  const fiscalYearStartMonth = settings?.fiscal_year_start_month ?? 1

  // Build mapping
  const mappingResult = buildMappingResultFromCategory(
    category,
    transaction as Transaction,
    isBusiness,
    entityType,
    vatTreatment
  )

  if (!mappingResult.debit_account || !mappingResult.credit_account) {
    return { error: `No account mapping for category "${category}" with entity type "${entityType}".`, status: 400 }
  }

  // Ensure fiscal period exists
  await ensureFiscalPeriod(supabase, userId, companyId, transaction.date, fiscalYearStartMonth)

  // Create journal entry
  let journalEntryId: string | null = null
  try {
    const journalEntry = await createTransactionJournalEntry(
      supabase, companyId, userId, transaction as Transaction, mappingResult
    )
    if (journalEntry) {
      journalEntryId = journalEntry.id
    }
  } catch (err) {
    if (isBookkeepingError(err)) throw err
    log.error('Failed to create journal entry:', err)
    return { error: err instanceof Error ? err.message : 'Failed to create journal entry', status: 500 }
  }

  // Update transaction
  const { error: updateError } = await supabase
    .from('transactions')
    .update({
      is_business: isBusiness,
      category,
      journal_entry_id: journalEntryId,
    })
    .eq('id', txId)

  if (updateError) {
    log.error('Failed to update transaction:', updateError)
    return { error: 'Failed to update transaction', status: 500 }
  }

  // Upsert counterparty template (non-blocking)
  try {
    await upsertCounterpartyTemplate(
      supabase, userId, transaction as Transaction, mappingResult, 'user_approved'
    )
  } catch { /* non-critical */ }

  // Emit event
  await eventBus.emit({
    type: 'transaction.categorized',
    payload: {
      transaction: transaction as Transaction,
      account: mappingResult.debit_account,
      taxCode: mappingResult.vat_lines[0]?.account_number || '',
      userId,
      companyId,
    },
  })

  return { data: { journal_entry_id: journalEntryId, category } }
}

async function commitCreateCustomer(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<{ data?: Record<string, unknown>; error?: string; status?: number }> {
  const { data, error } = await supabase
    .from('customers')
    .insert({
      user_id: userId,
      company_id: companyId,
      name: params.name as string,
      customer_type: params.customer_type as string,
      email: (params.email as string) || null,
      org_number: (params.org_number as string) || null,
      vat_number: (params.vat_number as string) || null,
      default_payment_terms: (params.payment_terms as number) || 30,
      address_line1: (params.address as string) || null,
      postal_code: (params.postal_code as string) || null,
      city: (params.city as string) || null,
      country: (params.country as string) || 'Sweden',
    })
    .select()
    .single()

  if (error) {
    return { error: error.message, status: 500 }
  }

  // Auto-validate VAT number for EU business customers (non-blocking)
  if (params.customer_type === 'eu_business' && params.vat_number) {
    try {
      const vatResult = await validateVatNumber(params.vat_number as string)
      if (vatResult.valid) {
        await supabase
          .from('customers')
          .update({
            vat_number_validated: true,
            vat_number_validated_at: new Date().toISOString(),
          })
          .eq('id', data.id)
          .eq('company_id', companyId)
      }
    } catch (err) {
      log.warn('Auto-VIES validation failed:', err)
    }
  }

  await eventBus.emit({
    type: 'customer.created',
    payload: { customer: data as Customer, userId, companyId },
  })

  return { data: { customer_id: data.id } }
}

async function commitCreateInvoice(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<{ data?: Record<string, unknown>; error?: string; status?: number }> {
  const customerId = params.customer_id as string
  const items = params.items as Array<{
    description: string
    quantity: number
    unit: string
    unit_price: number
    vat_rate?: number
  }>

  // Fetch customer
  const { data: customer, error: customerError } = await supabase
    .from('customers')
    .select('*')
    .eq('id', customerId)
    .eq('company_id', companyId)
    .single()

  if (customerError || !customer) {
    return { error: 'Customer not found — they may have been deleted.', status: 404 }
  }

  // Calculate VAT
  const vatRules = getVatRules(customer.customer_type, customer.vat_number_validated)
  const availableRates = getAvailableVatRates(customer.customer_type, customer.vat_number_validated)
  const allowedRates = new Set(availableRates.map((r) => r.rate))

  const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0)

  let vatAmount = 0
  for (const item of items) {
    const itemRate = item.vat_rate !== undefined ? item.vat_rate : vatRules.rate
    if (!allowedRates.has(itemRate)) {
      return { error: `Momssats ${itemRate}% är inte tillåten för denna kundtyp`, status: 400 }
    }
    const lineTotal = item.quantity * item.unit_price
    vatAmount += Math.round(lineTotal * itemRate / 100 * 100) / 100
  }

  const total = subtotal + vatAmount
  const currency = ((params.currency as string) || 'SEK') as Currency

  // Exchange rate
  let exchangeRate: number | null = null
  let exchangeRateDate: string | null = null
  let subtotalSek: number | null = null
  let vatAmountSek: number | null = null
  let totalSek: number | null = null

  if (currency !== 'SEK') {
    const rateData = await fetchExchangeRate(currency)
    if (rateData) {
      exchangeRate = rateData.rate
      exchangeRateDate = rateData.date
      subtotalSek = convertToSEK(subtotal, exchangeRate)
      vatAmountSek = convertToSEK(vatAmount, exchangeRate)
      totalSek = convertToSEK(total, exchangeRate)
    }
  }

  // Mixed-rate detection
  const uniqueRates = new Set(items.map((item) => item.vat_rate ?? vatRules.rate))
  const isMixedRate = uniqueRates.size > 1

  // Generate invoice number
  const { data: invoiceNumber } = await supabase.rpc('generate_invoice_number', {
    p_company_id: companyId,
  })

  // Create invoice
  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .insert({
      user_id: userId,
      company_id: companyId,
      customer_id: customerId,
      invoice_number: invoiceNumber,
      invoice_date: (params.invoice_date as string) || new Date().toISOString().split('T')[0],
      due_date: (params.due_date as string) || null,
      currency,
      exchange_rate: exchangeRate,
      exchange_rate_date: exchangeRateDate,
      subtotal,
      subtotal_sek: subtotalSek,
      vat_amount: vatAmount,
      vat_amount_sek: vatAmountSek,
      total,
      total_sek: totalSek,
      vat_treatment: vatRules.treatment,
      vat_rate: isMixedRate ? null : (uniqueRates.values().next().value ?? vatRules.rate),
      moms_ruta: vatRules.momsRuta,
      reverse_charge_text: vatRules.reverseChargeText || null,
      our_reference: (params.our_reference as string) || null,
      your_reference: (params.your_reference as string) || null,
      notes: (params.notes as string) || null,
    })
    .select()
    .single()

  if (invoiceError) {
    return { error: invoiceError.message, status: 500 }
  }

  // Create invoice items
  const invoiceItems = items.map((item, index) => {
    const itemRate = item.vat_rate !== undefined ? item.vat_rate : vatRules.rate
    const lineTotal = item.quantity * item.unit_price
    const itemVat = Math.round(lineTotal * itemRate / 100 * 100) / 100
    return {
      invoice_id: invoice.id,
      sort_order: index,
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: item.unit_price,
      line_total: lineTotal,
      vat_rate: itemRate,
      vat_amount: itemVat,
    }
  })

  const { error: itemsError } = await supabase
    .from('invoice_items')
    .insert(invoiceItems)

  if (itemsError) {
    // Rollback invoice
    await supabase.from('invoices').delete().eq('id', invoice.id)
    return { error: itemsError.message, status: 500 }
  }

  // Fetch complete invoice
  const { data: completeInvoice } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoice.id)
    .single()

  if (completeInvoice) {
    await eventBus.emit({
      type: 'invoice.created',
      payload: { invoice: completeInvoice as Invoice, userId, companyId },
    })
  }

  return { data: { invoice_id: invoice.id, invoice_number: invoiceNumber } }
}

async function commitMarkInvoicePaid(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<{ data?: Record<string, unknown>; error?: string; status?: number }> {
  const invoiceId = params.invoice_id as string
  const paymentDate = (params.payment_date as string) || new Date().toISOString().split('T')[0]

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .single()

  if (invoiceError || !invoice) return { error: 'Invoice not found', status: 404 }
  if (invoice.status !== 'sent' && invoice.status !== 'overdue') {
    return { error: 'Invoice can only be marked as paid when status is "sent" or "overdue"', status: 409 }
  }

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
    if (accountingMethod === 'accrual') {
      const je = await createInvoicePaymentJournalEntry(
        supabase, companyId, userId, invoice as Invoice, paymentDate, undefined, invoice.customer?.name
      )
      journalEntryId = je?.id ?? null
    } else {
      const je = await createInvoiceCashEntry(
        supabase, companyId, userId, invoice as Invoice, paymentDate, entityType, invoice.customer?.name
      )
      journalEntryId = je?.id ?? null
    }
  }

  const now = new Date().toISOString()
  const { error: updateError } = await supabase
    .from('invoices')
    .update({ status: 'paid', paid_at: now, paid_amount: invoice.total })
    .eq('id', invoiceId)
    .eq('company_id', companyId)

  if (updateError) return { error: 'Failed to update invoice status', status: 500 }

  return { data: { status: 'paid', journal_entry_id: journalEntryId } }
}

async function commitSendInvoice(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
  userEmail?: string
): Promise<{ data?: Record<string, unknown>; error?: string; status?: number }> {
  const invoiceId = params.invoice_id as string

  const emailService = getEmailService()
  if (!emailService.isConfigured()) {
    return { error: 'Email service not configured', status: 500 }
  }

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .single()

  if (invoiceError || !invoice) return { error: 'Invoice not found', status: 404 }
  if (invoice.status === 'sent' || invoice.status === 'paid' || invoice.status === 'overdue') {
    return { error: 'Invoice has already been sent', status: 409 }
  }

  const customer = invoice.customer as Customer
  if (!customer.email) return { error: 'Customer has no email address', status: 400 }

  const { data: company, error: companyError } = await supabase
    .from('company_settings')
    .select('*')
    .eq('company_id', companyId)
    .single()

  if (companyError || !company) return { error: 'Company settings missing', status: 500 }

  const items = (invoice.items as InvoiceItem[]).sort(
    (a: InvoiceItem, b: InvoiceItem) => a.sort_order - b.sort_order
  )

  let originalInvoiceNumber: string | undefined
  if (invoice.credited_invoice_id) {
    const { data: orig } = await supabase
      .from('invoices')
      .select('invoice_number')
      .eq('id', invoice.credited_invoice_id)
      .single()
    if (orig) originalInvoiceNumber = orig.invoice_number
  }

  const pdfBuffer = await renderToBuffer(
    InvoicePDF({
      invoice: invoice as Invoice,
      customer,
      items,
      company: company as CompanySettings,
      originalInvoiceNumber,
    })
  )

  const isCreditNote = !!invoice.credited_invoice_id
  const docType = invoice.document_type || 'invoice'
  let filename: string
  if (isCreditNote) filename = `kreditfaktura-${invoice.invoice_number}.pdf`
  else if (docType === 'proforma') filename = `proformafaktura-${invoice.invoice_number}.pdf`
  else if (docType === 'delivery_note') filename = `foljesedel-${invoice.invoice_number}.pdf`
  else filename = `faktura-${invoice.invoice_number}.pdf`

  const ccAddress = company.email || userEmail

  const emailData = { invoice: invoice as Invoice, customer, company: company as CompanySettings }
  const result = await emailService.sendEmail({
    to: customer.email,
    cc: ccAddress,
    subject: generateInvoiceEmailSubject(emailData),
    html: generateInvoiceEmailHtml(emailData),
    text: generateInvoiceEmailText(emailData),
    replyTo: company.email || undefined,
    fromName: company.trade_name || company.company_name,
    attachments: [{ filename, content: pdfBuffer, contentType: 'application/pdf' }],
  })

  if (!result.success) return { error: `Failed to send email: ${result.error}`, status: 500 }

  await supabase.from('invoices').update({ status: 'sent' }).eq('id', invoiceId).eq('company_id', companyId)

  const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'
  let createdJournalEntryId: string | undefined
  if (isRealInvoice && (company.accounting_method === 'accrual' || !company.accounting_method)) {
    try {
      const je = await createInvoiceJournalEntry(
        supabase, companyId, userId, invoice as Invoice, (company as CompanySettings).entity_type
      )
      if (je) {
        createdJournalEntryId = je.id
        await supabase.from('invoices').update({ journal_entry_id: je.id }).eq('id', invoiceId)
      }
    } catch (err) {
      // Non-blocking: the invoice is already sent by this point and the user
      // can retry the journal entry separately. Re-throwing here would mean
      // the email has already gone out but the outer 400 would report
      // failure — worst of both worlds.
      //
      // Record a processing_history breadcrumb so the missing verifikation
      // surfaces in audit trails and the momsdeklaration gap is actionable
      // rather than silent. TODO: wire ActivateAccountsDialog into this
      // pending-op flow, then re-introduce blocking for ACCOUNTS_NOT_IN_CHART.
      await recordSkippedInvoiceJournalEntry(invoiceId, companyId, userId, 'send_invoice', err)
    }
  }

  if (isRealInvoice) {
    try {
      const pdfArrayBuffer = new Uint8Array(pdfBuffer).buffer as ArrayBuffer
      await uploadDocument(supabase, userId, companyId, {
        name: filename,
        buffer: pdfArrayBuffer,
        type: 'application/pdf',
      }, {
        upload_source: 'system',
        journal_entry_id: createdJournalEntryId,
      })
    } catch { /* non-blocking */ }
  }

  await eventBus.emit({ type: 'invoice.sent', payload: { invoice: invoice as Invoice, userId, companyId } })

  return { data: { message: `Invoice ${invoice.invoice_number} sent to ${customer.email}` } }
}

async function commitMarkInvoiceSent(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<{ data?: Record<string, unknown>; error?: string; status?: number }> {
  const invoiceId = params.invoice_id as string

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .single()

  if (invoiceError || !invoice) return { error: 'Invoice not found', status: 404 }
  if (invoice.status !== 'draft') return { error: 'Only draft invoices can be marked as sent', status: 409 }

  const { error: updateError } = await supabase
    .from('invoices')
    .update({ status: 'sent' })
    .eq('id', invoiceId)
    .eq('company_id', companyId)

  if (updateError) return { error: 'Failed to update invoice status', status: 500 }

  const { data: settings } = await supabase
    .from('company_settings')
    .select('accounting_method, entity_type')
    .eq('company_id', companyId)
    .single()

  const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'
  let journalEntryId: string | null = null

  if (isRealInvoice && (settings?.accounting_method === 'accrual' || !settings?.accounting_method)) {
    try {
      const je = await createInvoiceJournalEntry(
        supabase, companyId, userId, invoice as Invoice,
        (settings?.entity_type as EntityType) || 'enskild_firma',
        invoice.customer?.name
      )
      if (je) {
        journalEntryId = je.id
        await supabase.from('invoices').update({ journal_entry_id: je.id }).eq('id', invoiceId)
      }
    } catch (err) {
      // Non-blocking: invoice is already marked as sent. Record a
      // processing_history breadcrumb so the missing JE is visible in audit
      // trails. TODO: wire ActivateAccountsDialog into this pending-op flow,
      // then re-introduce blocking for ACCOUNTS_NOT_IN_CHART here.
      await recordSkippedInvoiceJournalEntry(invoiceId, companyId, userId, 'mark_invoice_sent', err)
    }
  }

  return { data: { status: 'sent', journal_entry_id: journalEntryId } }
}

async function commitMatchTransactionInvoice(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<{ data?: Record<string, unknown>; error?: string; status?: number }> {
  const transactionId = params.transaction_id as string
  const invoiceId = params.invoice_id as string

  const { data: transaction, error: txError } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .single()

  if (txError || !transaction) return { error: 'Transaction not found', status: 404 }
  if (transaction.amount <= 0) return { error: 'Only income transactions can be matched', status: 400 }
  if (transaction.invoice_id) return { error: 'Transaction already linked to an invoice', status: 409 }

  const { data: invoice, error: invError } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .single()

  if (invError || !invoice) return { error: 'Invoice not found', status: 404 }
  if (!['sent', 'overdue', 'partially_paid'].includes(invoice.status)) {
    return { error: 'Invoice is not in a matchable state', status: 409 }
  }

  // Storno conflicting journal entry
  if (transaction.journal_entry_id) {
    await reverseEntry(supabase, companyId, userId, transaction.journal_entry_id)
    await supabase.from('transactions').update({ journal_entry_id: null }).eq('id', transactionId)
  }

  const now = new Date().toISOString()
  const paidAmount = transaction.amount
  const newPaidAmount = Math.round(((invoice.paid_amount || 0) + paidAmount) * 100) / 100
  const currentRemaining = invoice.remaining_amount ?? (invoice.total - (invoice.paid_amount || 0))
  const newRemaining = Math.max(0, Math.round((currentRemaining - paidAmount) * 100) / 100)
  const isFullyPaid = newRemaining <= 0
  const newStatus = isFullyPaid ? 'paid' : 'partially_paid'

  const { data: settings } = await supabase
    .from('company_settings')
    .select('accounting_method, entity_type')
    .eq('company_id', companyId)
    .single()

  const accountingMethod = settings?.accounting_method || 'accrual'
  const entityType = (settings?.entity_type as EntityType) || 'enskild_firma'

  let journalEntryId: string | null = null
  try {
    if (accountingMethod === 'cash' && isFullyPaid) {
      const je = await createInvoiceCashEntry(
        supabase, companyId, userId, invoice as Invoice, transaction.date, entityType, invoice.customer?.name
      )
      journalEntryId = je?.id ?? null
    } else {
      const je = await createInvoicePaymentJournalEntry(
        supabase, companyId, userId, invoice as Invoice, transaction.date, undefined, invoice.customer?.name, paidAmount
      )
      journalEntryId = je?.id ?? null
    }
  } catch (err) {
    if (isBookkeepingError(err)) throw err
    log.error('Failed to create match journal entry:', err)
  }

  const { data: updatedRows, error: updateInvError } = await supabase
    .from('invoices')
    .update({
      status: newStatus,
      paid_at: isFullyPaid ? now : null,
      paid_amount: newPaidAmount,
      remaining_amount: newRemaining,
    })
    .eq('id', invoiceId)
    .in('status', ['sent', 'overdue', 'partially_paid'])
    .select('id')

  if (updateInvError) return { error: 'Failed to update invoice status', status: 500 }
  if (!updatedRows || updatedRows.length === 0) {
    return { error: 'Invoice has already been fully paid or is no longer matchable', status: 409 }
  }

  const paymentNotes = (accountingMethod === 'cash' && !isFullyPaid)
    ? 'Kontantmetoden: intäkt bokförs vid slutbetalning' : null

  await supabase.from('invoice_payments').insert({
    user_id: userId,
    company_id: companyId,
    invoice_id: invoiceId,
    payment_date: transaction.date,
    amount: paidAmount,
    currency: invoice.currency,
    exchange_rate: invoice.exchange_rate,
    journal_entry_id: journalEntryId,
    transaction_id: transactionId,
    notes: paymentNotes,
  })

  await supabase
    .from('transactions')
    .update({
      invoice_id: invoiceId,
      potential_invoice_id: null,
      journal_entry_id: journalEntryId,
      is_business: true,
      category: 'income_services',
    })
    .eq('id', transactionId)

  try {
    await eventBus.emit({
      type: 'invoice.match_confirmed',
      payload: { invoice: invoice as Invoice, transaction: transaction as Transaction, userId, companyId },
    })
  } catch { /* non-critical */ }

  return { data: { invoice_status: newStatus, paid_amount: newPaidAmount, journal_entry_id: journalEntryId } }
}

// ── Route handler ─────────────────────────────────────────────

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { id } = await params

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  // Fetch the pending operation
  const { data: op, error: fetchError } = await supabase
    .from('pending_operations')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !op) {
    return NextResponse.json({ error: 'Pending operation not found' }, { status: 404 })
  }

  const pendingOp = op as PendingOperation

  if (pendingOp.status !== 'pending') {
    return NextResponse.json(
      { error: `Operation already ${pendingOp.status}` },
      { status: 409 }
    )
  }

  // Execute based on operation type
  let result: { data?: Record<string, unknown>; error?: string; status?: number }

  try {
    switch (pendingOp.operation_type) {
      case 'categorize_transaction':
        result = await commitCategorizeTransaction(supabase, user.id, companyId, pendingOp.params)
        break
      case 'create_customer':
        result = await commitCreateCustomer(supabase, user.id, companyId, pendingOp.params)
        break
      case 'create_invoice':
        result = await commitCreateInvoice(supabase, user.id, companyId, pendingOp.params)
        break
      case 'mark_invoice_paid':
        result = await commitMarkInvoicePaid(supabase, user.id, companyId, pendingOp.params)
        break
      case 'send_invoice':
        result = await commitSendInvoice(supabase, user.id, companyId, pendingOp.params, user.email)
        break
      case 'mark_invoice_sent':
        result = await commitMarkInvoiceSent(supabase, user.id, companyId, pendingOp.params)
        break
      case 'match_transaction_invoice':
        result = await commitMatchTransactionInvoice(supabase, user.id, companyId, pendingOp.params)
        break
      default:
        return NextResponse.json({ error: 'Unknown operation type' }, { status: 400 })
    }
  } catch (err) {
    const typed = bookkeepingErrorResponse(err)
    if (typed) return typed
    throw err
  }

  if (result.error) {
    // Auto-reject if the operation can never succeed (404, 409)
    if (result.status === 404 || result.status === 409) {
      await supabase
        .from('pending_operations')
        .update({
          status: 'rejected',
          resolved_at: new Date().toISOString(),
          result_data: { auto_rejected: true, reason: result.error },
        })
        .eq('id', id)
    }

    return NextResponse.json({ error: result.error }, { status: result.status || 500 })
  }

  // Mark as committed
  await supabase
    .from('pending_operations')
    .update({
      status: 'committed',
      resolved_at: new Date().toISOString(),
      result_data: result.data || {},
    })
    .eq('id', id)

  return NextResponse.json({ data: result.data })
}
