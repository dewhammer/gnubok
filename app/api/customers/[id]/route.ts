import { NextResponse } from 'next/server'
import { validateBody } from '@/lib/api/validate'
import { UpdateCustomerSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  applyEuVatValidationToUpdate,
  buildCustomerUpdateData,
} from '@/lib/customers/build-update-data'

export const GET = withRouteContext(
  'customer.get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ customerId: id })

    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return errorResponseFromCode('CUSTOMER_NOT_FOUND', opLog, { requestId })
      }
      opLog.error('customer fetch failed', error)
      return errorResponseFromCode('INTERNAL_ERROR', opLog, {
        requestId,
        details: { reason: error.message },
      })
    }

    const { data: invoices } = await supabase
      .from('invoices')
      .select('id, invoice_number, invoice_date, due_date, status, total, currency')
      .eq('customer_id', id)
      .eq('company_id', companyId)
      .order('invoice_date', { ascending: false })

    return NextResponse.json({ data: { ...data, invoices: invoices || [] } })
  },
)

export const PATCH = withRouteContext(
  'customer.update',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ customerId: id })

    const result = await validateBody(request, UpdateCustomerSchema, {
      log: opLog,
      operation: 'customer.update',
    })
    if (!result.success) return result.response
    const body = result.data

    const updateData = buildCustomerUpdateData(body)

    if (Object.keys(updateData).length === 0) {
      return errorResponseFromCode('VALIDATION_ERROR', opLog, {
        requestId,
        details: { field: 'body', message: 'At least one field must be supplied for update.' },
      })
    }

    await applyEuVatValidationToUpdate(supabase, companyId, id, body, updateData, opLog)

    const { data, error } = await supabase
      .from('customers')
      .update(updateData)
      .eq('id', id)
      .eq('company_id', companyId)
      .select()
      .maybeSingle()

    if (error) {
      if (error.code === '23505') {
        return errorResponseFromCode('CUSTOMER_DUPLICATE_ORG_NUMBER', opLog, {
          requestId,
          details: { orgNumber: body.org_number },
        })
      }
      if (error.code === '23514') {
        return errorResponseFromCode('VALIDATION_ERROR', opLog, {
          requestId,
          details: { reason: error.message },
        })
      }
      if (error.code === 'PGRST116') {
        return errorResponseFromCode('CUSTOMER_NOT_FOUND', opLog, { requestId })
      }
      opLog.error('customer update failed', error)
      return errorResponseFromCode('CUSTOMER_UPDATE_FAILED', opLog, {
        requestId,
        details: { reason: error.message },
      })
    }

    if (!data) {
      return errorResponseFromCode('CUSTOMER_NOT_FOUND', opLog, { requestId })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext(
  'customer.delete',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ customerId: id })

    const { error, count } = await supabase
      .from('customers')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('company_id', companyId)

    if (error) {
      if (error.code === '23503') {
        return errorResponseFromCode('CUSTOMER_HAS_INVOICES', opLog, { requestId })
      }
      opLog.error('customer delete failed', error)
      return errorResponseFromCode('CUSTOMER_DELETE_FAILED', opLog, {
        requestId,
        details: { reason: error.message },
      })
    }

    if (count === 0) {
      return errorResponseFromCode('CUSTOMER_NOT_FOUND', opLog, { requestId })
    }

    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
