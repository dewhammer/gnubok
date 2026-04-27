'use client'

import { useRef, useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { PageHeader } from '@/components/ui/page-header'
import { Upload, Receipt as ReceiptIcon, Loader2, FileText, AlertTriangle, RefreshCw, Pencil, ShieldCheck, ShieldAlert } from 'lucide-react'
import { formatCurrency, formatDate } from '@/lib/utils'
import ManualExtractDialog from './ManualExtractDialog'
import type { ReceiptRowWithPreview } from '@/app/(dashboard)/receipts/page'

const STATUS_LABELS: Record<string, string> = {
  pending: 'Väntar',
  processing: 'Bearbetar',
  ready: 'Klar',
  confirmed: 'Bokförd',
  rejected: 'Avvisad',
  error: 'Fel',
}

const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline'> = {
  pending: 'outline',
  processing: 'warning',
  ready: 'secondary',
  confirmed: 'success',
  rejected: 'outline',
  error: 'destructive',
}

const ALLOWED_MIME = 'application/pdf,image/jpeg,image/png,image/heic,image/heif,image/webp'

interface ExtractedReceiptShape {
  merchant?: { name?: string | null } | null
  receipt?: { date?: string | null; currency?: string | null } | null
  totals?: { total?: number | null } | null
  _verification?: {
    agrees?: boolean
    claude_total?: number | null
    ocr_total?: number | null
    delta?: number | null
    ocr_confidence?: number | null
  } | null
  _source?: 'ocr_only' | null
}

// Derive the verification state the UI should render.
//   - 'agreed'        Claude and Textract read the same total → green badge
//   - 'disagreed'     they disagree > 1 öre → yellow warning + numbers
//   - 'ocr-only'      Claude failed but Textract succeeded → neutral
//   - 'unverified'    Textract didn't run (HEIC, large file, no AWS perms)
//                     or agreement data is absent → show nothing
type VerificationState = 'agreed' | 'disagreed' | 'ocr-only' | 'unverified'

function getVerificationState(row: ReceiptRowWithPreview): VerificationState {
  const data = row.extracted_data as ExtractedReceiptShape | null
  if (!data) return 'unverified'
  if (data._source === 'ocr_only') return 'ocr-only'
  const v = data._verification
  if (!v || v.agrees == null) return 'unverified'
  return v.agrees ? 'agreed' : 'disagreed'
}

function summarize(row: ReceiptRowWithPreview): { merchant: string; total: number | null; currency: string; date: string | null } {
  const data = (row.extracted_data as ExtractedReceiptShape | null) ?? {}
  return {
    merchant: data.merchant?.name ?? row.document?.file_name ?? 'Okänt kvitto',
    total: data.totals?.total ?? null,
    currency: data.receipt?.currency ?? 'SEK',
    date: data.receipt?.date ?? null,
  }
}

// Mirror of the server-side needsRescan heuristic — a row looks stuck when
// extraction failed or the total we need to propose a match is missing.
// Server is still authoritative; this just gates UI affordances.
function rowNeedsRescan(row: ReceiptRowWithPreview): boolean {
  if (!row.document_id) return false // nothing to rescan without a file
  if (row.status === 'confirmed') return false
  if (row.status === 'error') return true
  const data = row.extracted_data as ExtractedReceiptShape | null
  if (!data) return true
  if (data.totals?.total == null) return true
  return false
}

