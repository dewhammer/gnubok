import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { renderToBuffer } from '@react-pdf/renderer'
import { PayslipPDF } from '@/lib/salary/pdf/payslip-template'
import type { PayslipData, PayslipLineItem } from '@/lib/salary/pdf/payslip-template'
import { decryptPersonnummer, maskPersonnummer } from '@/lib/salary/personnummer'

ensureInitialized()

/**
 * Generate pay slip PDF for a specific employee in a salary run.
 *
 * Per BFL: Pay slips are räkenskapsinformation/underlag linked to
 * posted journal entries. Subject to 7-year retention per BFL 7 kap.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; employeeId: string }> }
) {
  const { id, employeeId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)

  // Load salary run
  const { data: run } = await supabase
    .from('salary_runs')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (!run) {
    return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
  }

  // Load salary run employee
  const { data: sre } = await supabase
    .from('salary_run_employees')
    .select('*, employee:employees(first_name, last_name, personnummer, personnummer_last4, employment_type, tax_table_number, tax_column, clearing_number, bank_account_number), line_items:salary_line_items(*)')
    .eq('salary_run_id', id)
    .eq('employee_id', employeeId)
    .single()

  if (!sre) {
    return NextResponse.json({ error: 'Anställd hittades inte i lönekörningen' }, { status: 404 })
  }

  // Load company
  const { data: company } = await supabase
    .from('companies')
    .select('name, org_number')
    .eq('id', companyId)
    .single()

  if (!company) {
    return NextResponse.json({ error: 'Företag hittades inte' }, { status: 404 })
  }

  const emp = sre.employee as {
    first_name: string; last_name: string; personnummer: string; personnummer_last4: string;
    employment_type: string; tax_table_number: number | null; tax_column: number;
    clearing_number: string | null; bank_account_number: string | null;
  }

  const EMPLOYMENT_LABELS: Record<string, string> = {
    employee: 'Anställd',
    company_owner: 'Företagsledare',
    board_member: 'Styrelseledamot',
  }

  // Build line items for PDF
  const lineItems: PayslipLineItem[] = ((sre.line_items || []) as Array<Record<string, unknown>>)
    .sort((a, b) => ((a.sort_order as number) || 0) - ((b.sort_order as number) || 0))
    .map(li => ({
      description: li.description as string,
      quantity: li.quantity as number | undefined,
      unitPrice: li.unit_price as number | undefined,
      amount: li.amount as number,
    }))

  // Build tax reference string
  let taxReference = 'Schablon 30%'
  if (emp.tax_table_number) {
    taxReference = `Tabell ${emp.tax_table_number}, kol ${emp.tax_column}`
  }

  // Build breakdown steps from calculation_breakdown, then append rows for
  // any manual overrides so the breakdown matches the displayed totals.
  // The engine-computed rows stay for transparency ("this is what was
  // computed"), and override rows below them show the manual adjustment and
  // its reason ("this is what was actually applied").
  const breakdown = sre.calculation_breakdown as { steps?: Array<{ label: string; formula: string; output: number }> } | null
  const baseSteps = breakdown?.steps ?? []
  const overrideSteps: Array<{ label: string; formula: string; output: number }> = []
  const reason = (sre.override_reason as string | null) || 'manuell justering'
  if (sre.tax_withheld_override !== null && sre.tax_withheld_override !== undefined) {
    overrideSteps.push({
      label: 'Manuell justering: Skatteavdrag',
      formula: reason,
      output: Number(sre.tax_withheld_override),
    })
  }
  if (sre.avgifter_basis_override !== null && sre.avgifter_basis_override !== undefined) {
    overrideSteps.push({
      label: 'Manuell justering: Avgiftsunderlag',
      formula: reason,
      output: Number(sre.avgifter_basis_override),
    })
  }
  if (sre.avgifter_amount_override !== null && sre.avgifter_amount_override !== undefined) {
    overrideSteps.push({
      label: 'Manuell justering: Arbetsgivaravgifter',
      formula: reason,
      output: Number(sre.avgifter_amount_override),
    })
  }
  const breakdownSteps = baseSteps.length > 0 || overrideSteps.length > 0
    ? [...baseSteps, ...overrideSteps]
    : undefined

  // Build bank account display (masked)
  let bankAccount: string | undefined
  if (emp.clearing_number && emp.bank_account_number) {
    const lastDigits = emp.bank_account_number.slice(-4)
    bankAccount = `${emp.clearing_number}-****${lastDigits}`
  }

  // Honor advanced-mode per-employee overrides (tax/avgifter) on the payslip
  // so the employee sees the same effective values that are booked and AGI-
  // reported.
  const effectiveTax = sre.tax_withheld_override ?? sre.tax_withheld
  const effectiveAvgifter = sre.avgifter_amount_override ?? sre.avgifter_amount
  const effectiveNet = sre.net_salary + (sre.tax_withheld - effectiveTax)

  const data: PayslipData = {
    companyName: company.name,
    companyOrgNumber: company.org_number || '',
    employeeName: `${emp.first_name} ${emp.last_name}`,
    personnummerMasked: maskPersonnummer(decryptPersonnummer(emp.personnummer)),
    employmentType: EMPLOYMENT_LABELS[emp.employment_type] || emp.employment_type,
    periodYear: run.period_year,
    periodMonth: run.period_month,
    paymentDate: run.payment_date,
    lineItems,
    grossSalary: sre.gross_salary,
    taxWithheld: effectiveTax,
    netSalary: effectiveNet,
    taxReference,
    avgifterRate: sre.avgifter_rate,
    avgifterAmount: effectiveAvgifter,
    vacationAccrual: sre.vacation_accrual,
    vacationAccrualAvgifter: sre.vacation_accrual_avgifter,
    totalEmployerCost: sre.gross_salary + effectiveAvgifter + sre.vacation_accrual + sre.vacation_accrual_avgifter,
    ytdGross: sre.ytd_gross,
    ytdTax: sre.ytd_tax,
    ytdNet: sre.ytd_net,
    bankAccount,
    breakdownSteps,
  }

  const periodLabel = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
  const fileName = `lonespec_${emp.last_name}_${emp.first_name}_${periodLabel}.pdf`

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buffer = await renderToBuffer(PayslipPDF({ data }) as any)

  return new Response(buffer as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${fileName}"`,
    },
  })
}
