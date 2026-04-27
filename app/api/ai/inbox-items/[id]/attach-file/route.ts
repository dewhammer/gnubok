import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { gateAgentInbox } from '@/lib/ai/feature-flag'
import type { InvoiceInboxItem } from '@/types'

ensureInitialized()

const MAX_BYTES = 15 * 1024 * 1024 // 15 MB — matches invoice-inbox workspace
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
])

/**
 * POST /api/ai/inbox-items/[id]/attach-file
 *
 * Attach a receipt image/PDF to an existing inbox item that was created
 * without a file (e.g. a row seeded for testing, or an email receipt where
 * the attachment was stripped). Stores the file in the WORM documents bucket
 * and links it via invoice_inbox_items.document_id. Does not re-run
 * classification — the extracted_data is left as-is.
 *
 * Only allowed when the inbox item currently has no document_id; we never
 * replace an existing attachment (WORM policy).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = gateAgentInbox()
  if (gate) return gate

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)
  const { id } = await params

  const { data: inboxRow } = await supabase
    .from('invoice_inbox_items')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle()

  if (!inboxRow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const inbox = inboxRow as InvoiceInboxItem

  if (inbox.document_id) {
    return NextResponse.json(
      { error: 'Kvittot har redan en bifogad fil.' },
      { status: 409 }
    )
  }

  // Parse multipart form-data.
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 })
  }

  const file = formData.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing file' }, { status: 400 })
  }

  if (file.size === 0) {
    return NextResponse.json({ error: 'Filen är tom.' }, { status: 400 })
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `Filen är för stor (max ${Math.round(MAX_BYTES / 1024 / 1024)} MB).` },
      { status: 413 }
    )
  }

  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json(
      { error: 'Filtypen stöds inte. Tillåtna: PDF, JPG, PNG, WebP.' },
      { status: 415 }
    )
  }

  const buffer = await file.arrayBuffer()

  let doc
  try {
    doc = await uploadDocument(
      supabase,
      user.id,
      companyId,
      { name: file.name, buffer, type: file.type },
      { upload_source: 'file_upload' }
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Kunde inte ladda upp filen.'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  const { error: linkError } = await supabase
    .from('invoice_inbox_items')
    .update({ document_id: doc.id })
    .eq('id', inbox.id)
    .eq('company_id', companyId)

  if (linkError) {
    return NextResponse.json({ error: linkError.message }, { status: 500 })
  }

  try {
    if (inbox.correlation_id) {
      await appendProcessingHistory({
        companyId,
        correlationId: inbox.correlation_id,
        aggregateType: 'Document',
        aggregateId: doc.id,
        eventType: 'ReceiptFileAttached',
        payload: {
          inbox_item_id: inbox.id,
          document_id: doc.id,
          file_name: file.name,
          mime_type: file.type,
          size_bytes: file.size,
        },
        actor: { type: 'user', id: user.id },
        occurredAt: new Date(),
      })
    }
  } catch (err) {
    console.error('[ai/inbox-items/attach-file] processing_history append failed:', err)
  }

  return NextResponse.json({
    data: {
      inbox_item_id: inbox.id,
      document_id: doc.id,
    },
  })
}
