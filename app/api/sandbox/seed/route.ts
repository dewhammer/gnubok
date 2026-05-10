import crypto from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { getActiveCompanyId } from '@/lib/company/context'
import { createLogger } from '@/lib/logger'

/**
 * POST /api/sandbox/seed
 * Seeds demo data for an anonymous sandbox user.
 * Only callable by anonymous users (is_anonymous === true).
 *
 * Defense-in-depth: also requires SANDBOX_ENABLED=true. The anonymous-user
 * check is the primary control; the env guard exists so that if anonymous
 * sign-in is ever turned on accidentally in a production environment, this
 * destructive seed endpoint stays inert until an operator explicitly opts in.
 */
export async function POST() {
  // Per-request logger so seed-failure entries are correlatable in the SIEM.
  // Cannot reuse withRouteContext here — it requires an active company, but
  // the sandbox seed runs *before* a company exists for the user.
  const requestId = `req_${crypto.randomUUID()}`
  const log = createLogger('sandbox:seed', { requestId })

  if (process.env.SANDBOX_ENABLED !== 'true') {
    return NextResponse.json(
      { error: 'Sandbox is not enabled in this environment', requestId },
      { status: 403 },
    )
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized', requestId }, { status: 401 })
  }

  if (!user.is_anonymous) {
    return NextResponse.json(
      { error: 'Sandbox is only available for anonymous users', requestId },
      { status: 403 },
    )
  }

  // Anonymous users start with no company. Create one before seeding.
  // If a previous seed attempt already created a company for this user, reuse it
  // (idempotency).
  let companyId = await getActiveCompanyId(supabase, user.id)

  if (!companyId) {
    const { data: newCompanyId, error: companyError } = await supabase.rpc(
      'create_company_with_owner',
      {
        p_name: 'Sandlådan Konsult',
        p_entity_type: 'enskild_firma',
      }
    )

    if (companyError || !newCompanyId) {
      log.error('failed to create sandbox company', { error: companyError, userId: user.id })
      return NextResponse.json(
        { error: 'Failed to create sandbox company', requestId },
        { status: 500 }
      )
    }

    companyId = newCompanyId as string
  }

  // Idempotency: if already seeded, return early
  const { data: existing } = await supabase
    .from('company_settings')
    .select('id')
    .eq('company_id', companyId)
    .maybeSingle()

  if (existing) {
    return NextResponse.json({ seeded: false })
  }

  try {
    const userId = user.id

    // 1. Update profile (auto-created by auth trigger)
    await supabase
      .from('profiles')
      .update({ full_name: 'Demo Användare' })
      .eq('id', userId)

    // 2. Create company settings
    const { error: settingsError } = await supabase
      .from('company_settings')
      .insert({
        user_id: userId,
        company_id: companyId,
        entity_type: 'enskild_firma',
        company_name: 'Sandlådan Konsult',
        org_number: '199001011234',
        address_line1: 'Demovägen 1',
        postal_code: '111 22',
        city: 'Stockholm',
        country: 'SE',
        f_skatt: true,
        vat_registered: true,
        vat_number: 'SE199001011234',
        moms_period: 'quarterly',
        fiscal_year_start_month: 1,
        accounting_method: 'accrual',
        invoice_prefix: 'F',
        next_invoice_number: 5,
        next_delivery_note_number: 1,
        invoice_default_days: 30,
        onboarding_step: 6,
        onboarding_complete: true,
        is_sandbox: true,
      })

    if (settingsError) throw settingsError

    // 3. Seed chart of accounts via RPC
    const { error: coaError } = await supabase.rpc('seed_chart_of_accounts', {
      p_company_id: companyId,
      p_entity_type: 'enskild_firma',
    })
    if (coaError) throw coaError

    // 4. Create fiscal period (current year)
    const currentYear = new Date().getFullYear()
    const { data: fiscalPeriod, error: fpError } = await supabase
      .from('fiscal_periods')
      .insert({
        user_id: userId,
        company_id: companyId,
        name: `Räkenskapsår ${currentYear}`,
        period_start: `${currentYear}-01-01`,
        period_end: `${currentYear}-12-31`,
      })
      .select('id')
      .single()

    if (fpError) throw fpError

    // 5. Create customers
    const { data: customers, error: custError } = await supabase
      .from('customers')
      .insert([
        {
          user_id: userId,
          company_id: companyId,
          name: 'Björk & Partner AB',
          customer_type: 'swedish_business',
          email: 'faktura@bjorkpartner.se',
          org_number: '5566778899',
          vat_number: 'SE556677889901',
          vat_number_validated: true,
          address_line1: 'Storgatan 10',
          postal_code: '111 44',
          city: 'Stockholm',
          country: 'SE',
          default_payment_terms: 30,
        },
        {
          user_id: userId,
          company_id: companyId,
          name: 'Schmidt GmbH',
          customer_type: 'eu_business',
          email: 'billing@schmidt.de',
          org_number: 'HRB 12345',
          vat_number: 'DE123456789',
          vat_number_validated: true,
          address_line1: 'Hauptstraße 5',
          postal_code: '10115',
          city: 'Berlin',
          country: 'DE',
          default_payment_terms: 30,
        },
        {
          user_id: userId,
          company_id: companyId,
          name: 'Anna Lindström',
          customer_type: 'individual',
          email: 'anna.lindstrom@example.com',
          address_line1: 'Lillgatan 3',
          postal_code: '222 33',
          city: 'Malmö',
          country: 'SE',
          default_payment_terms: 30,
        },
      ])
      .select('id, name')

    if (custError) throw custError

    const customerMap = Object.fromEntries(customers.map(c => [c.name, c.id]))

    // 6. Create invoices
    const today = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const toDateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

    const thirtyDaysAgo = new Date(today)
    thirtyDaysAgo.setDate(today.getDate() - 30)
    const fifteenDaysAgo = new Date(today)
    fifteenDaysAgo.setDate(today.getDate() - 15)
    const thirtyDaysFromNow = new Date(today)
    thirtyDaysFromNow.setDate(today.getDate() + 30)
    const fiveDaysAgo = new Date(today)
    fiveDaysAgo.setDate(today.getDate() - 5)

    const { data: invoices, error: invError } = await supabase
      .from('invoices')
      .insert([
        {
          user_id: userId,
          company_id: companyId,
          customer_id: customerMap['Björk & Partner AB'],
          invoice_number: 'F-2026001',
          invoice_date: toDateStr(thirtyDaysAgo),
          due_date: toDateStr(today),
          status: 'paid',
          subtotal: 15000,
          vat_amount: 3750,
          total: 18750,
          vat_treatment: 'standard_25',
          vat_rate: 25,
          moms_ruta: '10',
          document_type: 'invoice',
          paid_at: toDateStr(fifteenDaysAgo),
          paid_amount: 18750,
        },
        {
          user_id: userId,
          company_id: companyId,
          customer_id: customerMap['Schmidt GmbH'],
          invoice_number: 'F-2026002',
          invoice_date: toDateStr(fifteenDaysAgo),
          due_date: toDateStr(thirtyDaysFromNow),
          status: 'sent',
          subtotal: 20000,
          vat_amount: 0,
          total: 20000,
          vat_treatment: 'reverse_charge',
          vat_rate: 0,
          reverse_charge_text: 'Reverse charge — buyer is liable for VAT',
          document_type: 'invoice',
        },
        {
          user_id: userId,
          company_id: companyId,
          customer_id: customerMap['Anna Lindström'],
          invoice_number: 'F-2026003',
          invoice_date: toDateStr(thirtyDaysAgo),
          due_date: toDateStr(fiveDaysAgo),
          status: 'overdue',
          subtotal: 5000,
          vat_amount: 1250,
          total: 6250,
          vat_treatment: 'standard_25',
          vat_rate: 25,
          moms_ruta: '10',
          document_type: 'invoice',
        },
        {
          user_id: userId,
          company_id: companyId,
          customer_id: customerMap['Björk & Partner AB'],
          invoice_number: 'F-2026004',
          invoice_date: toDateStr(today),
          due_date: toDateStr(thirtyDaysFromNow),
          status: 'draft',
          subtotal: 8000,
          vat_amount: 2000,
          total: 10000,
          vat_treatment: 'standard_25',
          vat_rate: 25,
          moms_ruta: '10',
          document_type: 'invoice',
        },
      ])
      .select('id, invoice_number')

    if (invError) throw invError

    const invoiceMap = Object.fromEntries(invoices.map(i => [i.invoice_number, i.id]))

    // 7. Create invoice items
    const { error: itemsError } = await supabase
      .from('invoice_items')
      .insert([
        {
          invoice_id: invoiceMap['F-2026001'],
          description: 'Webbutveckling — mars 2026',
          quantity: 30,
          unit: 'tim',
          unit_price: 500,
          line_total: 15000,
          vat_rate: 25,
        },
        {
          invoice_id: invoiceMap['F-2026002'],
          description: 'IT-konsulting — internationellt projekt',
          quantity: 40,
          unit: 'tim',
          unit_price: 500,
          line_total: 20000,
          vat_rate: 0,
        },
        {
          invoice_id: invoiceMap['F-2026003'],
          description: 'Hemsida & grafisk profil',
          quantity: 1,
          unit: 'st',
          unit_price: 5000,
          line_total: 5000,
          vat_rate: 25,
        },
        {
          invoice_id: invoiceMap['F-2026004'],
          description: 'Systemunderhåll april 2026',
          quantity: 16,
          unit: 'tim',
          unit_price: 500,
          line_total: 8000,
          vat_rate: 25,
        },
      ])

    if (itemsError) throw itemsError

    // 8. Resolve account IDs for journal entries
    const { data: accounts } = await supabase
      .from('chart_of_accounts')
      .select('id, account_number')
      .eq('company_id', companyId)
      .in('account_number', ['1510', '1930', '2611', '3001'])

    const accountMap = Object.fromEntries(
      (accounts ?? []).map(a => [a.account_number, a.id])
    )

    // 9. Create journal entries (inserted directly, not via engine, to avoid event emission)
    const { data: voucherNum1 } = await supabase.rpc('next_voucher_number', {
      p_company_id: companyId,
      p_fiscal_period_id: fiscalPeriod.id,
      p_series: 'A',
    })

    const { data: je1, error: je1Error } = await supabase
      .from('journal_entries')
      .insert({
        user_id: userId,
        company_id: companyId,
        fiscal_period_id: fiscalPeriod.id,
        voucher_number: voucherNum1 ?? 1,
        voucher_series: 'A',
        entry_date: toDateStr(thirtyDaysAgo),
        description: 'Faktura F-2026001 — Björk & Partner AB',
        source_type: 'invoice_created',
        source_id: invoiceMap['F-2026001'],
        status: 'posted',
        committed_at: toDateStr(thirtyDaysAgo),
      })
      .select('id')
      .single()

    if (je1Error) throw je1Error

    const { data: voucherNum2 } = await supabase.rpc('next_voucher_number', {
      p_company_id: companyId,
      p_fiscal_period_id: fiscalPeriod.id,
      p_series: 'A',
    })

    const { data: je2, error: je2Error } = await supabase
      .from('journal_entries')
      .insert({
        user_id: userId,
        company_id: companyId,
        fiscal_period_id: fiscalPeriod.id,
        voucher_number: voucherNum2 ?? 2,
        voucher_series: 'A',
        entry_date: toDateStr(fifteenDaysAgo),
        description: 'Betalning faktura F-2026001 — Björk & Partner AB',
        source_type: 'invoice_paid',
        source_id: invoiceMap['F-2026001'],
        status: 'posted',
        committed_at: toDateStr(fifteenDaysAgo),
      })
      .select('id')
      .single()

    if (je2Error) throw je2Error

    // 10. Create journal entry lines
    const { error: jelError } = await supabase
      .from('journal_entry_lines')
      .insert([
        // JE1: Invoice creation — Debit AR, Credit Revenue + VAT
        {
          journal_entry_id: je1.id,
          account_number: '1510',
          account_id: accountMap['1510'] ?? null,
          debit_amount: 18750,
          credit_amount: 0,
          sort_order: 0,
        },
        {
          journal_entry_id: je1.id,
          account_number: '3001',
          account_id: accountMap['3001'] ?? null,
          debit_amount: 0,
          credit_amount: 15000,
          sort_order: 1,
        },
        {
          journal_entry_id: je1.id,
          account_number: '2611',
          account_id: accountMap['2611'] ?? null,
          debit_amount: 0,
          credit_amount: 3750,
          sort_order: 2,
        },
        // JE2: Invoice payment — Debit Bank, Credit AR
        {
          journal_entry_id: je2.id,
          account_number: '1930',
          account_id: accountMap['1930'] ?? null,
          debit_amount: 18750,
          credit_amount: 0,
          sort_order: 0,
        },
        {
          journal_entry_id: je2.id,
          account_number: '1510',
          account_id: accountMap['1510'] ?? null,
          debit_amount: 0,
          credit_amount: 18750,
          sort_order: 1,
        },
      ])

    if (jelError) throw jelError

    // 11. Create transactions
    const { error: txError } = await supabase
      .from('transactions')
      .insert([
        // Categorized expenses
        {
          user_id: userId,
          company_id: companyId,
          date: toDateStr(thirtyDaysAgo),
          description: 'CLAS OHLSON STOCKHOLM',
          amount: -450,
          category: 'expense_office',
          is_business: true,
          merchant_name: 'Clas Ohlson',
        },
        {
          user_id: userId,
          company_id: companyId,
          date: toDateStr(fifteenDaysAgo),
          description: 'GITHUB INC',
          amount: -999,
          category: 'expense_software',
          is_business: true,
          merchant_name: 'GitHub',
        },
        {
          user_id: userId,
          company_id: companyId,
          date: toDateStr(fiveDaysAgo),
          description: 'SJ BILJETT',
          amount: -2500,
          category: 'expense_travel',
          is_business: true,
          merchant_name: 'SJ',
        },
        // Income matched to paid invoice
        {
          user_id: userId,
          company_id: companyId,
          date: toDateStr(fifteenDaysAgo),
          description: 'BJÖRK & PARTNER AB BETALNING F-2026001',
          amount: 18750,
          category: 'income_services',
          is_business: true,
          invoice_id: invoiceMap['F-2026001'],
          journal_entry_id: je2.id,
          merchant_name: 'Björk & Partner AB',
        },
        // Private transaction
        {
          user_id: userId,
          company_id: companyId,
          date: toDateStr(fiveDaysAgo),
          description: 'PRIVAT INSÄTTNING',
          amount: 5000,
          category: 'private',
          is_business: false,
        },
        // Uncategorized transactions
        {
          user_id: userId,
          company_id: companyId,
          date: toDateStr(fiveDaysAgo),
          description: 'SWISH BETALNING 0701234567',
          amount: -350,
          category: 'uncategorized',
          is_business: null,
        },
        {
          user_id: userId,
          company_id: companyId,
          date: toDateStr(today),
          description: 'INSÄTTNING BANKGIRO',
          amount: 1200,
          category: 'uncategorized',
          is_business: null,
        },
        {
          user_id: userId,
          company_id: companyId,
          date: toDateStr(today),
          description: 'KORTBETALNING RESTAURANG',
          amount: -680,
          category: 'uncategorized',
          is_business: null,
        },
      ])

    if (txError) throw txError

    // 12. Create deadlines
    const momsDeadline = new Date(today)
    momsDeadline.setMonth(momsDeadline.getMonth() + 2)
    momsDeadline.setDate(12)

    const { error: dlError } = await supabase
      .from('deadlines')
      .insert([
        {
          user_id: userId,
          company_id: companyId,
          title: 'Momsdeklaration Q1 2026',
          due_date: toDateStr(momsDeadline),
          deadline_type: 'tax',
          priority: 'important',
          tax_deadline_type: 'moms',
          tax_period: `${currentYear}-Q1`,
          source: 'system',
          status: 'upcoming',
          linked_report_type: 'vat',
        },
        {
          user_id: userId,
          company_id: companyId,
          title: 'Inkomstdeklaration 2025',
          due_date: `${currentYear}-05-02`,
          deadline_type: 'tax',
          priority: 'critical',
          tax_deadline_type: 'inkomstdeklaration',
          tax_period: `${currentYear - 1}`,
          source: 'system',
          status: 'upcoming',
        },
      ])

    if (dlError) throw dlError

    return NextResponse.json({ seeded: true })
  } catch (err) {
    log.error('failed to seed sandbox data', { error: err, userId: user.id, companyId })
    return NextResponse.json(
      { error: 'Failed to seed sandbox data', requestId },
      { status: 500 }
    )
  }
}
