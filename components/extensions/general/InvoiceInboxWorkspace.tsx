'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import {
  Inbox,
  Upload,
  Mail,
  FileText,
  Copy,
  RotateCcw,
  Trash2,
  Check,
  Loader2,
  AlertTriangle,
  ArrowRight,
  Plus,
} from 'lucide-react'
import Link from 'next/link'
import { cn, formatCurrency } from '@/lib/utils'
import type { WorkspaceComponentProps } from '@/lib/extensions/workspace-registry'
import type { InvoiceExtractionResult } from '@/types'

// ── Types ────────────────────────────────────────────────────

interface InboxItem {
  id: string
  status: 'received' | 'error'
  source: 'email' | 'upload'
  created_at: string
  email_from: string | null
  email_subject: string | null
  email_received_at: string | null
  document_id: string | null
  extracted_data: InvoiceExtractionResult | null
  matched_supplier_id: string | null
  created_supplier_invoice_id: string | null
  error_message: string | null
}

interface InboxAddress {
  address: string
  local_part: string
  status: string
}

// ── Helpers ──────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'nyss'
  if (min < 60) return `${min} min sedan`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h sedan`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} d sedan`
  return new Date(iso).toLocaleDateString('sv-SE')
}

function pickAmount(item: InboxItem): number | null {
  return item.extracted_data?.totals?.total ?? null
}

function pickCurrency(item: InboxItem): string {
  return item.extracted_data?.invoice?.currency ?? 'SEK'
}

function pickSupplierName(item: InboxItem): string | null {
  return item.extracted_data?.supplier?.name ?? null
}

// ── Skeleton ─────────────────────────────────────────────────

function WorkspaceSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-10 w-full" />
      <div className="grid grid-cols-[280px_minmax(0,1fr)_320px] gap-4 h-[calc(100vh-12rem)]">
        <Skeleton className="h-full" />
        <Skeleton className="h-full" />
        <Skeleton className="h-full" />
      </div>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────

