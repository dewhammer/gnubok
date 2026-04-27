'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, ExternalLink, FileText, Upload, ImagePlus, MailPlus } from 'lucide-react'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { AgentInboxItemView } from '@/app/(dashboard)/agent-inbox/page'
import { assessReceiptQuality } from './receipt-quality'

// Mirrors ReceiptExtractionResult, kept local + forgiving since legacy rows
// may be sparse.
interface ExtractedReceipt {
  merchant?: {
    name?: string | null
    orgNumber?: string | null
    vatNumber?: string | null
    isForeign?: boolean
  } | null
  receipt?: {
    date?: string | null
    time?: string | null
    currency?: string | null
  } | null
  totals?: {
    subtotal?: number | null
    vatAmount?: number | null
    total?: number | null
  } | null
  lineItems?: Array<{
    description?: string
    quantity?: number
    unitPrice?: number | null
    lineTotal?: number
    vatRate?: number | null
  }> | null
  flags?: {
    isRestaurant?: boolean
    isSystembolaget?: boolean
    isForeignMerchant?: boolean
  } | null
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  inbox: AgentInboxItemView['inbox_item']
}

export default function ReceiptDetailDialog({ open, onOpenChange, inbox }: Props) {
  const data = (inbox.extracted_data as ExtractedReceipt | null) ?? {}
  const merchant = data.merchant?.name ?? inbox.document?.file_name ?? 'Okänt kvitto'
  const currency = data.receipt?.currency ?? 'SEK'
  const lineItems = data.lineItems ?? []
  const flags = data.flags ?? {}

  // Lazily fetch a signed download URL so we can preview the file.
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)
  const [loadingUrl, setLoadingUrl] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [requesting, setRequesting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const router = useRouter()
  const { toast } = useToast()
  const quality = assessReceiptQuality(inbox)

  useEffect(() => {
    if (!open || !inbox.document?.id || downloadUrl) return
    setLoadingUrl(true)
    fetch(`/api/documents/${inbox.document.id}`)
      .then((r) => r.json())
      .then((body) => {
        if (body?.data?.download_url) setDownloadUrl(body.data.download_url)
      })
      .catch(() => { /* fall back to no preview */ })
      .finally(() => setLoadingUrl(false))
  }, [open, inbox.document?.id, downloadUrl])

  const mime = inbox.document?.mime_type ?? null
  const isImage = mime?.startsWith('image/') ?? false
  const isPdf = mime === 'application/pdf'

  const handleFilePicked = async (file: File) => {
    setUploading(true)
    setUploadError(null)
    try {
      const body = new FormData()
      body.append('file', file)
      const res = await fetch(`/api/ai/inbox-items/${inbox.id}/attach-file`, {
        method: 'POST',
        body,
      })
      const json = await res.json()
      if (!res.ok) {
        setUploadError(json?.error ?? 'Kunde inte ladda upp filen.')
        setUploading(false)
        return
      }
      toast({ title: 'Kvittobild uppladdad' })
      // Force the server component to re-run so the new inbox.document
      // propagates into the card + modal.
      router.refresh()
      onOpenChange(false)
    } catch {
      setUploadError('Nätverksfel.')
    } finally {
      setUploading(false)
    }
  }

  const handleRequestReceipt = async () => {
    setRequesting(true)
    try {
      const res = await fetch(`/api/ai/inbox-items/${inbox.id}/request-receipt`, {
        method: 'POST',
      })
      const body = await res.json()
      if (!res.ok) {
        toast({
          title: 'Kunde inte skicka begäran',
          description: body?.error ?? 'Försök igen.',
          variant: 'destructive',
        })
        setRequesting(false)
        return
      }
      toast({
        title: 'Begäran skickad',
        description: `Mejl skickat till ${body.data.sent} av ${body.data.total} medlemmar.`,
      })
    } catch {
      toast({
        title: 'Nätverksfel',
        variant: 'destructive',
      })
    } finally {
      setRequesting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {merchant}
          </DialogTitle>
          <DialogDescription>
            {data.receipt?.date ? formatDate(data.receipt.date) : 'Okänt datum'}
            {data.receipt?.time && ` · ${data.receipt.time}`}
            {data.totals?.total != null && (
              <span> · {formatCurrency(data.totals.total, currency)}</span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* File preview */}
          <section className="min-h-[280px] bg-muted/40 rounded border flex items-center justify-center overflow-hidden">
            {!inbox.document ? (
              <div className="flex flex-col items-center gap-3 p-6 text-center">
                <div className="p-3 rounded-full bg-muted">
                  <ImagePlus className="h-6 w-6 text-muted-foreground" />
                </div>
                <div>
                  <h3 className="text-sm font-medium">Ingen kvittobild</h3>
                  <p className="text-xs text-muted-foreground mt-1 max-w-[240px]">
                    Utan bildbevis kan bokföringen inte verifieras. Ladda upp kvittot (PDF, JPG, PNG, WebP — max 15 MB).
                  </p>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,.webp"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) handleFilePicked(f)
                    e.target.value = ''
                  }}
                />
                <div className="flex flex-col gap-2 w-full max-w-[240px]">
                  <Button
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading || requesting}
                  >
                    {uploading ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                        Laddar upp…
                      </>
                    ) : (
                      <>
                        <Upload className="h-3.5 w-3.5 mr-2" />
                        Ladda upp kvittobild
                      </>
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleRequestReceipt}
                    disabled={uploading || requesting}
                  >
                    {requesting ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                        Skickar…
                      </>
                    ) : (
                      <>
                        <MailPlus className="h-3.5 w-3.5 mr-2" />
                        Begär kvitto från teamet
                      </>
                    )}
                  </Button>
                </div>
                {uploadError && (
                  <p className="text-xs text-destructive">{uploadError}</p>
                )}
              </div>
            ) : loadingUrl ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            ) : !downloadUrl ? (
              <div className="text-sm text-muted-foreground text-center p-6">
                Kunde inte ladda filen
              </div>
            ) : isImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={downloadUrl}
                alt={inbox.document.file_name}
                className="max-w-full max-h-[60vh] object-contain"
              />
            ) : isPdf ? (
              <iframe
                src={downloadUrl}
                title={inbox.document.file_name}
                className="w-full h-[60vh]"
              />
            ) : (
              <div className="flex flex-col items-center gap-2 p-6">
                <FileText className="h-10 w-10 text-muted-foreground" />
                <span className="text-sm">{inbox.document.file_name}</span>
                <Button size="sm" variant="outline" asChild>
                  <a href={downloadUrl} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-3.5 w-3.5 mr-2" />
                    Öppna fil
                  </a>
                </Button>
              </div>
            )}
          </section>

          {/* Extracted data */}
          <section className="space-y-4 text-sm">
            {/* Quality warning — shown when a file exists but the data is weak */}
            {inbox.document && !quality.ok && (
              <div className="rounded border border-warning/50 bg-warning/5 p-3">
                <p className="text-sm font-medium mb-1">Kvittot verkar otydligt</p>
                <p className="text-xs text-muted-foreground mb-2">
                  {quality.message} Be teamet skicka en tydligare bild för att kunna bokföra säkert.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleRequestReceipt}
                  disabled={requesting}
                >
                  {requesting ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                      Skickar…
                    </>
                  ) : (
                    <>
                      <MailPlus className="h-3.5 w-3.5 mr-2" />
                      Begär nytt kvitto
                    </>
                  )}
                </Button>
              </div>
            )}

            {/* Merchant */}
            <div>
              <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">
                Handlare
              </h3>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Namn</dt>
                <dd>{data.merchant?.name ?? '—'}</dd>
                {data.merchant?.orgNumber && (
                  <>
                    <dt className="text-muted-foreground">Org.nr</dt>
                    <dd className="font-mono">{data.merchant.orgNumber}</dd>
                  </>
                )}
                {data.merchant?.vatNumber && (
                  <>
                    <dt className="text-muted-foreground">VAT-nr</dt>
                    <dd className="font-mono">{data.merchant.vatNumber}</dd>
                  </>
                )}
                {(flags.isRestaurant || flags.isSystembolaget || flags.isForeignMerchant) && (
                  <>
                    <dt className="text-muted-foreground">Flagga</dt>
                    <dd className="flex flex-wrap gap-1">
                      {flags.isRestaurant && <Badge variant="outline" className="text-xs">Restaurang</Badge>}
                      {flags.isSystembolaget && <Badge variant="outline" className="text-xs">Systembolaget</Badge>}
                      {flags.isForeignMerchant && <Badge variant="outline" className="text-xs">Utländsk handlare</Badge>}
                    </dd>
                  </>
                )}
              </dl>
            </div>

            {/* Totals */}
            {(data.totals?.subtotal != null || data.totals?.total != null) && (
              <div>
                <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">
                  Belopp
                </h3>
                <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
                  {data.totals?.subtotal != null && (
                    <>
                      <dt className="text-muted-foreground">Netto</dt>
                      <dd className="tabular-nums">{formatCurrency(data.totals.subtotal, currency)}</dd>
                    </>
                  )}
                  {data.totals?.vatAmount != null && data.totals.vatAmount > 0 && (
                    <>
                      <dt className="text-muted-foreground">Moms</dt>
                      <dd className="tabular-nums">{formatCurrency(data.totals.vatAmount, currency)}</dd>
                    </>
                  )}
                  {data.totals?.total != null && (
                    <>
                      <dt className="text-muted-foreground">Totalt</dt>
                      <dd className="tabular-nums font-medium">{formatCurrency(data.totals.total, currency)}</dd>
                    </>
                  )}
                </dl>
              </div>
            )}

            {/* Line items */}
            {lineItems.length > 0 && (
              <div>
                <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">
                  Rader ({lineItems.length})
                </h3>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="text-left font-normal pb-1">Beskrivning</th>
                      <th className="text-right font-normal pb-1">Antal</th>
                      <th className="text-right font-normal pb-1">Moms</th>
                      <th className="text-right font-normal pb-1">Summa</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lineItems.map((li, i) => (
                      <tr key={i} className="border-t border-border/40">
                        <td className="py-1">{li.description ?? 'Rad'}</td>
                        <td className="py-1 text-right tabular-nums">
                          {li.quantity ?? '—'}
                        </td>
                        <td className="py-1 text-right tabular-nums text-muted-foreground">
                          {li.vatRate != null ? `${li.vatRate}%` : '—'}
                        </td>
                        <td className="py-1 text-right tabular-nums">
                          {li.lineTotal != null ? formatCurrency(li.lineTotal, currency) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Meta */}
            <div className="pt-2 border-t text-xs text-muted-foreground space-y-0.5">
              <div>Källa: {inbox.source}{inbox.email_from ? ` (${inbox.email_from})` : ''}</div>
              {inbox.confidence != null && (
                <div>Extraktionskonfidens: {Math.round(Number(inbox.confidence) * 100)}%</div>
              )}
              {inbox.document?.file_name && (
                <div>Fil: {inbox.document.file_name}</div>
              )}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
