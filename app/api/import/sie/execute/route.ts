import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { NextResponse } from 'next/server'
import { parseSIEFile, detectEncoding, decodeBuffer } from '@/lib/import/sie-parser'
import { suggestMappings } from '@/lib/import/account-mapper'
import { executeSIEImport, checkDuplicateImport } from '@/lib/import/sie-import'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { AccountMapping, SIEAccountMappingRecord } from '@/lib/import/types'

// SIE imports with many vouchers need extended execution time
export const maxDuration = 300

/** POST /api/import/sie/execute — execute the SIE import. */
export const POST = withRouteContext(
  'sie_import.execute',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const mappingsJson = formData.get('mappings') as string | null
    const optionsJson = formData.get('options') as string | null

    if (!file) {
      return errorResponseFromCode('SIE_PARSE_NO_FILE', log, { requestId })
    }

    const opLog = log.child({ filename: file.name, sizeBytes: file.size })

    try {
      // The voucherSeries option is a fallback for vouchers that arrive without
      // a series (SIE4I subsystem files); the import engine preserves each
      // #VER's source series per voucher.
      const parsedOptions = optionsJson ? JSON.parse(optionsJson) : null
      const { data: companySettings } = await supabase
        .from('company_settings')
        .select('default_voucher_series')
        .eq('company_id', companyId)
        .maybeSingle()
      const companyDefaultSeries = companySettings?.default_voucher_series || 'B'

      const options = parsedOptions ?? {
        createFiscalPeriod: true,
        importOpeningBalances: true,
        importTransactions: true,
        voucherSeries: companyDefaultSeries,
      }

      const arrayBuffer = await file.arrayBuffer()
      const encoding = detectEncoding(arrayBuffer)
      const content = decodeBuffer(arrayBuffer, encoding)

      const parsed = parseSIEFile(content)

      const duplicate = await checkDuplicateImport(supabase, companyId!, content)
      if (duplicate) {
        return errorResponseFromCode('SIE_DUPLICATE_FILE', opLog, {
          requestId,
          details: { importId: duplicate.id, importedAt: duplicate.imported_at },
        })
      }

      let mappings: AccountMapping[]

      if (mappingsJson) {
        mappings = JSON.parse(mappingsJson)
      } else {
        const { data: storedMappings } = await supabase
          .from('sie_account_mappings')
          .select('*')
          .eq('company_id', companyId)

        mappings = suggestMappings(
          parsed.accounts,
          BAS_REFERENCE,
          (storedMappings as SIEAccountMappingRecord[]) || undefined,
        )
      }

      const unmapped = mappings.filter((m) => !m.targetAccount)
      if (unmapped.length > 0) {
        return errorResponseFromCode('SIE_IMPORT_UNMAPPED_ACCOUNTS', opLog, {
          requestId,
          details: {
            unmappedCount: unmapped.length,
            unmappedAccounts: unmapped.slice(0, 5).map((m) => ({
              account: m.sourceAccount,
              name: m.sourceName,
            })),
          },
        })
      }

      const mappedAccountNumbers = [
        ...new Set(mappings.filter((m) => m.targetAccount).map((m) => m.targetAccount)),
      ]

      const allCompanyAccounts = await fetchAllRows(({ from, to }) =>
        supabase
          .from('chart_of_accounts')
          .select('account_number')
          .eq('company_id', companyId)
          .range(from, to),
      )
      const mappedSet = new Set(mappedAccountNumbers)
      const existingAccounts = allCompanyAccounts.filter((a) => mappedSet.has(a.account_number))

      const mappingNameLookup = new Map<string, string>()
      for (const m of mappings) {
        if (m.targetAccount) {
          mappingNameLookup.set(m.targetAccount, m.targetName || m.sourceName)
        }
      }

      const existingNumbers = new Set(existingAccounts.map((a) => a.account_number))
      const accountsToActivate = mappedAccountNumbers
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

          // Sub-account not in BAS reference (e.g. 1241 Personbilar). Derive
          // metadata from the account number.
          const accountClass = parseInt(num.charAt(0), 10)
          const accountGroup = num.substring(0, 2)
          const accountName = mappingNameLookup.get(num) || `Konto ${num}`
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
            account_name: accountName,
            account_class: accountClass,
            account_group: accountGroup,
            account_type: accountType,
            normal_balance: normalBalance,
            plan_type: 'full_bas' as const,
            is_active: true,
            is_system_account: false,
            description: accountName,
            sru_code: null,
            sort_order: parseInt(num),
          }
        })

      if (accountsToActivate.length > 0) {
        const { error: activateError } = await supabase
          .from('chart_of_accounts')
          .insert(accountsToActivate)

        if (activateError) {
          opLog.error('sie account activation failed', activateError)
          return errorResponseFromCode('SIE_IMPORT_ACCOUNT_ACTIVATION_FAILED', opLog, {
            requestId,
            details: { reason: activateError.message },
          })
        }
      }

      const result = await executeSIEImport(
        supabase,
        companyId!,
        user.id,
        parsed,
        mappings,
        {
          filename: file.name,
          fileContent: content,
          createFiscalPeriod: options.createFiscalPeriod,
          importOpeningBalances: options.importOpeningBalances,
          importTransactions: options.importTransactions,
          voucherSeries: options.voucherSeries || companyDefaultSeries,
        },
      )

      if (!result.success) {
        return errorResponseFromCode('SIE_IMPORT_FAILED', opLog, {
          requestId,
          details: { result },
        })
      }

      return NextResponse.json({ success: true, result })
    } catch (err) {
      opLog.error('sie execute unexpected error', err as Error)
      return errorResponseFromCode('SIE_IMPORT_UNEXPECTED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
  },
  { requireWrite: true },
)
