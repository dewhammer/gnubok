import { z } from 'zod'
import { NextResponse } from 'next/server'
import type { Logger } from '@/lib/logger'

export interface ValidationSuccess<T> {
  success: true
  data: T
}

export interface ValidationFailure {
  success: false
  response: NextResponse
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure

interface ValidationOptions {
  /** Optional logger; when present, validation failures are logged at warn level. */
  log?: Logger
  /** Identifier for the operation/route being validated, included in the log line. */
  operation?: string
}

function logIssues(
  options: ValidationOptions | undefined,
  kind: 'body' | 'query' | 'json',
  issues: Array<{ field: string; message: string; code: string }> | string,
) {
  if (!options?.log) return
  options.log.warn('validation failed', {
    operation: options.operation,
    kind,
    ...(typeof issues === 'string'
      ? { reason: issues }
      : { issueCount: issues.length, issues }),
  })
}

/**
 * Validate a request body against a Zod schema.
 *
 * Returns `{ success: true, data }` on valid input, or
 * `{ success: false, response }` with a 400 NextResponse on failure.
 *
 * Usage in an API route:
 * ```ts
 * const result = await validateBody(request, CreateInvoiceSchema)
 * if (!result.success) return result.response
 * const { data } = result
 * ```
 */
export async function validateBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  options?: ValidationOptions,
): Promise<ValidationResult<T>> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    logIssues(options, 'json', 'Invalid JSON in request body')
    return {
      success: false,
      response: NextResponse.json(
        {
          error: 'Invalid JSON in request body',
          type: 'validation_error',
        },
        { status: 400 },
      ),
    }
  }

  const result = schema.safeParse(body)

  if (!result.success) {
    const errors = result.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    }))

    logIssues(options, 'body', errors)

    return {
      success: false,
      response: NextResponse.json(
        {
          error: 'Validation failed',
          type: 'validation_error',
          errors,
        },
        { status: 400 },
      ),
    }
  }

  return { success: true, data: result.data }
}

/**
 * Validate query parameters (from URL searchParams) against a Zod schema.
 *
 * Usage:
 * ```ts
 * const params = validateQuery(request, VatDeclarationQuerySchema)
 * if (!params.success) return params.response
 * const { data } = params
 * ```
 */
export function validateQuery<T>(
  request: Request,
  schema: z.ZodType<T>,
  options?: ValidationOptions,
): ValidationResult<T> {
  const url = new URL(request.url)
  const raw = Object.fromEntries(url.searchParams.entries())

  const result = schema.safeParse(raw)

  if (!result.success) {
    const errors = result.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    }))

    logIssues(options, 'query', errors)

    return {
      success: false,
      response: NextResponse.json(
        {
          error: 'Invalid query parameters',
          type: 'validation_error',
          errors,
        },
        { status: 400 },
      ),
    }
  }

  return { success: true, data: result.data }
}
