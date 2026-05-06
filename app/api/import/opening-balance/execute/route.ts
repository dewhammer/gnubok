import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { OpeningBalanceExecuteSchema } from '@/lib/api/schemas'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { CreateJournalEntryLineInput } from '@/types'

ensureInitialized()

/**
 * POST /api/import/opening-balance/execute
 *
 * Creates an opening balance journal entry from user-confirmed lines and
 * auto-activates BAS accounts not yet in the company's chart.
 */
export const POST = withRouteContext(
  'opening_balance.execute',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const result = await validateBody(request, OpeningBalanceExecuteSchema, {
      log,
      operation: 'opening_balance.execute',
    })
    if (!result.success) return result.response

    const { fiscal_period_id, lines } = result.data
    const opLog = log.child({ fiscalPeriodId: fiscal_period_id })

    try {
      // 1. Verify fiscal period belongs to the company and is open.
      const { data: period, error: periodError } = await supabase
        .from('fiscal_periods')
        .select('*')
        .eq('id', fiscal_period_id)
        .eq('company_id', companyId)
        .single()

      if (periodError || !period) {
        return errorResponseFromCode('OB_PERIOD_NOT_FOUND', opLog, { requestId })
      }

      if (period.is_closed) {
        return errorResponseFromCode('OB_PERIOD_CLOSED', opLog, { requestId })
      }

      if (period.locked_at) {
        return errorResponseFromCode('OB_PERIOD_LOCKED', opLog, { requestId })
      }

      if (period.opening_balances_set) {
        return errorResponseFromCode('OB_PERIOD_ALREADY_HAS_BALANCES', opLog, {
          requestId,
          details: { existingEntryId: period.opening_balance_entry_id },
        })
      }

      // 2. Filter zero-amount lines and reject P&L accounts.
      const validLines = lines.filter((l) => l.debit_amount > 0 || l.credit_amount > 0)

      if (validLines.length < 2) {
        return errorResponseFromCode('OB_TOO_FEW_LINES', opLog, { requestId })
      }

      const pnlAccounts = validLines
        .map((l) => l.account_number)
        .filter((num) => {
          const cls = parseInt(num.charAt(0), 10)
          return cls >= 3 && cls <= 8
        })

      if (pnlAccounts.length > 0) {
        return errorResponseFromCode('OB_PNL_ACCOUNT', opLog, {
          requestId,
          details: { accounts: pnlAccounts.slice(0, 5) },
        })
      }

      // 3. Verify balance.
      let totalDebit = 0
      let totalCredit = 0
      for (const line of validLines) {
        totalDebit = Math.round((totalDebit + line.debit_amount) * 100) / 100
        totalCredit = Math.round((totalCredit + line.credit_amount) * 100) / 100
      }

      const diff = Math.round((totalDebit - totalCredit) * 100) / 100
      if (Math.abs(diff) >= 0.01) {
        return errorResponseFromCode('OB_UNBALANCED', opLog, {
          requestId,
          details: { totalDebit, totalCredit, diff },
        })
      }

      // 4. Auto-activate BAS accounts not in the company's chart.
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
          opLog.error('opening balance account activation failed', activateError)
          return errorResponseFromCode('OB_ACCOUNT_ACTIVATION_FAILED', opLog, {
            requestId,
            details: { reason: activateError.message },
          })
        }
      }

      // 5. Create the opening balance journal entry.
      const entryLines: CreateJournalEntryLineInput[] = validLines.map((line) => ({
        account_number: line.account_number,
        debit_amount: line.debit_amount,
        credit_amount: line.credit_amount,
        line_description: `IB ${line.account_number}`,
      }))

      const entry = await createJournalEntry(supabase, companyId!, user.id, {
        fiscal_period_id,
        entry_date: period.period_start,
        description: 'Ingående balanser (Excel-import)',
        source_type: 'opening_balance',
        voucher_series: 'A',
        lines: entryLines,
      })

      // 6. Mark the fiscal period.
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
    } catch (err) {
      // Bookkeeping errors flow through the standard envelope; everything else
      // becomes OB_EXECUTE_FAILED so the user gets a Swedish toast.
      if (isBookkeepingError(err)) {
        return errorResponse(err, opLog, { requestId })
      }
      opLog.error('opening balance execute failed', err as Error)
      return errorResponseFromCode('OB_EXECUTE_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
  },
  { requireWrite: true },
)
