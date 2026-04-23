/**
 * Maps raw errors to user-friendly Swedish messages.
 *
 * Priority chain:
 * 1. Zod validation field errors
 * 2. Postgres error code map
 * 3. HTTP status code map
 * 4. Context-specific fallback
 * 5. Generic fallback
 */

import { formatCurrency } from '@/lib/utils'

type ErrorContext =
  | 'invoice'
  | 'supplier_invoice'
  | 'customer'
  | 'supplier'
  | 'transaction'
  | 'journal_entry'
  | 'settings'
  | 'auth'
  | 'salary'

interface GetErrorMessageOptions {
  context?: ErrorContext
  statusCode?: number
}

// Postgres error codes -> Swedish messages
const POSTGRES_ERROR_MAP: Record<string, string> = {
  '23505': 'En post med samma uppgifter finns redan.',
  '23503': 'Posten kan inte ändras eftersom den refereras av annan data.',
  '23502': 'Ett obligatoriskt fält saknas.',
  '42501': 'Du har inte behörighet att utföra denna åtgärd.',
  '42P01': 'Resursen kunde inte hittas.',
  '23514': 'Värdet uppfyller inte de tillåtna kraven.',
  '40001': 'En annan ändring pågick samtidigt. Försök igen.',
  '40P01': 'En konflikt uppstod. Försök igen.',
  '22P02': 'Ogiltigt värde angavs.',
  '22003': 'Värdet är utanför tillåtet intervall.',
}

// HTTP status codes -> Swedish messages
const HTTP_STATUS_MAP: Record<number, string> = {
  400: 'Förfrågan innehåller ogiltiga uppgifter.',
  401: 'Din session har gått ut. Logga in igen.',
  403: 'Du har inte behörighet att utföra denna åtgärd.',
  404: 'Resursen kunde inte hittas.',
  409: 'En konflikt uppstod. Ladda om sidan och försök igen.',
  422: 'Uppgifterna kunde inte bearbetas. Kontrollera fälten och försök igen.',
  429: 'För många förfrågningar. Vänta en stund och försök igen.',
  500: 'Ett oväntat serverfel uppstod. Försök igen senare.',
  502: 'Servern är tillfälligt otillgänglig. Försök igen om en stund.',
  503: 'Tjänsten är tillfälligt otillgänglig. Försök igen om en stund.',
}

// Context-specific fallbacks
const CONTEXT_FALLBACKS: Record<ErrorContext, string> = {
  invoice: 'Kunde inte hantera fakturan. Försök igen.',
  supplier_invoice: 'Kunde inte hantera leverantörsfakturan. Försök igen.',
  customer: 'Kunde inte hantera kunden. Försök igen.',
  supplier: 'Kunde inte hantera leverantören. Försök igen.',
  transaction: 'Kunde inte hantera transaktionen. Försök igen.',
  journal_entry: 'Kunde inte hantera verifikationen. Försök igen.',
  settings: 'Kunde inte spara inställningarna. Försök igen.',
  auth: 'Ett fel uppstod vid inloggningen. Försök igen.',
  salary: 'Kunde inte hantera löneuppgifterna. Försök igen.',
}

const GENERIC_FALLBACK = 'Något gick fel. Försök igen.'

// Known error patterns → user-friendly Swedish messages
const ERROR_PATTERN_MAP: [RegExp, string | null][] = [
  [
    /locked\/closed fiscal period/i,
    'Perioden är låst. Verifikationen kan inte skapas i en stängd eller låst period.',
  ],
  [
    /Bokföringen är låst t\.o\.m\./,
    null, // null = extract the Swedish message directly from the raw error text
  ],
  [
    /Cannot attach documents to entries in a locked/i,
    'Kan inte bifoga dokument till verifikationer i en låst period.',
  ],
  [
    /Entry date .+ is outside fiscal period/i,
    'Datumet ligger utanför det valda räkenskapsåret.',
  ],
  [
    /timed out after \d+m?s/i,
    'Anslutningen mot tjänsten tog för lång tid. Försök igen.',
  ],
]

/**
 * Check if a message matches a known error pattern and return the Swedish translation.
 * Returns null if no pattern matches.
 */
