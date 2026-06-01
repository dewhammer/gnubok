/**
 * Shared helpers for deriving stable bank-transaction `external_id`s and for
 * normalizing monetary amounts used in dedup keys.
 *
 * Why this exists
 * ---------------
 * The transactions table is deduplicated on `(company_id, external_id)` (a
 * partial unique index, see migration 20260330130000). The dedup is therefore
 * only as good as the stability of `external_id` across re-syncs.
 *
 * For Enable Banking (PSD2 / Berlin Group) the previous scheme keyed
 * `external_id` off the bank's `entry_reference` / `transaction_id`
 * (`eb_{account}_{tx.id}`). Many Swedish ASPSPs do NOT return those fields
 * stably across requests — a later "synka nu" can return the same underlying
 * transaction with a different id, which produced a *new* `external_id` and
 * therefore a duplicate row (including for transactions the user had already
 * booked). See `buildStableExternalIds` for the content-derived replacement.
 */

/**
 * Normalize a monetary amount to integer öre (hundredths) for stable,
 * representation-agnostic comparison.
 *
 * PostgREST may return a `numeric` column as a JS number OR as a string
 * (preserving precision), so `1234.5` and the string `"1234.50"` can describe
 * the same amount. Interpolating either directly into a dedup key yields
 * different strings (`"1234.5"` vs `"1234.50"`), silently breaking content
 * dedup. Rounding to integer öre collapses both to `123450`.
 *
 * Uses the project-standard `Math.round(x * 100)` (never `toFixed`).
 */
export function amountToOre(amount: number | string): number {
  return Math.round(Number(amount) * 100)
}

/**
 * Swedish-first placeholder for transactions a bank/import source gives no
 * usable title. Centralized so every import path and the tests agree.
 */
export const FALLBACK_DESCRIPTION = 'Okänd transaktion'

/**
 * Normalize an imported transaction title for storage and display.
 *
 * Maps both an empty/whitespace title AND the legacy English 'Unknown'
 * sentinel — still emitted by the bank-file format parsers and as the Enable
 * Banking converter's last resort — to a Swedish-first neutral. Applied once at
 * the ingest boundary so every source (PSD2 sync + CSV/CAMT import) inherits
 * it; the bank's verbatim text is preserved separately in
 * `transactions.original_description`. Match on the exact 'unknown' sentinel
 * (case-insensitive) so a real description that merely contains the word is
 * never clobbered.
 */
export function normalizeImportedDescription(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed || trimmed.toLowerCase() === 'unknown') return FALLBACK_DESCRIPTION
  return trimmed
}

/**
 * Build stable, collision-safe `external_id`s for a batch of bank transactions
 * whose provider does not supply a reliable stable id (e.g. Enable Banking).
 *
 * The id is derived from content — `{prefix}_{accountScope}_{date}_{öre}_{n}`
 * — where `n` is an occurrence index that disambiguates genuinely identical
 * transactions (same account, date and amount) within the batch.
 *
 * Properties this guarantees:
 * - **Re-sync dedupe**: the same set of transactions produces the same *set*
 *   of ids regardless of the order the ASPSP returns them in, so a repeat sync
 *   collides with the existing rows on `(company_id, external_id)` and is
 *   skipped — even after the user has booked them. (The id *set* is what the
 *   unique index enforces; which physical row maps to `..._0` vs `..._1` need
 *   not be stable, only the set.)
 * - **No false dedupe**: two legitimately distinct transactions that share a
 *   date and amount get different ids (`..._0`, `..._1`) and are both kept.
 *   This is the safeguard the bank-file importer already relies on via its
 *   `rowIndex` component (see `lib/import/bank-file/parser.ts`).
 *
 * Why description is NOT an input here (but IS in `contentDedupKey`): the
 * `external_id` must be a *stable unique key*, so it cannot depend on a field
 * that drifts — PSD2 enriches/reorders descriptions between a transaction's
 * pending and booked states. The occurrence index gives uniqueness without
 * that fragility. `contentDedupKey` has the opposite job — it is a best-effort
 * *bridge* that must avoid dropping real transactions — so it keeps the
 * description (see that function for the trade-off).
 *
 * @param prefix       Source tag, e.g. `'eb'` for Enable Banking.
 * @param accountScope Stable per-account scope (prefer IBAN, fall back to the
 *                     provider account uid). Keeps ids unique across accounts.
 *                     Callers should pass a whitespace/case-normalized IBAN so
 *                     formatting variants ("SE45 5000…" vs "SE455000…") don't
 *                     produce different ids for the same account.
 * @param txns         Batch in provider order; each needs `date` + `amount`.
 */
export function buildStableExternalIds(
  prefix: string,
  accountScope: string,
  txns: Array<{ date: string; amount: number | string }>
): string[] {
  const occurrences = new Map<string, number>()
  return txns.map((tx) => {
    const fingerprint = `${tx.date}_${amountToOre(tx.amount)}`
    const n = occurrences.get(fingerprint) ?? 0
    occurrences.set(fingerprint, n + 1)
    return `${prefix}_${accountScope}_${fingerprint}_${n}`
  })
}

/**
 * Stable content-dedup key used to bridge transactions across `external_id`
 * schemes and import sources (PSD2 ⇄ CSV, old id scheme ⇄ new id scheme).
 *
 * Format: `{date}|{öre}|{normalized description prefix}`.
 *
 * This is a *best-effort* dedup signal, not a unique key. It is consumed with
 * COUNTING semantics in the ingest pipeline (N existing matches consume N
 * incoming), and its job is to skip re-imports WITHOUT ever dropping a real
 * transaction. That asymmetry drives the two design choices here:
 *
 * - **öre via `amountToOre`** — a JS number (`-250`) and a PostgREST numeric
 *   string (`"-250.00"`) must collapse to the same key, otherwise dedup
 *   silently misses.
 * - **description IS included** (unlike `external_id`) — two genuinely distinct
 *   transactions that merely share a date and amount (e.g. two SEK 250 card
 *   purchases) must NOT be collapsed into one, or a real transaction is lost.
 *   Including the description prefix biases toward keeping both. The cost is
 *   that if a description drifts between syncs the bridge can miss a true
 *   duplicate — an acceptable trade for an accounting ledger, where a visible,
 *   user-deletable duplicate is far safer than a silently dropped row.
 */
export function contentDedupKey(
  date: string,
  amount: number | string,
  description: string | null | undefined
): string {
  const descPrefix = (description || '').toLowerCase().trim().slice(0, 24)
  return `${date}|${amountToOre(amount)}|${descPrefix}`
}
