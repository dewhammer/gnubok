import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ensureInitialized } from '@/lib/init'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { requireCompanyId } from '@/lib/company/context'
import ReceiptsList from '@/components/receipts/ReceiptsList'
import type { InvoiceInboxItem, DocumentAttachment } from '@/types'

ensureInitialized()

export type ReceiptRow = InvoiceInboxItem & { document: DocumentAttachment | null }
export type ReceiptRowWithPreview = ReceiptRow & { preview_url: string | null }

export default async function ReceiptsPage() {
  // Hard gate: if the invoice-inbox extension isn't loaded, there's no
  // upload pipeline and nothing would work here.
  if (!ENABLED_EXTENSION_IDS.has('invoice-inbox')) notFound()

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const companyId = await requireCompanyId(supabase, user.id)

  const { data } = await supabase
    .from('invoice_inbox_items')
    .select('*, document:document_attachments!document_id(*)')
    .eq('company_id', companyId)
    .eq('document_type', 'receipt')
    .order('created_at', { ascending: false })
    .limit(200)

  const rows = (data ?? []) as ReceiptRow[]

  // Batch-sign all document paths so each row renders with a thumbnail.
  // Supabase exposes createSignedUrls (plural) for exactly this use case.
  const paths = rows
    .map((r) => r.document?.storage_path)
    .filter((p): p is string => Boolean(p))

  const urlByPath = new Map<string, string>()
  if (paths.length > 0) {
    const { data: signed } = await supabase.storage
      .from('documents')
      .createSignedUrls(paths, 3600)
    for (const entry of signed ?? []) {
      if (entry.path && entry.signedUrl) urlByPath.set(entry.path, entry.signedUrl)
    }
  }

  const items = rows.map((row) => ({
    ...row,
    preview_url: row.document?.storage_path
      ? urlByPath.get(row.document.storage_path) ?? null
      : null,
  }))

  return <ReceiptsList initialItems={items} />
}