function tryMatchKnownError(message: string): string | null {
  for (const [pattern, translation] of ERROR_PATTERN_MAP) {
    if (pattern.test(message)) {
      if (translation !== null) return translation
      // Extract the Swedish part from the message
      const match = message.match(/Bokföringen är låst t\.o\.m\. [^.]+\./)
      return match ? match[0] : 'Bokföringen är låst för denna period.'
    }
  }
  return null
}

/**
 * Simple heuristic to detect already-translated Swedish messages.
 * If the message contains common Swedish words/patterns, pass it through.
 */
function isSwedishUserMessage(message: string): boolean {
  const swedishPatterns = [
    /kunde inte/i,
    /försök igen/i,
    /ogiltigt?/i,
    /saknas/i,
    /måste/i,
    /redan finns/i,
    /gick fel/i,
    /behörighet/i,
    /session/i,
    /förfrågan/i,
    /obligatorisk/i,
    /bokföringen är låst/i,
  ]
  return swedishPatterns.some((p) => p.test(message))
}

/**
 * Extract a user-friendly message from a Zod validation error shape.
 * Returns null if the error is not a Zod error.
 */
function tryParseZodErrors(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null

  const obj = error as Record<string, unknown>

  // Check for Zod-style field errors: { fieldName: ["message"] } or { issues: [...] }
  if (Array.isArray(obj.issues)) {
    const issues = obj.issues as Array<{ message?: string; path?: string[] }>
    const messages = issues
      .slice(0, 3)
      .map((issue) => {
        const field = issue.path?.join('.') || ''
        const msg = issue.message || 'ogiltigt värde'
        return field ? `${field}: ${msg}` : msg
      })
    if (messages.length > 0) return messages.join('. ')
  }

  // Check for { errors: [{ field, message, code }] } shape from validateBody
  if (Array.isArray(obj.errors)) {
    const items = obj.errors as Array<{ field?: string; message?: string }>
    const messages = items
      .slice(0, 3)
      .map((it) => {
        const field = it.field || ''
        const msg = it.message || 'ogiltigt värde'
        return field ? `${field}: ${msg}` : msg
      })
      .filter(Boolean)
    if (messages.length > 0) return messages.join('. ')
  }

  // Check for { errors: { field: ["msg"] } } shape (legacy)
  if (typeof obj.errors === 'object' && obj.errors !== null) {
    const fieldErrors = obj.errors as Record<string, string[]>
    const messages: string[] = []
    for (const [field, msgs] of Object.entries(fieldErrors)) {
      if (Array.isArray(msgs) && msgs.length > 0) {
        messages.push(`${field}: ${msgs[0]}`)
      }
      if (messages.length >= 3) break
    }
    if (messages.length > 0) return messages.join('. ')
  }

  return null
}

/**
 * Get a user-friendly Swedish error message from a raw error.
 *
 * @param error - The raw error. Can be an API response body (object), Error instance, string, or unknown.
 * @param options - Optional context and HTTP status code.
 */
