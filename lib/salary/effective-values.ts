/**
 * Effective salary values — coalesce per-employee overrides over the
 * engine-computed defaults.
 *
 * Used by booking (salary-entries.ts) and AGI (agi/generate-declaration.ts)
 * so a manual adjustment for FoU-avdrag or jämkning flows through to both
 * the ledger and the Skatteverket declaration.
 */
export interface SalaryRunEmployeeWithOverrides {
  tax_withheld: number
  tax_withheld_override?: number | null
  avgifter_amount: number
  avgifter_amount_override?: number | null
  avgifter_basis: number
  avgifter_basis_override?: number | null
}

export function effectiveTax(sre: SalaryRunEmployeeWithOverrides): number {
  return sre.tax_withheld_override ?? sre.tax_withheld
}

export function effectiveAvgifter(sre: SalaryRunEmployeeWithOverrides): number {
  return sre.avgifter_amount_override ?? sre.avgifter_amount
}

export function effectiveAvgifterBasis(sre: SalaryRunEmployeeWithOverrides): number {
  return sre.avgifter_basis_override ?? sre.avgifter_basis
}
