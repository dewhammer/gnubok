import type { NEDeclaration, SRUFile, SRURecord } from '@/lib/reports/ne-bilaga/types'
import { getBranding } from '@/lib/branding/service'

function sanitizeString(str: string): string {
  return str.replace(/#/g, '').replace(/[\r\n]/g, ' ').substring(0, 250)
}

/**
 * SRU File Generator
 *
 * Generates SRU (Standardiserat Räkenskapsutdrag) files for electronic
 * submission to Skatteverket. The SRU format is used for tax declarations.
 *
 * Format specification:
 * - Each line starts with # followed by field code
 * - Values follow the field code
 * - File must be plain text (ISO-8859-1 encoding traditionally, but UTF-8 is often accepted)
 *
 * NE-bilaga field codes:
 * - #BLANKETT NE - Declares this is an NE form
 * - #IDENTITET - Organization number + name
 * - #UPPGIFT - Individual field values
 */

/**
 * SRU field codes for NE declaration
 * These are the official Skatteverket field codes for NE-bilaga
 */
const NE_SRU_FIELD_CODES: Record<string, string> = {
  // Company identification
  ORG_NUMBER: '201',
  COMPANY_NAME: '202',

  // NE rutor - Income
  R1: '7310',  // Försäljning och andra intäkter med moms
  R2: '7311',  // Momsfria intäkter (ej skattepliktiga)
  R3: '7312',  // Bil- och bostadsförmån m.m.
  R4: '7313',  // Ränteintäkter

  // NE rutor - Expenses
  R5: '7320',  // Varuinköp
  R6: '7321',  // Övriga externa kostnader
  R7: '7322',  // Anställdas löner
  R8: '7323',  // Räntekostnader
  R9: '7324',  // Avskrivningar på byggnader och markanläggningar
  R10: '7325', // Avskrivningar på maskiner och inventarier

  // Result
  R11: '7350', // Årets resultat
}

/**
 * Generate SRU file content from NE declaration
 */
export function generateSRUFile(declaration: NEDeclaration): SRUFile {
  const records: SRURecord[] = []
  const now = new Date()

  // File header
  records.push({ fieldCode: 'PRODUKT', value: 'KONTROLLUPPGIFTER' })
  records.push({ fieldCode: 'SESSION', value: '1' })
  records.push({ fieldCode: 'PROGRAMNAMN', value: sanitizeString(getBranding().appName) })
  records.push({ fieldCode: 'PROGRAMVERSION', value: '1.0' })
  records.push({
    fieldCode: 'SKAPAT',
    value: formatSRUDate(now),
  })

  // Form declaration
  records.push({ fieldCode: 'BLANKETT', value: 'NE' })

  // Company identification
  if (declaration.companyInfo.orgNumber) {
    // Remove any dashes from org number
    const cleanOrgNumber = declaration.companyInfo.orgNumber.replace(/-/g, '')
    records.push({
      fieldCode: 'IDENTITET',
      value: cleanOrgNumber,
    })
  }

  // Fiscal year
  records.push({
    fieldCode: 'UPPGIFT',
    value: `7000 ${formatSRUDateRange(declaration.fiscalYear.start, declaration.fiscalYear.end)}`,
  })

  // NE rutor values
  const rutaEntries: [keyof typeof NE_SRU_FIELD_CODES, number][] = [
    ['R1', declaration.rutor.R1],
    ['R2', declaration.rutor.R2],
    ['R3', declaration.rutor.R3],
    ['R4', declaration.rutor.R4],
    ['R5', declaration.rutor.R5],
    ['R6', declaration.rutor.R6],
    ['R7', declaration.rutor.R7],
    ['R8', declaration.rutor.R8],
    ['R9', declaration.rutor.R9],
    ['R10', declaration.rutor.R10],
    ['R11', declaration.rutor.R11],
  ]

  for (const [ruta, value] of rutaEntries) {
    // Only include non-zero values
    if (value !== 0) {
      const fieldCode = NE_SRU_FIELD_CODES[ruta]
      records.push({
        fieldCode: 'UPPGIFT',
        value: `${fieldCode} ${formatSRUAmount(value)}`,
      })
    }
  }

  // End of form
  records.push({ fieldCode: 'BLANKETTSLUT', value: '' })

  return {
    records,
    generatedAt: now.toISOString(),
  }
}

/**
 * Convert SRU file to string content
 */
export function sruFileToString(sruFile: SRUFile): string {
  const lines: string[] = []

  for (const record of sruFile.records) {
    if (record.value === '') {
      lines.push(`#${record.fieldCode}`)
    } else {
      lines.push(`#${record.fieldCode} ${record.value}`)
    }
  }

  // SRU files should end with a newline
  return lines.join('\r\n') + '\r\n'
}

/**
 * Format date for SRU: YYYYMMDD
 */
function formatSRUDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

/**
 * Format date string (YYYY-MM-DD) to SRU format (YYYYMMDD)
 */
function dateStringToSRU(dateStr: string): string {
  return dateStr.replace(/-/g, '')
}

/**
 * Format fiscal year date range for SRU
 */
function formatSRUDateRange(startDate: string, endDate: string): string {
  return `${dateStringToSRU(startDate)}-${dateStringToSRU(endDate)}`
}

/**
 * Format amount for SRU
 * - Whole numbers (no decimals)
 * - No thousands separator
 * - Negative values with minus sign
 */
function formatSRUAmount(amount: number): string {
  return Math.round(amount).toString()
}

/**
 * Validate SRU file content
 */
export function validateSRUFile(sruFile: SRUFile): {
  isValid: boolean
  errors: string[]
} {
  const errors: string[] = []

  // Check for required records
  const hasHeader = sruFile.records.some(r => r.fieldCode === 'PRODUKT')
  const hasBlankett = sruFile.records.some(r => r.fieldCode === 'BLANKETT')
  const hasBlankettslut = sruFile.records.some(r => r.fieldCode === 'BLANKETTSLUT')

  if (!hasHeader) {
    errors.push('Missing PRODUKT header')
  }

  if (!hasBlankett) {
    errors.push('Missing BLANKETT declaration')
  }

  if (!hasBlankettslut) {
    errors.push('Missing BLANKETTSLUT')
  }

  return {
    isValid: errors.length === 0,
    errors,
  }
}

/**
 * Get filename for SRU file download
 */
export function getSRUFilename(declaration: NEDeclaration): string {
  const year = declaration.fiscalYear.start.substring(0, 4)
  const orgNumber = declaration.companyInfo.orgNumber?.replace(/-/g, '') || 'unknown'
  return `NE_${orgNumber}_${year}.sru`
}
