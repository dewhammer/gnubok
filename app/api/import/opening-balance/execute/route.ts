import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { OpeningBalanceExecuteSchema } from '@/lib/api/schemas'
import { requireWritePermission } from '@/lib/auth/require-write'
import { requireCompanyId } from '@/lib/company/context'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { CreateJournalEntryLineInput } from '@/types'

ensureInitialized()

/**
 * POST /api/import/opening-balance/execute
 *
 * Creates an opening balance journal entry from user-confirmed lines.
 * Auto-activates BAS accounts not yet in the company's chart.
 */
export async function POST(request: Request) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const result = await validateBody(request, OpeningBalanceExecuteSchema)
  if (!result.success) return result.response

  const { fiscal_period_id, lines } = result.data

  let companyId: string
  try {
    companyId = await requireCompanyId(supabase, user.id)
  } catch {
    return NextResponse.json({ error: 'Inget aktivt företag' }, { status: 400 })
  }

  try {
    // 1. Verify fiscal period exists, belongs to company, and is not closed/locked
    const { data: period, error: periodError } = await supabase
      .from('fiscal_periods')
      .select('*')
      .eq('id', fiscal_period_id)
      .eq('company_id', companyId)
      .single()

    if (periodError || !period) {
      return NextResponse.json(
        { error: 'Räkenskapsperioden hittades inte' },
        { status: 404 },
      )
    }

    if (period.is_closed) {
      return NextResponse.json(
        { error: 'Räkenskapsperioden är stängd' },
        { status: 400 },
      )
    }

    if (period.locked_at) {
      return NextResponse.json(
        { error: 'Räkenskapsperioden är låst' },
        { status: 400 },
      )
    }

    // 2. Check if period already has opening balances
    if (period.opening_balances_set) {
      return NextResponse.json(
        {
          error: 'Räkenskapsperioden har redan ingående balanser',
          existing_entry_id: period.opening_balance_entry_id,
        },
        { status: 409 },
      )
    }

    // 3. Filter out zero-amount lines and validate no P&L accounts
    const validLines = lines.filter((l) => l.debit_amount > 0 || l.credit_amount > 0)

    if (validLines.length < 2) {
      return NextResponse.json(
        { error: 'Minst två rader med belopp krävs' },
        { status: 400 },
      )
    }

    // Reject class 3-8 accounts
    const pnlAccounts = validLines
      .map((l) => l.account_number)
      .filter((num) => {
        const cls = parseInt(num.charAt(0), 10)
        return cls >= 3 && cls <= 8
      })

    if (pnlAccounts.length > 0) {
      return NextResponse.json(
        {
          error: `Resultatkonton (klass 3-8) kan inte användas i ingående balanser: ${pnlAccounts.slice(0, 5).join(', ')}`,
        },
        { status: 400 },
      )
    }

    // 4. Verify balance
    let totalDebit = 0
    let totalCredit = 0
    for (const line of validLines) {
      totalDebit = Math.round((totalDebit + line.debit_amount) * 100) / 100
      totalCredit = Math.round((totalCredit + line.credit_amount) * 100) / 100
    }

    const diff = Math.round((totalDebit - totalCredit) * 100) / 100
    if (Math.abs(diff) >= 0.01) {
      return NextResponse.json(
        { error: `Debet och kredit balanserar inte — differens: ${diff.toFixed(2)} SEK` },
        { status: 400 },
      )
    }

    // 5. Auto-activate BAS accounts not in company's chart
    const accountNumbers = [...new Set(validLines.map((l) => l.account_number))]

    const existingAccounts = await fetchAllRows(({ from, to }) =>
      supabase
        .from('chart_of_accounts')
        .select('account_number')
        .eq('company_id', companyId)
        .range(from, to),
    )

    const existingNumbers = new Set(existingAccounts.map((a) => a.account_number))
    const accountsToActivate = accountNumbers
      .filter((num) => !existingNumbers.has(num))
      .map((num) => {
        const ref = getBASReference(num)

        if (ref) {
          return {
            user_id: user.id,
            company_id: companyId,
            account_number: ref.account_number,
            account_name: ref.account_name,
            account_class: ref.account_class,
            account_group: ref.account_group,
            account_type: ref.account_type,
            normal_balance: ref.normal_balance,
            plan_type: 'full_bas' as const,
            is_active: true,
            is_system_account: false,
            description: ref.description,
            sru_code: ref.sru_code,
            sort_order: parseInt(ref.account_number),
          }
        }

        // Derive metadata from account number
        const accountClass = parseInt(num.charAt(0), 10)
        const accountGroup = num.substring(0, 2)
        const accountType =
          accountClass === 1 ? 'asset'
            : accountClass === 2 ? 'liability'
              : accountClass === 3 ? 'revenue'
                : 'expense'
        const normalBalance = accountClass <= 1 || accountClass >= 4 ? 'debit' : 'credit'

        return {
          user_id: user.id,
          company_id: companyId,
          account_number: num,
          account_name: `Konto ${num}`,
          account_class: accountClass,
          account_group: accountGroup,
          account_type: accountType,
          normal_balance: normalBalance,
          plan_type: 'full_bas' as const,
          is_active: true,
          is_system_account: false,
          description: `Konto ${num}`,
          sru_code: null,
          sort_order: parseInt(num),
        }
      })

    if (accountsToActivate.length > 0) {
      const { error: activateError } = await supabase
        .from('chart_of_accounts')
        .insert(accountsToActivate)

      if (activateError) {
        console.error('Failed to activate accounts:', activateError)
        return NextResponse.json(
          { error: 'Kunde inte aktivera konton i kontoplanen' },
          { status: 500 },
        )
      }
    }

    // 6. Create journal entry via engine
    const entryLines: CreateJournalEntryLineInput[] = validLines.map((line) => ({
      account_number: line.account_number,
      debit_amount: line.debit_amount,
      credit_amount: line.credit_amount,
      line_description: `IB ${line.account_number}`,
    }))

    const entry = await createJournalEntry(supabase, companyId, user.id, {
      fiscal_period_id,
      entry_date: period.period_start,
      description: 'Ingående balanser (Excel-import)',
      source_type: 'opening_balance',
      voucher_series: 'A',
      lines: entryLines,
    })

    // 7. Update fiscal period
    await supabase
      .from('fiscal_periods')
      .update({
        opening_balance_entry_id: entry.id,
        opening_balances_set: true,
      })
      .eq('id', fiscal_period_id)
      .eq('company_id', companyId)

    return NextResponse.json({
      data: {
        success: true,
        journal_entry_id: entry.id,
        fiscal_period_id,
        lines_created: entryLines.length,
        total_debit: totalDebit,
        total_credit: totalCredit,
      },
    })
  } catch (error) {
    const typed = bookkeepingErrorResponse(error)
    if (typed) return typed
    console.error('Opening balance execute error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Importen misslyckades' },
      { status: 500 },
    )
  }
}