// Thumbnail resolves to: image preview | PDF placeholder | missing-source warning.
// The last case is legally important (BFL 5 kap 7§) — a receipt without a
// source document cannot be booked, so we surface it visibly.
function Thumbnail({ row }: { row: ReceiptRowWithPreview }) {
  const mime = row.document?.mime_type ?? ''
  const isImage = mime.startsWith('image/') && !mime.includes('heic') && !mime.includes('heif')
  const isPdf = mime === 'application/pdf'

  if (!row.document) {
    return (
      <div className="w-20 h-20 rounded border border-warning/40 bg-warning/5 flex flex-col items-center justify-center shrink-0 text-warning-foreground">
        <AlertTriangle className="h-5 w-5" />
        <span className="text-[10px] mt-1 text-center leading-tight">Saknar bild</span>
      </div>
    )
  }
  if (isImage && row.preview_url) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={row.preview_url}
        alt={row.document.file_name ?? 'Kvitto'}
        className="w-20 h-20 rounded object-cover border bg-muted shrink-0"
        loading="lazy"
      />
    )
  }
  return (
    <div className="w-20 h-20 rounded border bg-muted flex items-center justify-center shrink-0">
      <FileText className="h-6 w-6 text-muted-foreground" />
      <span className="sr-only">{isPdf ? 'PDF' : 'Fil'}</span>
    </div>
  )
}

