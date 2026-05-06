/**
 * Risk tier classification for pending_operations.
 *
 * Used by lib/pending-operations/should-auto-commit.ts to decide whether a
 * staged proposal from a trusted agent can be auto-committed without human
 * review.
 *
 * Tiering principles:
 *   - **low**: no booking impact, no external side-effects, no audit risk.
 *     A reasonable bookkeeper would never want to manually approve these.
 *   - **medium**: reversible booking impact (drafts, transaction
 *     categorization that can be uncategorized). Auto-commit is allowed for
 *     trusted agents under a configurable monetary threshold.
 *   - **high**: irreversible or compliance-critical. Sends external messages,
 *     locks/closes periods, or affects tax filings. NEVER auto-committed,
 *     regardless of company opt-in or trust level.
 */

export type RiskLevel = 'low' | 'medium' | 'high'

export const OPERATION_RISK_TIERS: Record<string, RiskLevel> = {
  // ── Low: pure data, no booking impact ─────────────────────────────
  create_customer: 'low',

  // ── Medium: reversible booking ─────────────────────────────────────
  categorize_transaction: 'medium',
  match_transaction_invoice: 'medium',
  create_invoice: 'medium', // creates as draft; sending is a separate op
  create_transaction: 'medium', // ingests an uncategorized row; reversible by delete
  // Pinning a doc to a tx is reversible while pre-categorization, but the link
  // becomes part of the verifikation underlag (BFL 5 kap 6 §) once categorize
  // propagates it. A wrong attachment requires a rättelse, so require human
  // approval rather than auto-commit.
  attach_document_to_transaction: 'medium',

  // ── High: irreversible, compliance-critical, or external side-effects
  send_invoice: 'high',          // emails the customer
  mark_invoice_paid: 'high',     // posts payment journal entry
  mark_invoice_sent: 'high',     // assigns invoice number, accrual JE

  // ── Stream 1 Phase 1 ops (added when those tools land) ─────────────
  close_period: 'high',
  lock_period: 'high',
  unlock_period: 'high',
  set_opening_balances: 'high',
  run_year_end: 'high',
  run_currency_revaluation: 'high',
  import_sie: 'high',
  explain_voucher_gap: 'medium',
  uncategorize_transaction: 'medium',
  approve_supplier_invoice: 'high',
  credit_supplier_invoice: 'high',
  credit_invoice: 'high',
  convert_invoice: 'medium',
}

export function getRiskLevel(operationType: string): RiskLevel {
  // Default to 'high' for unknown ops — fail-safe: unknown means human review.
  return OPERATION_RISK_TIERS[operationType] ?? 'high'
}

/**
 * High-risk operations are NEVER auto-committed, regardless of company opt-in
 * or actor trust. Encoded here (not in DB config) so it can't be bypassed.
 */
export function isHighRisk(operationType: string): boolean {
  return getRiskLevel(operationType) === 'high'
}