export function getErrorMessage(
  error: unknown,
  options: GetErrorMessageOptions = {}
): string {
  const { context, statusCode } = options

  // 1. If it's a string, check if it's already Swedish or matches a known pattern
  if (typeof error === 'string' && error.trim()) {
    if (isSwedishUserMessage(error)) return error
    const knownError = tryMatchKnownError(error)
    if (knownError) return knownError
  }

  // 2. If it's an object, try various parsing strategies
  if (typeof error === 'object' && error !== null) {
    const obj = error as Record<string, unknown>

    // Structured application error: { error: { code, message, ... } }
    if (typeof obj.error === 'object' && obj.error !== null) {
      const structured = obj.error as {
        code?: unknown
        message?: unknown
        account_numbers?: unknown
        details?: unknown
      }

      if (structured.code === 'ACCOUNTS_NOT_IN_CHART' && Array.isArray(structured.account_numbers)) {
        const numbers = structured.account_numbers as string[]
        return `Följande konton behöver aktiveras: ${numbers.join(', ')}`
      }

      if (structured.code === 'JOURNAL_ENTRY_NOT_BALANCED') {
        const details = structured.details as { totalDebit?: number; totalCredit?: number } | undefined
        if (details && typeof details.totalDebit === 'number' && typeof details.totalCredit === 'number') {
          return `Verifikationen balanserar inte (${formatCurrency(details.totalDebit)} debet vs ${formatCurrency(details.totalCredit)} kredit).`
        }
        return 'Verifikationen balanserar inte. Kontrollera att debet och kredit är lika stora.'
      }

      if (structured.code === 'FISCAL_PERIOD_NOT_FOUND') {
        return 'Räkenskapsperioden kunde inte hittas.'
      }

      if (structured.code === 'ENTRY_DATE_OUTSIDE_FISCAL_PERIOD') {
        return 'Datumet ligger utanför det valda räkenskapsåret.'
      }

      if (structured.code === 'JOURNAL_ENTRY_NOT_FOUND') {
        return 'Verifikationen kunde inte hittas.'
      }

      if (structured.code === 'CANNOT_REVERSE_NON_POSTED') {
        return 'Endast bokförda verifikationer kan stornas.'
      }

      if (structured.code === 'CANNOT_CORRECT_NON_POSTED') {
        return 'Endast bokförda verifikationer kan rättas.'
      }

      if (structured.code === 'ENTRY_ALREADY_REVERSED') {
        return 'Verifikationen har redan stornats av en annan användare. Ladda om sidan och försök igen.'
      }

      if (structured.code === 'CURRENCY_REVALUATION_ALREADY_EXISTS') {
        return 'En valutaomvärdering finns redan för denna period.'
      }

      if (structured.code === 'INVALID_MAPPING_RESULT') {
        return 'Kontering saknas för transaktionen. Kontrollera bokföringsreglerna.'
      }

      if (structured.code === 'BOOKKEEPING_DATABASE_ERROR') {
        // A DB-layer error may carry a user-relevant cause (e.g. period lock
        // trigger). Try the known-pattern map before falling back to the
        // generic "kunde inte sparas" message.
        if (typeof structured.message === 'string') {
          const matched = tryMatchKnownError(structured.message)
          if (matched) return matched
        }
        return 'Verifikationen kunde inte sparas. Försök igen.'
      }

      if (typeof structured.message === 'string' && structured.message.trim()) {
        return structured.message
      }
    }

    // Try Zod validation errors
    const zodMessage = tryParseZodErrors(obj)
    if (zodMessage) return zodMessage

    // Try Postgres error code
    if (typeof obj.code === 'string' && POSTGRES_ERROR_MAP[obj.code]) {
      return POSTGRES_ERROR_MAP[obj.code]
    }

    // Try known error patterns (e.g. locked period triggers)
    for (const field of ['error', 'message'] as const) {
      if (typeof obj[field] === 'string' && obj[field].trim()) {
        const knownError = tryMatchKnownError(obj[field])
        if (knownError) return knownError
      }
    }

    // Try error.message if it's already a good Swedish message
    if (typeof obj.error === 'string' && obj.error.trim()) {
      if (isSwedishUserMessage(obj.error)) return obj.error
    }

    if (typeof obj.message === 'string' && obj.message.trim()) {
      if (isSwedishUserMessage(obj.message)) return obj.message
    }
  }

  // 3. Error instance
  if (error instanceof Error && error.message.trim()) {
    const knownError = tryMatchKnownError(error.message)
    if (knownError) return knownError
    if (isSwedishUserMessage(error.message)) return error.message
  }

  // 4. HTTP status code map
  if (statusCode && HTTP_STATUS_MAP[statusCode]) {
    return HTTP_STATUS_MAP[statusCode]
  }

  // 5. Context-specific fallback
  if (context && CONTEXT_FALLBACKS[context]) {
    return CONTEXT_FALLBACKS[context]
  }

  // 6. Generic fallback
  return GENERIC_FALLBACK
}

/**
 * Helper that parses a Response body and returns a user-friendly error message.
 */
export async function getResponseErrorMessage(
  response: Response,
  context?: ErrorContext
): Promise<string> {
  try {
    const body = await response.json()
    return getErrorMessage(body, { context, statusCode: response.status })
  } catch {
    return getErrorMessage(null, { context, statusCode: response.status })
  }
}