export default function InvoiceInboxWorkspace(_props: WorkspaceComponentProps) {
  const { toast } = useToast()
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const [items, setItems] = useState<InboxItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<InboxItem | null>(null)
  const [docUrl, setDocUrl] = useState<string | null>(null)
  const [docMime, setDocMime] = useState<string | null>(null)
  const [inboxAddress, setInboxAddress] = useState<InboxAddress | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isRotating, setIsRotating] = useState(false)
  const [isDragging, setIsDragging] = useState(false)

  // ── Data loading ───────────────────────────────────────────

  const fetchItems = useCallback(async () => {
    try {
      const res = await fetch('/api/extensions/ext/invoice-inbox/items?limit=50')
      const json = await res.json()
      if (res.ok) setItems(json.data?.items ?? [])
    } catch (err) {
      console.error('[invoice-inbox] fetchItems failed:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  const fetchInboxAddress = useCallback(async () => {
    try {
      const res = await fetch('/api/extensions/ext/invoice-inbox/inbox/address')
      if (res.ok) {
        const { data } = await res.json()
        setInboxAddress(data)
      }
    } catch {
      // 404 / 503 are expected when no address provisioned yet
    }
  }, [])

  useEffect(() => {
    fetchItems()
    fetchInboxAddress()
  }, [fetchItems, fetchInboxAddress])

  // ── Selection ──────────────────────────────────────────────

  const handleSelect = useCallback(async (id: string) => {
    setSelectedId(id)
    setSelected(null)
    setDocUrl(null)
    setDocMime(null)

    try {
      const res = await fetch(`/api/extensions/ext/invoice-inbox/items/${id}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Kunde inte hämta posten')
      const item = json.data as InboxItem
      setSelected(item)

      if (item.document_id) {
        try {
          const docRes = await fetch(`/api/documents/${item.document_id}`)
          if (docRes.ok) {
            const { data } = await docRes.json()
            setDocUrl(data.download_url ?? null)
            setDocMime(data.mime_type ?? null)
          }
        } catch {
          // Preview is optional
        }
      }
    } catch (err) {
      toast({
        title: 'Kunde inte ladda dokumentet',
        description: err instanceof Error ? err.message : 'Försök igen.',
        variant: 'destructive',
      })
    }
  }, [toast])

  // ── Upload ─────────────────────────────────────────────────

  const uploadFile = useCallback(async (file: File) => {
    setIsUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/extensions/ext/invoice-inbox/upload', {
        method: 'POST',
        body: fd,
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Uppladdning misslyckades')
      toast({ title: 'Dokument uppladdat', description: file.name })
      await fetchItems()
      if (json.data?.inbox_item_id) {
        await handleSelect(json.data.inbox_item_id)
      }
    } catch (err) {
      toast({
        title: 'Uppladdning misslyckades',
        description: err instanceof Error ? err.message : 'Försök igen.',
        variant: 'destructive',
      })
    } finally {
      setIsUploading(false)
    }
  }, [fetchItems, handleSelect, toast])

  const handleFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) await uploadFile(file)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [uploadFile])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) await uploadFile(file)
  }, [uploadFile])

  // ── Delete ─────────────────────────────────────────────────

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm('Ta bort dokumentet ur inkorgen?')) return
    setIsDeleting(true)
    try {
      const res = await fetch(`/api/extensions/ext/invoice-inbox/items/${id}`, {
        method: 'DELETE',
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Kunde inte ta bort')
      toast({ title: 'Borttagen' })
      if (selectedId === id) {
        setSelectedId(null)
        setSelected(null)
      }
      await fetchItems()
    } catch (err) {
      toast({
        title: 'Kunde inte ta bort',
        description: err instanceof Error ? err.message : 'Försök igen.',
        variant: 'destructive',
      })
    } finally {
      setIsDeleting(false)
    }
  }, [fetchItems, selectedId, toast])

  // ── Inbox address ──────────────────────────────────────────

  const handleCopyAddress = useCallback(() => {
    if (!inboxAddress) return
    navigator.clipboard.writeText(inboxAddress.address).catch(() => {})
    toast({ title: 'Adress kopierad' })
  }, [inboxAddress, toast])

  const handleRotateAddress = useCallback(async () => {
    if (inboxAddress && !confirm('Skapa en ny inkorgsadress? Den gamla slutar att fungera.')) return
    setIsRotating(true)
    try {
      const res = await fetch('/api/extensions/ext/invoice-inbox/inbox/rotate', {
        method: 'POST',
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Rotation misslyckades')
      setInboxAddress(json.data)
      toast({ title: 'Ny adress skapad', description: json.data.address })
    } catch (err) {
      toast({
        title: 'Rotation misslyckades',
        description: err instanceof Error ? err.message : 'Försök igen.',
        variant: 'destructive',
      })
    } finally {
      setIsRotating(false)
    }
  }, [toast, inboxAddress])

  // ── Render ─────────────────────────────────────────────────

  if (isLoading) return <WorkspaceSkeleton />

  return (
    <div
      className="h-[calc(100vh-1px)] p-4 md:p-6"
      onDragOver={(e) => { e.preventDefault(); if (!isDragging) setIsDragging(true) }}
      onDragLeave={(e) => {
        // only clear when leaving the workspace itself, not children
        if (e.currentTarget === e.target) setIsDragging(false)
      }}
      onDrop={handleDrop}
    >
    <div className="h-full flex flex-col rounded-lg border bg-card overflow-hidden shadow-sm">
      {/* Top bar */}
      <header className="flex items-center justify-between gap-4 border-b px-4 py-2.5 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Inbox className="h-4 w-4 text-muted-foreground shrink-0" />
          <h1 className="font-medium text-sm shrink-0">Dokumentinkorg</h1>
          {inboxAddress ? (
            <>
              <span className="text-muted-foreground text-xs shrink-0">·</span>
              <code className="font-mono text-xs text-muted-foreground truncate min-w-0">
                {inboxAddress.address}
              </code>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground shrink-0"
                onClick={handleCopyAddress}
                title="Kopiera adress"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground shrink-0"
                onClick={handleRotateAddress}
                disabled={isRotating}
                title="Rotera till ny adress"
              >
                {isRotating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5" />
                )}
              </button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRotateAddress}
              disabled={isRotating}
              className="ml-2 shrink-0 h-7 text-xs"
            >
              {isRotating ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Mail className="h-3.5 w-3.5 mr-1.5" />
              )}
              Aktivera inkorgsadress
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/heic,image/heif,image/webp"
            className="hidden"
            onChange={handleFileInputChange}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
          >
            {isUploading ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5 mr-1.5" />
            )}
            Ladda upp
          </Button>
        </div>
      </header>

      {/* Three-pane body */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)_340px] min-h-0">
        {/* List */}
        <aside className="border-r overflow-y-auto bg-muted/20 pt-4">
          {items.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              <Inbox className="h-6 w-6 mx-auto mb-2 opacity-50" />
              Inkorgen är tom.
            </div>
          ) : (
            <ul>
              {items.map((item) => (
                <InboxRow
                  key={item.id}
                  item={item}
                  selected={item.id === selectedId}
                  onClick={() => handleSelect(item.id)}
                />
              ))}
            </ul>
          )}
        </aside>

        {/* Document preview (hero) */}
        <main className="overflow-hidden bg-muted/10 relative">
          {selected ? (
            <DocumentPreview docUrl={docUrl} docMime={docMime} />
          ) : (
            <EmptyPreview
              onUploadClick={() => fileInputRef.current?.click()}
              onActivateInbox={inboxAddress ? null : handleRotateAddress}
              isActivating={isRotating}
            />
          )}
          {isDragging && (
            <div className="absolute inset-0 bg-primary/5 border-2 border-dashed border-primary rounded-md m-4 flex items-center justify-center pointer-events-none">
              <p className="text-sm font-medium text-primary">Släpp filen för att ladda upp</p>
            </div>
          )}
        </main>

        {/* Fields rail */}
        <aside className="border-l overflow-y-auto pt-4">
          {selected ? (
            <FieldsRail
              item={selected}
              onDelete={() => handleDelete(selected.id)}
              isDeleting={isDeleting}
            />
          ) : (
            <div className="p-6 text-center text-sm text-muted-foreground">
              Välj en post för att se extraherade fält.
            </div>
          )}
        </aside>
      </div>
    </div>
    </div>
  )
}

// ── List row ─────────────────────────────────────────────────

function InboxRow({
  item,
  selected,
  onClick,
}: {
  item: InboxItem
  selected: boolean
  onClick: () => void
}) {
  const amount = pickAmount(item)
  const supplierName = pickSupplierName(item)
  const isErrored = item.status === 'error'
  const isProcessed = !!item.created_supplier_invoice_id

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'w-full text-left px-3 py-2 border-b transition-colors flex flex-col gap-0.5',
          selected ? 'bg-background border-l-2 border-l-primary' : 'hover:bg-background',
          isErrored && !selected && 'bg-destructive/[0.03]'
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          {item.source === 'email' ? (
            <Mail className="h-3 w-3 text-muted-foreground shrink-0" />
          ) : (
            <Upload className="h-3 w-3 text-muted-foreground shrink-0" />
          )}
          <span className="text-sm font-medium truncate flex-1 min-w-0">
            {supplierName ?? item.email_subject ?? 'Okänt dokument'}
          </span>
          {isErrored && (
            <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />
          )}
          {isProcessed && (
            <Check className="h-3 w-3 text-emerald-600 shrink-0" />
          )}
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="truncate">{timeAgo(item.email_received_at ?? item.created_at)}</span>
          {amount != null && (
            <span className="tabular-nums shrink-0">
              {formatCurrency(amount, pickCurrency(item))}
            </span>
          )}
        </div>
      </button>
    </li>
  )
}

// ── Document preview pane ────────────────────────────────────

function DocumentPreview({
  docUrl,
  docMime,
}: {
  docUrl: string | null
  docMime: string | null
}) {
  if (!docUrl) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        <FileText className="h-5 w-5 mr-2" />
        Inget underlag bifogat
      </div>
    )
  }
  return (
    <div className="h-full w-full p-4 flex items-start justify-center overflow-hidden">
      {docMime?.startsWith('image/') ? (
        // Image: frame hugs the image, capped at the parent's visible box.
        <div className="max-h-full max-w-3xl bg-background rounded-md border shadow-sm overflow-hidden flex">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={docUrl}
            alt="Underlag"
            className="block max-h-[calc(100vh-9rem)] max-w-full w-auto h-auto object-contain"
          />
        </div>
      ) : (
        // PDF: iframe needs explicit height — frame fills the available pane.
        <div className="h-full w-full max-w-3xl bg-background rounded-md border shadow-sm overflow-hidden">
          <iframe src={docUrl} className="w-full h-full border-0" title="Underlag" />
        </div>
      )}
    </div>
  )
}

// ── Empty preview state ──────────────────────────────────────

function EmptyPreview({
  onUploadClick,
  onActivateInbox,
  isActivating,
}: {
  onUploadClick: () => void
  onActivateInbox: (() => void) | null
  isActivating: boolean
}) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-6 gap-3">
      <Inbox className="h-10 w-10 text-muted-foreground/40" />
      <div>
        <p className="text-sm font-medium">
          {onActivateInbox ? 'Aktivera din inkorgsadress' : 'Välj ett dokument från listan'}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {onActivateInbox
            ? 'Ditt bolag får en unik e-postadress som leverantörer kan skicka fakturor till.'
            : 'Eller dra och släpp en fil var som helst på sidan för att ladda upp.'}
        </p>
      </div>
      <div className="flex gap-2">
        {onActivateInbox && (
          <Button size="sm" onClick={onActivateInbox} disabled={isActivating}>
            {isActivating ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Mail className="h-3.5 w-3.5 mr-1.5" />
            )}
            Aktivera inkorgsadress
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onUploadClick}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Ladda upp en fil
        </Button>
      </div>
    </div>
  )
}

// ── Fields rail ──────────────────────────────────────────────

function FieldsRail({
  item,
  onDelete,
  isDeleting,
}: {
  item: InboxItem
  onDelete: () => void
  isDeleting: boolean
}) {
  const data = item.extracted_data
  const isProcessed = !!item.created_supplier_invoice_id

  return (
    <div className="flex flex-col h-full">
      {/* Email metadata */}
      {item.source === 'email' && (item.email_from || item.email_subject) && (
        <div className="border-b px-4 py-3 text-xs space-y-1">
          {item.email_from && (
            <div className="flex gap-2">
              <span className="text-muted-foreground w-14 shrink-0">Från</span>
              <span className="truncate">{item.email_from}</span>
            </div>
          )}
          {item.email_subject && (
            <div className="flex gap-2">
              <span className="text-muted-foreground w-14 shrink-0">Ämne</span>
              <span className="truncate">{item.email_subject}</span>
            </div>
          )}
          {item.email_received_at && (
            <div className="flex gap-2">
              <span className="text-muted-foreground w-14 shrink-0">Mottaget</span>
              <span>{new Date(item.email_received_at).toLocaleString('sv-SE')}</span>
            </div>
          )}
        </div>
      )}

      {item.error_message && (
        <div className="border-b border-destructive/30 bg-destructive/5 px-4 py-3 text-xs flex items-start gap-2">
          <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Fel vid bearbetning</p>
            <p className="text-muted-foreground mt-0.5">{item.error_message}</p>
          </div>
        </div>
      )}

      {/* Extracted fields */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-3">
          Extraherade fält
        </h3>
        {data ? (
          <ExtractedFieldsList data={data} />
        ) : (
          <p className="text-xs text-muted-foreground italic">
            Kunde inte läsa text — manuell registrering krävs.
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="border-t px-4 py-3 space-y-2">
        {isProcessed && item.created_supplier_invoice_id ? (
          <Link href={`/supplier-invoices/${item.created_supplier_invoice_id}`} className="block">
            <Button variant="default" size="sm" className="w-full">
              <ArrowRight className="h-3.5 w-3.5 mr-1.5" />
              Öppna leverantörsfaktura
            </Button>
          </Link>
        ) : (
          <Link href={`/supplier-invoices/new?inbox_item_id=${item.id}`} className="block">
            <Button variant="default" size="sm" className="w-full">
              Skapa leverantörsfaktura
            </Button>
          </Link>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          onClick={onDelete}
          disabled={isDeleting || isProcessed}
          title={isProcessed ? 'Kopplad till leverantörsfaktura — kan inte tas bort' : undefined}
        >
          {isDeleting ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
          )}
          Ta bort
        </Button>
        {isProcessed && (
          <Badge variant="secondary" className="w-full justify-center text-[10px]">
            <Check className="h-2.5 w-2.5 mr-1" />
            Bearbetad
          </Badge>
        )}
      </div>
    </div>
  )
}

// ── Extracted fields list ────────────────────────────────────

function ExtractedFieldsList({ data }: { data: InvoiceExtractionResult }) {
  const fields: Array<{ label: string; value: string | null }> = [
    { label: 'Leverantör', value: data.supplier?.name ?? null },
    { label: 'Org.nr', value: data.supplier?.orgNumber ?? null },
    { label: 'VAT-nr', value: data.supplier?.vatNumber ?? null },
    { label: 'Bankgiro', value: data.supplier?.bankgiro ?? null },
    { label: 'Plusgiro', value: data.supplier?.plusgiro ?? null },
    { label: 'Fakturanr', value: data.invoice?.invoiceNumber ?? null },
    { label: 'OCR/Referens', value: data.invoice?.paymentReference ?? null },
    { label: 'Fakturadatum', value: data.invoice?.invoiceDate ?? null },
    { label: 'Förfallodatum', value: data.invoice?.dueDate ?? null },
    {
      label: 'Totalt',
      value: data.totals?.total != null ? formatCurrency(data.totals.total, data.invoice?.currency ?? 'SEK') : null,
    },
    {
      label: 'Moms',
      value: data.totals?.vatAmount != null ? formatCurrency(data.totals.vatAmount, data.invoice?.currency ?? 'SEK') : null,
    },
  ]

  return (
    <dl className="space-y-2">
      {fields.map((f) => (
        <div key={f.label} className="flex flex-col gap-0.5">
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground/80">{f.label}</dt>
          <dd
            className={cn(
              'text-sm break-all',
              f.value == null && 'text-muted-foreground/50 italic'
            )}
          >
            {f.value ?? '—'}
          </dd>
        </div>
      ))}
      {data.vatBreakdown && data.vatBreakdown.length > 0 && (
        <div className="pt-2 border-t mt-3">
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1.5">
            Momsfördelning
          </dt>
          <dd className="space-y-1">
            {data.vatBreakdown.map((row, i) => (
              <div key={i} className="text-xs flex justify-between">
                <span className="text-muted-foreground">{row.rate}%</span>
                <span className="tabular-nums">
                  {formatCurrency(row.base, data.invoice?.currency ?? 'SEK')} +{' '}
                  {formatCurrency(row.amount, data.invoice?.currency ?? 'SEK')}
                </span>
              </div>
            ))}
          </dd>
        </div>
      )}
    </dl>
  )
}
