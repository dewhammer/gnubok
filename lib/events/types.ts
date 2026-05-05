import type {
  JournalEntry,
  Invoice,
  Transaction,
  Customer,
  FiscalPeriod,
  DocumentAttachment,
  Receipt,
  CreditNote,
  ReconciliationMethod,
  InvoiceInboxItem,
  SupplierInvoice,
} from '@/types'

// ============================================================
// Core Event Types — discriminated union of all system events
// ============================================================

export type CoreEvent =
  // Bookkeeping
  | { type: 'journal_entry.drafted'; payload: { entry: JournalEntry; userId: string; companyId: string } }
  | { type: 'journal_entry.committed'; payload: { entry: JournalEntry; userId: string; companyId: string } }
  | { type: 'journal_entry.corrected'; payload: { original: JournalEntry; storno: JournalEntry; corrected: JournalEntry; userId: string; companyId: string } }
  | { type: 'journal_entry.reversed'; payload: { originalEntry: JournalEntry; reversalEntry: JournalEntry; userId: string; companyId: string } }
  | { type: 'journal_entry.deleted'; payload: { entryId: string; voucherSeries: string; voucherNumber: number; userId: string; companyId: string } }
  // Documents
  | { type: 'document.uploaded'; payload: { document: DocumentAttachment; userId: string; companyId: string } }
  | { type: 'document.accessed'; payload: { document: { id: string; file_name: string }; userId: string; companyId: string } }
  // Invoicing
  | { type: 'invoice.created'; payload: { invoice: Invoice; userId: string; companyId: string } }
  | { type: 'invoice.sent'; payload: { invoice: Invoice; userId: string; companyId: string } }
  | { type: 'credit_note.created'; payload: { creditNote: CreditNote; userId: string; companyId: string } }
  // Banking
  | { type: 'transaction.synced'; payload: { transactions: Transaction[]; userId: string; companyId: string } }
  | { type: 'transaction.categorized'; payload: { transaction: Transaction; account: string; taxCode: string; userId: string; companyId: string } }
  | { type: 'transaction.reconciled'; payload: { transaction: Transaction; journalEntryId: string; method: ReconciliationMethod; userId: string; companyId: string } }
  // Periods
  | { type: 'period.locked'; payload: { period: FiscalPeriod; userId: string; companyId: string } }
  | { type: 'period.unlocked'; payload: { period: FiscalPeriod; userId: string; companyId: string } }
  | { type: 'period.year_closed'; payload: { period: FiscalPeriod; userId: string; companyId: string } }
  // Customers
  | { type: 'customer.created'; payload: { customer: Customer; userId: string; companyId: string } }
  // Receipts
  | { type: 'receipt.extracted'; payload: {
      receipt: Receipt;
      documentId: string | null;
      confidence: number;
      userId: string;
      companyId: string;
    }}
  | { type: 'receipt.matched'; payload: {
      receipt: Receipt;
      transaction: Transaction;
      confidence: number;
      autoMatched: boolean;
      userId: string;
      companyId: string;
    }}
  | { type: 'receipt.confirmed'; payload: {
      receipt: Receipt;
      businessTotal: number;
      privateTotal: number;
      userId: string;
      companyId: string;
    }}
  // Supplier Invoice Lifecycle
  | { type: 'supplier_invoice.registered'; payload: { supplierInvoice: SupplierInvoice; userId: string; companyId: string } }
  | { type: 'supplier_invoice.approved'; payload: { supplierInvoice: SupplierInvoice; userId: string; companyId: string } }
  | { type: 'supplier_invoice.paid'; payload: { supplierInvoice: SupplierInvoice; paymentAmount: number; userId: string; companyId: string } }
  | { type: 'supplier_invoice.credited'; payload: { supplierInvoice: SupplierInvoice; creditNote: SupplierInvoice; userId: string; companyId: string } }
  | { type: 'supplier_invoice.uncredited'; payload: { supplierInvoice: SupplierInvoice; reversedCreditNoteId: string; reversalEntryId: string | null; userId: string; companyId: string } }
  // Payment Matching
  | { type: 'invoice.match_confirmed'; payload: { invoice: Invoice; transaction: Transaction; userId: string; companyId: string } }
  | { type: 'supplier_invoice.match_confirmed'; payload: { supplierInvoice: SupplierInvoice; transaction: Transaction; userId: string; companyId: string } }
  // Supplier Invoice Inbox
  | { type: 'supplier_invoice.received'; payload: { inboxItem: InvoiceInboxItem; userId: string; companyId: string } }
  | { type: 'supplier_invoice.extracted'; payload: { inboxItem: InvoiceInboxItem; confidence: number; userId: string; companyId: string } }
  | { type: 'supplier_invoice.confirmed'; payload: { inboxItem: InvoiceInboxItem; supplierInvoice: SupplierInvoice; userId: string; companyId: string } }
  // Salary
  | { type: 'salary_run.created'; payload: { salaryRunId: string; periodYear: number; periodMonth: number; userId: string; companyId: string } }
  | { type: 'salary_run.approved'; payload: { salaryRunId: string; approvedBy: string; userId: string; companyId: string } }
  | { type: 'salary_run.booked'; payload: { salaryRunId: string; entryIds: string[]; userId: string; companyId: string } }
  | { type: 'agi.generated'; payload: { agiId: string; periodYear: number; periodMonth: number; userId: string; companyId: string } }
  | { type: 'agi.submitted'; payload: { salaryRunId: string; periodYear: number; periodMonth: number; userId: string; companyId: string } }
  // Skatteverket — Skattekonto sync
  | { type: 'skattekonto.synced'; payload: { booked: number; upcoming: number; balanceSkv: number; balanceKfm: number; userId: string; companyId: string } }
  | { type: 'skattekonto.balance.changed'; payload: { previousBalance: number; currentBalance: number; userId: string; companyId: string } }
  | { type: 'skattekonto.transaction.upcoming'; payload: { transaktionsdatum: string; forfallodatum: string; transaktionstext: string; beloppSkatteverket: number; userId: string; companyId: string } }
  | { type: 'skattekonto.connection.expired'; payload: { reason: 'REFRESH_EXHAUSTED' | 'SESSION_EXPIRED' | 'TOKEN_CORRUPTED'; userId: string; companyId: string } }
  // Company & account lifecycle
  | { type: 'company.deleted'; payload: { companyId: string; userId: string; archivedAt: string } }
  | { type: 'account.deleted'; payload: { userId: string; deletedAt: string } }

// ============================================================
// Helper Types
// ============================================================

/** All possible event type strings */
export type CoreEventType = CoreEvent['type']

/** Extract the payload type for a given event type */
export type EventPayload<T extends CoreEventType> = Extract<CoreEvent, { type: T }>['payload']

/** Handler function for a specific event type */
export type EventHandler<T extends CoreEventType> = (payload: EventPayload<T>) => Promise<void> | void

/** Subscription: event type + handler */
export interface EventSubscription<T extends CoreEventType = CoreEventType> {
  eventType: T
  handler: EventHandler<T>
}
