import type { Transaction, TransactionCategory, Invoice, Customer, SupplierInvoice, VatTreatment } from '@/types'

// Shared transaction type with potential invoice data
export interface TransactionWithInvoice extends Transaction {
  potential_invoice?: Invoice & { customer?: Customer }
  potential_supplier_invoice?: SupplierInvoice
}

// Page view modes
export type ViewMode = 'inbox' | 'history'
export type HistoryFilter = 'all' | 'business' | 'private'

// Handler types
// Returns the journal_entry_id on success, null on failure
export type CategorizeHandler = (
  id: string,
  isBusiness: boolean,
  category?: TransactionCategory,
  vatTreatment?: VatTreatment,
  accountOverride?: string,
  templateId?: string,
  inboxItemId?: string
) => Promise<string | null>

export type MatchInvoiceHandler = (
  transactionId: string,
  invoiceId: string
) => Promise<boolean>

// Category option type
export interface CategoryOption {
  value: TransactionCategory
  label: string
  account?: string
}

// Shared category arrays
export const EXPENSE_CATEGORIES: CategoryOption[] = [
  { value: 'expense_representation', label: 'Representation', account: '6071' },
  { value: 'expense_equipment', label: 'Utrustning', account: '5410' },
  { value: 'expense_software', label: 'Programvara', account: '5420' },
  { value: 'expense_consumables', label: 'Material', account: '5460' },
  { value: 'expense_travel', label: 'Resor', account: '5800' },
  { value: 'expense_office', label: 'Kontor', account: '6110' },
  { value: 'expense_vehicle', label: 'Bil & drivmedel', account: '5611' },
  { value: 'expense_telecom', label: 'Telefon & internet', account: '6200' },
  { value: 'expense_marketing', label: 'Marknadsföring', account: '5910' },
  { value: 'expense_professional_services', label: 'Konsulter', account: '6530' },
  { value: 'expense_education', label: 'Utbildning', account: '6991' },
  { value: 'expense_bank_fees', label: 'Bankavgift', account: '6570' },
  { value: 'expense_card_fees', label: 'Kortavgift', account: '6570' },
  { value: 'expense_currency_exchange', label: 'Valutaväxling', account: '7960' },
  { value: 'expense_other', label: 'Övrigt', account: '6991' },
]

export const INCOME_CATEGORIES: CategoryOption[] = [
  { value: 'income_services', label: 'Tjänster', account: '3001' },
  { value: 'income_products', label: 'Produkter', account: '3001' },
  { value: 'income_other', label: 'Övrigt', account: '3900' },
]

export interface VatTreatmentOption {
  value: VatTreatment | 'none'
  label: string
  description?: string
}

export const VAT_TREATMENT_OPTIONS: VatTreatmentOption[] = [
  { value: 'standard_25', label: 'Moms 25%' },
  { value: 'reduced_12', label: 'Moms 12%', description: 'Livsmedel, hotell, camping' },
  { value: 'reduced_6', label: 'Moms 6%', description: 'Böcker, tidningar, kollektivtrafik' },
  { value: 'reverse_charge', label: 'Omvänd skattskyldighet', description: 'Köparen redovisar momsen (EU-tjänster m.m.)' },
  { value: 'export', label: 'Export', description: 'Försäljning utanför EU (behåller avdragsrätt)' },
  { value: 'exempt', label: 'Momsfri', description: 'Undantaget enligt ML (vård, utbildning, finans)' },
  { value: 'none', label: 'Ingen moms', description: 'Ej momspliktigt (t.ex. lön, privata uttag)' },
]
