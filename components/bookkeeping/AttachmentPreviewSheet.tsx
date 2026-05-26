'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  AlertTriangle,
  ExternalLink,
  FileText,
  ImageIcon,
  Loader2,
  Lock,
  Paperclip,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { Skeleton } from '@/components/ui/skeleton'

interface DocumentRecord {
  id: string
  file_name: string
  file_size_bytes: number
  mime_type: string | null
  storage_path: string
  created_at: string
  download_url?: string
}

interface AttachmentPreviewSheetProps {
  entryId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

function isImageType(type: string | null): boolean {
  return type?.startsWith('image/') ?? false
}

function isPdfType(type: string | null): boolean {
  return type === 'application/pdf'
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function AttachmentPreviewSheet({
  entryId,
  open,
  onOpenChange,
}: AttachmentPreviewSheetProps) {
  const t = useTranslations('attachment_preview_sheet')
  const tj = useTranslations('journal_attachments')
  const { toast } = useToast()
  const [documents, setDocuments] = useState<DocumentRecord[]>([])
  const [loading, setLoading] = useState(false)

  const [blockedDoc, setBlockedDoc] = useState<DocumentRecord | null>(null)
  const [replacingDocId, setReplacingDocId] = useState<string | null>(null)
  const replaceFileInputRef = useRef<HTMLInputElement | null>(null)
  const replaceTargetIdRef = useRef<string | null>(null)

  const fetchAttachments = useCallback(async (id: string) => {
    setLoading(true)
    try {
      const res = await fetch(
        `/api/documents?journal_entry_id=${id}&current_only=true`
      )
      const { data } = await res.json()
      const list: DocumentRecord[] = data || []

      // Pull a signed download_url for each — used by the
      // "open in new tab" link. The iframe/img sources use the
      // same-origin inline proxy and do not need download_url.
      const enriched = await Promise.all(
        list.map(async (doc) => {
          try {
            const r = await fetch(`/api/documents/${doc.id}`)
            const { data: detail } = await r.json()
            return detail?.download_url
              ? { ...doc, download_url: detail.download_url as string }
              : doc
          } catch {
            return doc
          }
        })
      )
      setDocuments(enriched)
    } catch {
      setDocuments([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open && entryId) {
      fetchAttachments(entryId)
    } else if (!open) {
      setDocuments([])
      setBlockedDoc(null)
    }
  }, [open, entryId, fetchAttachments])

  const handleOpenReplacePicker = (docId: string) => {
    replaceTargetIdRef.current = docId
    replaceFileInputRef.current?.click()
  }

  const handleReplaceFileSelected = async (file: File | null) => {
    const docId = replaceTargetIdRef.current
    replaceTargetIdRef.current = null
    if (replaceFileInputRef.current) {
      replaceFileInputRef.current.value = ''
    }
    if (!file || !docId || !entryId) return

    setReplacingDocId(docId)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`/api/documents/${docId}/versions`, {
        method: 'POST',
        body: fd,
      })
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: undefined }))
        toast({
          title: tj('replace_failed'),
          description: error || undefined,
          variant: 'destructive',
        })
      } else {
        await fetchAttachments(entryId)
        setBlockedDoc(null)
      }
    } catch {
      toast({ title: tj('replace_failed'), variant: 'destructive' })
    } finally {
      setReplacingDocId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[95vw] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>

        <input
          ref={replaceFileInputRef}
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => handleReplaceFileSelected(e.target.files?.[0] ?? null)}
        />

        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-[60vh] w-full rounded-lg" />
          </div>
        ) : documents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="mb-3 rounded-full bg-muted p-3">
              <Paperclip className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          </div>
        ) : (
          <div className="space-y-6">
            {documents.map((doc) => {
              const inlineSrc = `/api/documents/${doc.id}/inline`
              const previewable = isImageType(doc.mime_type) || isPdfType(doc.mime_type)
              const isReplacing = replacingDocId === doc.id
              return (
                <div key={doc.id} className="space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-2">
                      {isImageType(doc.mime_type) ? (
                        <ImageIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {doc.file_name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatFileSize(doc.file_size_bytes)}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0"
                        onClick={() => handleOpenReplacePicker(doc.id)}
                        disabled={isReplacing}
                        title={t('replace')}
                        aria-label={t('replace')}
                      >
                        {isReplacing ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0"
                        onClick={() => setBlockedDoc(doc)}
                        title={t('remove')}
                        aria-label={t('remove')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                      {doc.download_url && (
                        <a
                          href={doc.download_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-2 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          {t('open_in_new_tab')}
                        </a>
                      )}
                    </div>
                  </div>

                  {isPdfType(doc.mime_type) && (
                    // <object> + type="application/pdf" invokes Chrome's PDF
                    // plugin directly. <iframe> went through Chrome's frame
                    // pipeline first and intermittently surfaced
                    // "Det här innehållet har blockerats" even with a
                    // permissive CSP. Firefox/Edge handled both fine; Chrome
                    // is the odd one. See crbug.com/271452.
                    <object
                      data={inlineSrc}
                      type="application/pdf"
                      aria-label={doc.file_name}
                      className="h-[70vh] w-full rounded-lg border border-border"
                    >
                      <div className="flex h-[70vh] w-full items-center justify-center rounded-lg border border-border bg-muted/30 p-4 text-center text-sm text-muted-foreground">
                        {t('not_previewable')}
                        {doc.download_url && (
                          <>
                            {' — '}
                            <a
                              href={doc.download_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="underline"
                            >
                              {t('open_in_new_tab')}
                            </a>
                          </>
                        )}
                      </div>
                    </object>
                  )}

                  {isImageType(doc.mime_type) && (
                    <div className="overflow-hidden rounded-lg border border-border bg-muted/30">
                      <img
                        src={inlineSrc}
                        alt={doc.file_name}
                        className="mx-auto max-h-[70vh] w-full object-contain"
                      />
                    </div>
                  )}

                  {!previewable && (
                    <p className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
                      {t('not_previewable')}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <Dialog
          open={blockedDoc !== null}
          onOpenChange={(o) => {
            if (!o) setBlockedDoc(null)
          }}
        >
          <DialogContent>
            <DialogHeader>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-warning/15 shrink-0">
                  <Lock className="h-5 w-5 text-warning-foreground" />
                </div>
                <DialogTitle>{tj('remove_blocked_title')}</DialogTitle>
              </div>
              <DialogDescription className="pt-3 text-sm text-muted-foreground">
                {tj('remove_blocked_body')}
              </DialogDescription>
            </DialogHeader>

            <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                <p className="text-muted-foreground">{tj('remove_blocked_hint')}</p>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setBlockedDoc(null)}>
                {tj('remove_blocked_cancel_cta')}
              </Button>
              <Button
                onClick={() => {
                  if (blockedDoc) handleOpenReplacePicker(blockedDoc.id)
                }}
                disabled={blockedDoc !== null && replacingDocId === blockedDoc.id}
              >
                {blockedDoc !== null && replacingDocId === blockedDoc.id ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {tj('replace_uploading')}
                  </>
                ) : (
                  tj('remove_blocked_replace_cta')
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  )
}
