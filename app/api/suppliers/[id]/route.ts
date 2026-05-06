import { NextResponse } from 'next/server'
import { validateBody } from '@/lib/api/validate'
import { UpdateSupplierSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

export const GET = withRouteContext(
  'supplier.get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ supplierId: id })

    const { data: supplier, error } = await supabase
      .from('suppliers')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error || !supplier) {
      return errorResponseFromCode('SUPPLIER_NOT_FOUND', opLog, { requestId })
    }

    const { data: invoices } = await supabase
      .from('supplier_invoices')
      .select('status, total, remaining_amount, paid_amount')
      .eq('supplier_id', id)
      .eq('company_id', companyId)

    const stats = {
      total_outstanding: 0,
      total_paid: 0,
      invoice_count: 0,
    }

    if (invoices) {
      stats.invoice_count = invoices.length
      for (const inv of invoices) {
        if (inv.status !== 'paid' && inv.status !== 'credited') {
          stats.total_outstanding += inv.remaining_amount || 0
        }
        stats.total_paid += inv.paid_amount || 0
      }
    }

    return NextResponse.json({ data: { ...supplier, stats } })
  },
)

export const PUT = withRouteContext(
  'supplier.update',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ supplierId: id })

    const result = await validateBody(request, UpdateSupplierSchema, {
      log: opLog,
      operation: 'supplier.update',
    })
    if (!result.success) return result.response
    const body = result.data

    const { data, error } = await supabase
      .from('suppliers')
      .update({
        name: body.name,
        supplier_type: body.supplier_type,
        email: body.email,
        phone: body.phone,
        address_line1: body.address_line1,
        address_line2: body.address_line2,
        postal_code: body.postal_code,
        city: body.city,
        country: body.country,
        org_number: body.org_number,
        vat_number: body.vat_number,
        bankgiro: body.bankgiro,
        plusgiro: body.plusgiro,
        bank_account: body.bank_account,
        iban: body.iban,
        bic: body.bic,
        default_expense_account: body.default_expense_account,
        default_payment_terms: body.default_payment_terms,
        default_currency: body.default_currency,
        notes: body.notes,
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .select()
      .single()

    if (error) {
      if (error.code === '23505') {
        return errorResponseFromCode('SUPPLIER_DUPLICATE_ORG_NUMBER', opLog, {
          requestId,
          details: { orgNumber: body.org_number },
        })
      }
      opLog.error('supplier update failed', error)
      return errorResponseFromCode('SUPPLIER_UPDATE_FAILED', opLog, {
        requestId,
        details: { reason: error.message },
      })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext(
  'supplier.delete',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ supplierId: id })

    const { count } = await supabase
      .from('supplier_invoices')
      .select('id', { count: 'exact', head: true })
      .eq('supplier_id', id)
      .eq('company_id', companyId)

    if (count && count > 0) {
      return errorResponseFromCode('SUPPLIER_DELETE_FAILED', opLog, {
        requestId,
        details: { reason: 'has_invoices', invoiceCount: count },
      })
    }

    const { error, count: deleteCount } = await supabase
      .from('suppliers')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('company_id', companyId)

    if (error) {
      opLog.error('supplier delete failed', error)
      return errorResponseFromCode('SUPPLIER_DELETE_FAILED', opLog, {
        requestId,
        details: { reason: error.message },
      })
    }

    if (deleteCount === 0) {
      return errorResponseFromCode('SUPPLIER_NOT_FOUND', opLog, { requestId })
    }

    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
