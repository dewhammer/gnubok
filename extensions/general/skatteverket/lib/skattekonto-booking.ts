import type { SupabaseClient } from '@supabase/supabase-js'
import { createDraftEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import type {
  CreateJournalEntryInput,
  CreateJournalEntryLineInput,
  JournalEntry,
} from '@/types'

/**
 * Per-row "Bokför" helper.
 *
 * Takes a stored skattekonto_transactions row, guesses a counter-account
 * from the Swedish description text, and creates a DRAFT journal entry
 * via the bookkeeping engine. The user reviews and commits the draft in
 * /bookkeeping/[id].
 *
 * Sign convention (BAS 1630, Skattekonto):
 *   beloppSkatteverket > 0  (credit on tax account, e.g. payment in)
 *     → Debit 1630, Credit counter-account
 *   beloppSkatteverket < 0  (debit on tax account, e.g. F-tax charge)
 *     → Credit 1630, Debit counter-account
 *
 * The keyword table mirrors lib/bookkeeping/booking-templates.ts entries
 * for skattekonto-related events, and is intentionally narrow — when no
 * keyword matches, throw SkattekontoBookingError and let the UI route the
 * user to a manual entry rather than fabricate a counter-account.
 */

const SKATTEKONTO_ACCOUNT = '1630'

export type EntityType = 'enskild_firma' | 'aktiebolag'

interface CounterAccountRule {
  /** Lower-cased substrings; ANY matching wins. */
  match: string[]
  /** Counter-account number, possibly entity-type dependent. */
  account: string | { aktiebolag: string; enskild_firma: string }
  /** Optional human-readable label for the line description. */
  label?: string
}

const COUNTER_ACCOUNT_RULES: CounterAccountRule[] = [
  // Cash flows in/out
  {
    match: ['inbetalning bokförd', 'inbetalning', 'överföring från bank'],
    account: '1930',
    label: 'Inbetalning till skattekonto',
  },
  {
    match: ['utbetalning', 'återbetalning'],
    account: '1930',
    label: 'Utbetalning från skattekonto',
  },
  // Preliminary income tax — different liability accounts for AB vs EF
  {
    match: ['debiterad preliminärskatt', 'preliminärskatt', 'f-skatt', 'fskatt'],
    account: { aktiebolag: '2510', enskild_firma: '2012' },
    label: 'Preliminär skatt',
  },
  // Employer payroll taxes
  {
    match: ['arbetsgivaravgift', 'sociala avgifter', 'agi'],
    account: '2731',
    label: 'Arbetsgivaravgifter',
  },
  {
    match: ['avdragen skatt', 'personalskatt', 'a-skatt'],
    account: '2710',
    label: 'Avdragen skatt anställda',
  },
  // VAT — settlement account
  {
    match: ['mervärdesskatt', 'moms', 'momsdeklaration'],
    account: '2650',
    label: 'Redovisningskonto för moms',
  },
  // Interest — Skatteverket charges/credits interest on the account
  {
    match: ['kostnadsränta'],
    account: '8423',
    label: 'Kostnadsränta skattekonto',
  },
  {
    match: ['intäktsränta'],
    account: '8313',
    label: 'Intäktsränta skattekonto',
  },
]

export class SkattekontoBookingError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'NO_COUNTER_ACCOUNT'
      | 'NO_FISCAL_PERIOD'
      | 'PERIOD_LOCKED'
      | 'ALREADY_BOOKED'
      | 'TRANSACTION_NOT_FOUND',
  ) {
    super(message)
    this.name = 'SkattekontoBookingError'
  }
}

interface CounterAccountMatch {
  account: string
  label: string
}

/**
 * Find the counter-account for a Skatteverket transaktionstext.
 * Returns null if no rule matches. Public so tests can exercise it.
 */
