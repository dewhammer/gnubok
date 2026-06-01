import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { recordateEntry } from '@/lib/core/bookkeeping/storno-service'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { RecordateJournalEntrySchema } from '@/lib/api/schemas'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'

ensureInitialized()

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const validation = await validateBody(request, RecordateJournalEntrySchema)
  if (!validation.success) return validation.response
  const body = validation.data

  try {
    const result = await recordateEntry(supabase, companyId, user.id, id, body.new_entry_date)
    return NextResponse.json({ data: result })
  } catch (err) {
    const typed = bookkeepingErrorResponse(err)
    if (typed) return typed
    // Not a recognized domain error — an unexpected server fault, not a client
    // error, so surface it as 500.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to move entry' },
      { status: 500 }
    )
  }
}
