import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

ensureInitialized()

/**
 * POST /api/documents/[id]/link — link a document to a journal entry.
 *
 * Body: { journal_entry_id: string, journal_entry_line_id?: string }
 */
export const POST = withRouteContext(
  'document.link',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ documentId: id })

    const body = await request.json().catch(() => ({}))

    if (!body.journal_entry_id) {
      return errorResponseFromCode('VALIDATION_ERROR', opLog, {
        requestId,
        details: { field: 'journal_entry_id', reason: 'required' },
      })
    }

    try {
      const document = await linkToJournalEntry(
        supabase,
        companyId!,
        id,
        body.journal_entry_id,
        body.journal_entry_line_id,
      )
      return NextResponse.json({ data: document })
    } catch (err) {
      opLog.error('document link failed', err as Error, {
        journalEntryId: body.journal_entry_id,
      })
      const message = err instanceof Error ? err.message : ''
      if (/journal entry not found/i.test(message)) {
        return errorResponseFromCode('DOC_LINK_ENTRY_NOT_FOUND', opLog, { requestId })
      }
      if (/already linked/i.test(message)) {
        return errorResponseFromCode('DOC_LINK_ALREADY_LINKED', opLog, { requestId })
      }
      return errorResponseFromCode('DOC_LINK_FAILED', opLog, {
        requestId,
        details: { reason: message || 'unknown' },
      })
    }
  },
  { requireWrite: true },
)