export function guessCounterAccount(
  transaktionstext: string,
  entityType: EntityType,
): CounterAccountMatch | null {
  const normalized = transaktionstext.toLowerCase()
  for (const rule of COUNTER_ACCOUNT_RULES) {
    if (rule.match.some(needle => normalized.includes(needle))) {
      const account =
        typeof rule.account === 'string' ? rule.account : rule.account[entityType]
      return {
        account,
        label: rule.label ?? transaktionstext,
      }
    }
  }
  return null
}

/**
 * Create a draft journal entry for one skattekonto_transactions row.
 *
 * Throws SkattekontoBookingError on:
 *   - already-booked rows (journal_entry_id present)
 *   - missing/locked fiscal period for the transaktionsdatum
 *   - no keyword match → user must categorize manually
 *
 * Returns the created JournalEntry. Caller is responsible for writing
 * `journal_entry_id` back onto the skattekonto_transactions row.
 */
export async function bokforSkattekontoTransaction(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  transactionId: string,
): Promise<JournalEntry> {
  // 1. Load the transaction
  const { data: tx, error: txError } = await supabase
    .from('skattekonto_transactions')
    .select('*')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .single()

  if (txError || !tx) {
    throw new SkattekontoBookingError(
      'Skattekonto-transaktionen hittades inte.',
      'TRANSACTION_NOT_FOUND',
    )
  }

  if (tx.journal_entry_id) {
    throw new SkattekontoBookingError(
      'Transaktionen är redan bokförd.',
      'ALREADY_BOOKED',
    )
  }

  // 2. Get entity_type for AB/EF-specific accounts
  const { data: settings } = await supabase
    .from('company_settings')
    .select('entity_type')
    .eq('company_id', companyId)
    .single()

  const entityType: EntityType =
    (settings?.entity_type as EntityType) ?? 'aktiebolag'

  // 3. Guess counter-account
  const guess = guessCounterAccount(tx.transaktionstext, entityType)
  if (!guess) {
    throw new SkattekontoBookingError(
      `Vi kunde inte gissa motkontot för "${tx.transaktionstext}". Skapa verifikatet manuellt.`,
      'NO_COUNTER_ACCOUNT',
    )
  }

  // 4. Resolve fiscal period for entry date
  const fiscalPeriodId = await findFiscalPeriod(
    supabase,
    companyId,
    tx.transaktionsdatum,
  )
  if (!fiscalPeriodId) {
    throw new SkattekontoBookingError(
      `Datumet ${tx.transaktionsdatum} ligger i en låst eller saknad räkenskapsperiod. ` +
        'Lås upp perioden eller hoppa över raden.',
      'PERIOD_LOCKED',
    )
  }

  // 5. Build lines based on sign convention
  const amount = Math.abs(Number(tx.belopp_skatteverket))
  const isCreditToSkattekonto = Number(tx.belopp_skatteverket) > 0

  const lines: CreateJournalEntryLineInput[] = isCreditToSkattekonto
    ? [
        {
          account_number: SKATTEKONTO_ACCOUNT,
          debit_amount: amount,
          credit_amount: 0,
          line_description: tx.transaktionstext,
        },
        {
          account_number: guess.account,
          debit_amount: 0,
          credit_amount: amount,
          line_description: guess.label,
        },
      ]
    : [
        {
          account_number: guess.account,
          debit_amount: amount,
          credit_amount: 0,
          line_description: guess.label,
        },
        {
          account_number: SKATTEKONTO_ACCOUNT,
          debit_amount: 0,
          credit_amount: amount,
          line_description: tx.transaktionstext,
        },
      ]

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: tx.transaktionsdatum,
    description: `Skattekonto: ${tx.transaktionstext}`,
    source_type: 'system',
    source_id: tx.id,
    notes: `Genererad från skattekonto-synk. Skatteverket-id: ${tx.transaktionsidentitet ?? '–'}`,
    lines,
  }

  const entry = await createDraftEntry(supabase, companyId, userId, input)

  // Link the row back so the dashboard can show "Bokförd" status.
  await supabase
    .from('skattekonto_transactions')
    .update({ journal_entry_id: entry.id })
    .eq('id', tx.id)
    .eq('company_id', companyId)

  return entry
}
