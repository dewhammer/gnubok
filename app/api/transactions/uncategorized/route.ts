import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { gateAgentInbox } from '@/lib/ai/feature-flag'

ensureInitialized()

/**
 * GET /api/transactions/uncategorized
 *
 * Paginated list of uncategorized expense transactions for a picker UI
 * (e.g. agent-inkorg's "Byt transaktion" flow). Returns expenses only —
 * amount < 0 — since match proposals always pair receipts to outgoing
 * payments. Includes basic range filters so callers can narrow to matches
 * within ±window of a target amount/date.
 *
 * Query params:
 *   search           Free-text against description/merchant_name (ILIKE)
 *   amount_center    Target amount (signed). Must be accompanied by amount_window.
 *   amount_window    Half-window in SEK — e.g. 50 means amount_center ± 50.
 *   date_center      Target ISO date. Must be accompanied by date_window.
 *   date_window      Half-window in days — e.g. 30 means ±30 days.
 *   limit            Max rows (1-50, default 20).
 *   offset           Row offset for pagination (default 0).
 */
export async function GET(request: Request) {
  const gate = gateAgentInbox()
  if (gate) return gate

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)
  const url = new URL(request.url)

  const search = url.searchParams.get('search')?.trim() ?? ''
  const amountCenterRaw = url.searchParams.get('amount_center')
  const amountWindowRaw = url.searchParams.get('amount_window')
  const dateCenterRaw = url.searchParams.get('date_center')
  const dateWindowRaw = url.searchParams.get('date_window')
  const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit')) || 20), 50)
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)

  let query = supabase
    .from('transactions')
    .select('id, date, description, amount, currency, merchant_name, category, is_business', { count: 'exact' })
    .eq('company_id', companyId)
    .is('journal_entry_id', null)
    .lt('amount', 0)
    .order('date', { ascending: false })
    .range(offset, offset + limit - 1)

  if (search.length > 0) {
    const escaped = search.replace(/[%_]/g, '\\$&')
    query = query.or(`description.ilike.%${escaped}%,merchant_name.ilike.%${escaped}%`)
  }

  if (amountCenterRaw && amountWindowRaw) {
    const center = Number(amountCenterRaw)
    const window = Math.abs(Number(amountWindowRaw))
    if (Number.isFinite(center) && Number.isFinite(window) && window > 0) {
      query = query.gte('amount', center - window).lte('amount', center + window)
    }
  }

  if (dateCenterRaw && dateWindowRaw) {
    const windowDays = Math.abs(Number(dateWindowRaw))
    if (Number.isFinite(windowDays) && windowDays > 0) {
      const center = new Date(dateCenterRaw)
      if (!Number.isNaN(center.getTime())) {
        const msPerDay = 86_400_000
        const from = new Date(center.getTime() - windowDays * msPerDay)
        const to = new Date(center.getTime() + windowDays * msPerDay)
        query = query.gte('date', from.toISOString().slice(0, 10))
        query = query.lte('date', to.toISOString().slice(0, 10))
      }
    }
  }

  const { data, error, count } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    data: {
      transactions: data ?? [],
      count: count ?? 0,
      limit,
      offset,
    },
  })
}