// Optimistic card shown while the upload request is in flight. Replaced by
// the persisted row on router.refresh(). Keeps the page from looking empty
// during the 5-10 s classify call.
function PendingUploadCard({ upload }: { upload: PendingUpload }) {
  return (
    <Card className="border-primary/20 bg-primary/[0.02]">
      <CardContent className="p-4">
        <div className="flex items-start gap-4">
          <div className="w-20 h-20 rounded border bg-muted flex items-center justify-center shrink-0">
            <Loader2 className="h-6 w-6 text-muted-foreground animate-spin" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <span className="font-medium truncate">{upload.file_name}</span>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant="warning" className="gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                AI läser kvittot…
              </Badge>
              <span className="text-xs text-muted-foreground">
                Det här brukar ta 5–10 sekunder.
              </span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function VerificationBadge({ row }: { row: ReceiptRowWithPreview }) {
  const state = getVerificationState(row)
  if (state === 'agreed') {
    return (
      <Badge variant="outline" className="border-success/40 text-success-foreground gap-1">
        <ShieldCheck className="h-3 w-3" />
        OCR verifierad
      </Badge>
    )
  }
  if (state === 'disagreed') {
    return (
      <Badge variant="outline" className="border-warning/40 text-warning-foreground gap-1">
        <ShieldAlert className="h-3 w-3" />
        Behöver granskning
      </Badge>
    )
  }
  if (state === 'ocr-only') {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        Endast OCR
      </Badge>
    )
  }
  return null
}

// When Claude and Textract disagree on the total, show the raw numbers so
// the user can see which read to trust before accepting downstream.
function DisagreementDetail({ row }: { row: ReceiptRowWithPreview }) {
  const data = row.extracted_data as ExtractedReceiptShape | null
  const v = data?._verification
  if (!v || v.agrees !== false) return null
  const currency = data?.receipt?.currency ?? 'SEK'
  return (
    <p className="text-xs text-warning-foreground mt-2">
      AI läste {v.claude_total != null ? formatCurrency(v.claude_total, currency) : '—'}, OCR läste{' '}
      {v.ocr_total != null ? formatCurrency(v.ocr_total, currency) : '—'}. Granska bilden innan du godkänner.
    </p>
  )
}

// Optimistic placeholder shown in the list while a manual upload is in
// flight. The upload handler is synchronous (classify + store + insert
// happen before the response returns), so a 5-10 s gap otherwise leaves the
// user staring at nothing. We insert a fake row here so the UI shows a real
// card immediately and router.refresh() replaces it with the persisted row.
interface PendingUpload {
  key: string
  file_name: string
  size_bytes: number
  mime_type: string
}

export default function ReceiptsList({ initialItems }: { initialItems: ReceiptRowWithPreview[] }) {
  const [items, setItems] = useState(initialItems)
  const [uploading, setUploading] = useState(false)
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([])
  const [batchScanning, setBatchScanning] = useState(false)
  const [rescanId, setRescanId] = useState<string | null>(null)
  const [attachingId, setAttachingId] = useState<string | null>(null)
  const [manualRow, setManualRow] = useState<ReceiptRowWithPreview | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const attachInputRef = useRef<HTMLInputElement>(null)
  const attachTargetRef = useRef<string | null>(null)
  const { toast } = useToast()
  const router = useRouter()

  useEffect(() => { setItems(initialItems) }, [initialItems])

  // Count of rows eligible for rescan — drives the "Skanna oskannade (N)" CTA.
  const rescanCount = useMemo(() => items.filter(rowNeedsRescan).length, [items])

  const handlePickFile = () => fileInputRef.current?.click()

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    const pending: PendingUpload = {
      key: `pending-${Date.now()}-${file.name}`,
      file_name: file.name,
      size_bytes: file.size,
      mime_type: file.type,
    }
    setPendingUploads((p) => [pending, ...p])
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/extensions/ext/invoice-inbox/upload', {
        method: 'POST',
        body: form,
      })
      const body = await res.json()
      if (!res.ok) {
        toast({ title: 'Uppladdning misslyckades', description: body.error, variant: 'destructive' })
        return
      }
      toast({ title: 'Kvitto sparat' })
      router.refresh()
    } catch (err) {
      toast({
        title: 'Fel',
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      })
    } finally {
      // Drop the placeholder on both success and failure. On success the
      // real row arrives via router.refresh(); on failure the user gets a
      // toast and an empty list state instead of a stuck "AI läser..." card.
      setPendingUploads((p) => p.filter((x) => x.key !== pending.key))
      setUploading(false)
    }
  }

  const handleRescanOne = async (row: ReceiptRowWithPreview) => {
    setRescanId(row.id)
    try {
      const res = await fetch('/api/extensions/ext/invoice-inbox/rescan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inbox_item_ids: [row.id] }),
      })
      const body = await res.json()
      if (!res.ok) {
        toast({ title: 'Skanning misslyckades', description: body.error, variant: 'destructive' })
        return
      }
      const outcome = body.data.outcomes?.[0]
      if (outcome?.ok) {
        toast({ title: 'Skanning klar' })
      } else {
        toast({ title: 'Skanning misslyckades', description: outcome?.error, variant: 'destructive' })
      }
      router.refresh()
    } finally {
      setRescanId(null)
    }
  }

  const handlePickAttachFile = (rowId: string) => {
    attachTargetRef.current = rowId
    attachInputRef.current?.click()
  }

  const handleAttachFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    const rowId = attachTargetRef.current
    e.target.value = ''
    attachTargetRef.current = null
    if (!file || !rowId) return

    setAttachingId(rowId)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(`/api/extensions/ext/invoice-inbox/items/${rowId}/attach-document`, {
        method: 'POST',
        body: form,
      })
      const body = await res.json()
      if (!res.ok) {
        toast({ title: 'Kunde inte koppla bild', description: body.error, variant: 'destructive' })
        return
      }
      toast({
        title: 'Bild kopplad',
        description: body.data.classified ? 'Bearbetar siffrorna…' : 'Kunde inte läsa siffror — skanna igen eller skriv in själv.',
      })
      router.refresh()
    } finally {
      setAttachingId(null)
    }
  }

  const handleBatchRescan = async () => {
    if (rescanCount === 0) return
    setBatchScanning(true)
    try {
      const res = await fetch('/api/extensions/ext/invoice-inbox/rescan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const body = await res.json()
      if (!res.ok) {
        toast({ title: 'Batch-skanning misslyckades', description: body.error, variant: 'destructive' })
        return
      }
      const { rescanned, failed } = body.data
      toast({
        title: `${rescanned} skannade${failed > 0 ? `, ${failed} misslyckades` : ''}`,
      })
      router.refresh()
    } finally {
      setBatchScanning(false)
    }
  }

  return (
    <div className="container mx-auto p-4 sm:p-8 max-w-5xl">
      <PageHeader
        title="Kvitton"
        description="Ladda upp kvitton. AI klassificerar och matchar mot banktransaktioner."
        action={
          <div className="flex gap-2 flex-wrap">
            {rescanCount > 0 && (
              <Button variant="outline" onClick={handleBatchRescan} disabled={batchScanning}>
                {batchScanning ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Skannar…
                  </>
                ) : (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Skanna oskannade ({rescanCount})
                  </>
                )}
              </Button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept={ALLOWED_MIME}
              onChange={handleUpload}
            />
            <Button onClick={handlePickFile} disabled={uploading}>
              {uploading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Laddar upp…
                </>
              ) : (
                <>
                  <Upload className="mr-2 h-4 w-4" />
                  Ladda upp kvitto
                </>
              )}
            </Button>
          </div>
        }
      />

      {items.length === 0 && pendingUploads.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="p-5 rounded-full bg-muted mb-6">
              <ReceiptIcon className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium mb-2">Inga kvitton än</h3>
            <p className="text-sm text-muted-foreground text-center max-w-sm">
              Ladda upp ett kvitto (PDF, JPG, PNG, HEIC eller WebP) så tar AI hand om resten.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {pendingUploads.map((upload) => (
            <PendingUploadCard key={upload.key} upload={upload} />
          ))}
          {items.map((row) => {
            const s = summarize(row)
            const statusKey = row.status ?? 'pending'
            const canRescan = rowNeedsRescan(row)
            const isRescanning = rescanId === row.id
            const needsImage = !row.document_id && row.status !== 'confirmed'
            const isAttaching = attachingId === row.id
            return (
              <Card key={row.id}>
                <CardContent className="p-4">
                  <div className="flex items-start gap-4">
                    <Thumbnail row={row} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between gap-3 flex-wrap">
                        <span className="font-medium truncate">{s.merchant}</span>
                        {s.total != null && (
                          <span className="tabular-nums font-medium">
                            {formatCurrency(s.total, s.currency)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <Badge variant={STATUS_VARIANTS[statusKey] ?? 'outline'} className="gap-1.5">
                          {(statusKey === 'processing' || statusKey === 'pending') && (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          )}
                          {STATUS_LABELS[statusKey] ?? statusKey}
                        </Badge>
                        <VerificationBadge row={row} />
                        {s.date && (
                          <span className="text-xs text-muted-foreground">
                            {formatDate(s.date)}
                          </span>
                        )}
                        {row.document?.file_name && (
                          <span className="text-xs text-muted-foreground truncate">
                            · {row.document.file_name}
                          </span>
                        )}
                        {row.source === 'email' && (
                          <span className="text-xs text-muted-foreground">· via e-post</span>
                        )}
                      </div>
                      {row.error_message && (
                        <p className="text-xs text-destructive mt-1">{row.error_message}</p>
                      )}
                      <DisagreementDetail row={row} />

                      {needsImage && (
                        <div className="flex gap-2 mt-3">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handlePickAttachFile(row.id)}
                            disabled={isAttaching}
                          >
                            {isAttaching ? (
                              <>
                                <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                                Laddar upp…
                              </>
                            ) : (
                              <>
                                <Upload className="mr-2 h-3 w-3" />
                                Ladda upp bild
                              </>
                            )}
                          </Button>
                        </div>
                      )}
                      {!needsImage && canRescan && (
                        <div className="flex gap-2 mt-3">
                          <Button size="sm" variant="outline" onClick={() => handleRescanOne(row)} disabled={isRescanning}>
                            {isRescanning ? (
                              <>
                                <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                                Skannar…
                              </>
                            ) : (
                              <>
                                <RefreshCw className="mr-2 h-3 w-3" />
                                Skanna igen
                              </>
                            )}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setManualRow(row)}>
                            <Pencil className="mr-2 h-3 w-3" />
                            Skriv in själv
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <input
        ref={attachInputRef}
        type="file"
        className="hidden"
        accept={ALLOWED_MIME}
        onChange={handleAttachFile}
      />

      {manualRow && (
        <ManualExtractDialog
          row={manualRow}
          onClose={() => setManualRow(null)}
          onSaved={() => {
            setManualRow(null)
            router.refresh()
          }}
        />
      )}
    </div>
  )
}
