import { type z } from 'zod'
import { UpdateCustomerSchema } from '@/lib/api/schemas'
import type { SupabaseClient } from '@supabase/supabase-js'
import { validateVatNumber } from '@/lib/vat/vies-client'
import type { Logger } from '@/lib/logger'

export type CustomerUpdateBody = z.infer<typeof UpdateCustomerSchema>

/** Trim optional text; blank strings become SQL NULL. */
export function normalizeOptionalText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export function buildCustomerUpdateData(body: CustomerUpdateBody): Record<string, unknown> {
  const updateData: Record<string, unknown> = {}

  if (body.name !== undefined) updateData.name = body.name.trim()
  if (body.customer_type !== undefined) updateData.customer_type = body.customer_type
  if (body.email !== undefined) updateData.email = normalizeOptionalText(body.email)
  if (body.phone !== undefined) updateData.phone = normalizeOptionalText(body.phone)
  if (body.address_line1 !== undefined) updateData.address_line1 = normalizeOptionalText(body.address_line1)
  if (body.address_line2 !== undefined) updateData.address_line2 = normalizeOptionalText(body.address_line2)
  if (body.postal_code !== undefined) updateData.postal_code = normalizeOptionalText(body.postal_code)
  if (body.city !== undefined) updateData.city = normalizeOptionalText(body.city)
  if (body.country !== undefined) updateData.country = normalizeOptionalText(body.country) ?? body.country
  if (body.org_number !== undefined) updateData.org_number = normalizeOptionalText(body.org_number)
  if (body.vat_number !== undefined) updateData.vat_number = normalizeOptionalText(body.vat_number)
  if (body.personal_number !== undefined) {
    updateData.personal_number = normalizeOptionalText(body.personal_number)
  }
  if (body.language !== undefined) updateData.language = body.language
  if (body.default_payment_terms !== undefined) updateData.default_payment_terms = body.default_payment_terms
  if (body.notes !== undefined) updateData.notes = normalizeOptionalText(body.notes)

  return updateData
}

/**
 * When vat_number is present on an eu_business customer, resolve VIES status
 * up front so the row is updated atomically (matches the v1 API route).
 */
export async function applyEuVatValidationToUpdate(
  supabase: SupabaseClient,
  companyId: string,
  customerId: string,
  body: CustomerUpdateBody,
  updateData: Record<string, unknown>,
  log: Logger,
): Promise<void> {
  if (body.vat_number === undefined) return

  let customerType = body.customer_type
  if (customerType === undefined) {
    const { data: current } = await supabase
      .from('customers')
      .select('customer_type')
      .eq('id', customerId)
      .eq('company_id', companyId)
      .maybeSingle()
    customerType = current?.customer_type
  }

  if (customerType !== 'eu_business') return

  if (body.vat_number) {
    try {
      const vatResult = await validateVatNumber(body.vat_number)
      updateData.vat_number_validated = vatResult.valid
      updateData.vat_number_validated_at = vatResult.valid ? new Date().toISOString() : null
    } catch (err) {
      log.warn('auto-VIES validation failed on customer update', err as Error)
      updateData.vat_number_validated = false
      updateData.vat_number_validated_at = null
    }
  } else {
    updateData.vat_number_validated = false
    updateData.vat_number_validated_at = null
  }
}
