'use client'

import { useState, useEffect, useCallback, use } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { AccountNumber } from '@/components/ui/account-number'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, ArrowLeft, Paperclip, AlertTriangle, Lock, MessageSquare, Pencil, Check, X, Copy } from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatDate } from '@/lib/utils'
import JournalEntryAttachments from '@/components/bookkeeping/JournalEntryAttachments'
import JournalEntryStatusBadge, { sourceTypeLabels } from '@/components/bookkeeping/JournalEntryStatusBadge'
import CorrectionEntryDialog from '@/components/bookkeeping/CorrectionEntryDialog'
import CorrectionChain from '@/components/bookkeeping/CorrectionChain'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { JournalEntry, JournalEntryLine } from '@/types'

export default function JournalEntryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const [entry, setEntry] = useState<JournalEntry | null>(null)
  const [chain, setChain] = useState<JournalEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCorrection, setShowCorrection] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isCommitting, setIsCommitting] = useState(false)
  const [isLastInSeries, setIsLastInSeries] = useState(false)
  const [attachmentCount, setAttachmentCount] = useState(0)
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesValue, setNotesValue] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)

  const fetchData = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/bookkeeping/journal-entries/${id}/chain`)
      if (!res.ok) {
        const { error: msg } = await res.json()
        setError(msg || 'Kunde inte hämta verifikation')
        return
      }
      const { data } = await res.json()
      setEntry(data.entry)
      setChain(data.chain)
      setIsLastInSeries(data.is_last_in_series ?? false)
    } catch {
      setError('Kunde inte hämta verifikation')
    } finally {
      setIsLoading(false)
    }
  }, [id])

  const saveNotes = useCallback(async (value: string) => {
    setSavingNotes(true)
    try {
      const res = await fetch(`/api/bookkeeping/journal-entries/${id}/notes`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: value || null }),
      })
      if (res.ok) {
        setEntry(prev => prev ? { ...prev, notes: value || null } : prev)
        setEditingNotes(false)
      } else {
        toast({ title: 'Kunde inte spara anteckning', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Kunde inte spara anteckning', variant: 'destructive' })
    } finally {
      setSavingNotes(false)
    }
  }, [id, toast])

  const handleCommit = useCallback(async () => {
    setIsCommitting(true)
    try {
      const res = await fetch(`/api/bookkeeping/journal-entries/${id}/commit`, { method: 'POST' })
      const result = await res.json()
      if (res.ok) {
        const posted = result.data
        toast({
          title: 'Verifikat bokfört',
          description: `Verifikat ${posted?.voucher_series ?? ''}${posted?.voucher_number ?? ''} har bokförts.`,
        })
        await fetchData()
      } else {
        toast({ title: 'Kunde inte bokföra', description: getErrorMessage(result, { context: 'journal_entry' }), variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Kunde inte bokföra verifikat', variant: 'destructive' })
    } finally {
      setIsCommitting(false)
    }
  }, [id, toast, fetchData])

  const handleDelete = useCallback(async () => {
    setIsDeleting(true)
    try {
      const res = await fetch(`/api/bookkeeping/journal-entries/${id}`, { method: 'DELETE' })
      const result = await res.json()
      if (res.ok) {
        const wasDraft = result.data?.was_draft === true
        toast({
          title: wasDraft ? 'Utkast raderat' : 'Verifikat raderat',
          description: wasDraft
            ? 'Utkastet har tagits bort.'
            : `Verifikat ${result.data?.voucher_series ?? ''}${result.data?.voucher_number ?? ''} har raderats.`,
        })
        router.push('/bookkeeping')
      } else {
        toast({ title: 'Kunde inte radera', description: getErrorMessage(result, { context: 'journal_entry' }), variant: 'destructive' })
        setShowDeleteConfirm(false)
      }
    } catch {
      toast({ title: 'Kunde inte radera verifikat', variant: 'destructive' })
      setShowDeleteConfirm(false)
    } finally {
      setIsDeleting(false)
    }
  }, [id, router, toast])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground mb-3" />
        <p className="text-sm text-muted-foreground">Laddar verifikation...</p>
      </div>
    )
  }

  if (error || !entry) {
    return (
      <div className="space-y-4">
        <Link
          href="/bookkeeping"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Tillbaka till bokföring
        </Link>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">{error || 'Verifikation hittades inte'}</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const lines = ((entry.lines || []) as JournalEntryLine[])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)

  const totalDebit = lines.reduce((sum, l) => sum + (Number(l.debit_amount) || 0), 0)
  const totalCredit = lines.reduce((sum, l) => sum + (Number(l.credit_amount) || 0), 0)

  const foreignLines = lines.filter(l => l.currency && l.currency !== 'SEK' && l.amount_in_currency != null)
  const hasForeignCurrency = foreignLines.length > 0
  // For the summary: use the first foreign line's data (the settlement line)
  const foreignCurrency = hasForeignCurrency ? foreignLines[0].currency! : null
  const foreignTotal = hasForeignCurrency ? Math.abs(Number(foreignLines[0].amount_in_currency) || 0) : 0
  const foreignExchangeRate = hasForeignCurrency ? (Number(foreignLines[0].exchange_rate) || null) : null

  const canCorrect =
    entry.status === 'posted' &&
    entry.source_type !== 'storno' &&
    entry.source_type !== 'correction'

  // Include current entry in the chain for the visualization
  const fullChain = [entry, ...chain]

  return (
    <div className="space-y-8">
      {/* Back link */}
      <Link
        href="/bookkeeping"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Tillbaka till bokföring
      </Link>

      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight font-mono">
              {entry.voucher_series}{entry.voucher_number}
            </h1>
            <JournalEntryStatusBadge entry={entry} />
          </div>
          <p className="text-muted-foreground">{entry.description}</p>
        </div>

        {(entry.status === 'posted' || entry.status === 'draft') && (
          <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
            {entry.status === 'draft' && (
              <Button
                size="sm"
                className="w-full sm:w-auto"
                onClick={handleCommit}
                disabled={!canWrite || isCommitting}
                title={!canWrite ? 'Du har endast läsbehörighet i detta företag' : undefined}
              >
                {!canWrite ? <Lock className="mr-2 h-4 w-4" /> : isCommitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Bokför
              </Button>
            )}
            {(entry.status === 'draft' || isLastInSeries) && (
              <Button
                variant="destructive"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => setShowDeleteConfirm(true)}
                disabled={!canWrite}
                title={!canWrite ? 'Du har endast läsbehörighet i detta företag' : undefined}
              >
                {!canWrite && <Lock className="mr-2 h-4 w-4" />}
                {entry.status === 'draft' ? 'Radera utkast' : 'Radera verifikat'}
              </Button>
            )}
            {canCorrect && (
              <Button
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => setShowCorrection(true)}
                disabled={!canWrite}
                title={!canWrite ? 'Du har endast läsbehörighet i detta företag' : undefined}
              >
                {!canWrite && <Lock className="mr-2 h-4 w-4" />}
                Skapa ändringsverifikation
              </Button>
            )}
            {entry.status === 'posted' && (
              <Button
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => router.push(`/bookkeeping?copy_from=${entry.id}`)}
                disabled={!canWrite}
                title={!canWrite ? 'Du har endast läsbehörighet i detta företag' : undefined}
              >
                {!canWrite ? <Lock className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
                Kopiera verifikat
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Info cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Verifikationsdetaljer</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Datum</span>
              <span>{formatDate(entry.entry_date)}</span>
            </div>
            {entry.committed_at && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Bokförd</span>
                <span>{new Date(entry.committed_at).toLocaleDateString('sv-SE')}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">Typ</span>
              <span>{sourceTypeLabels[entry.source_type] || entry.source_type}</span>
            </div>
            {entry.source_voucher_series && entry.source_voucher_number != null && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Ursprungligt verifikat</span>
                <span className="font-mono tabular-nums">
                  {entry.source_voucher_series}{entry.source_voucher_number}
                </span>
              </div>
            )}
            {/* Notes — always editable (internal metadata, not BFL verifikation content) */}
            <div className="border-t pt-2 mt-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-muted-foreground flex items-center gap-1">
                  <MessageSquare className="h-3.5 w-3.5" />
                  Anteckning
                </span>
                {!editingNotes && canWrite && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => { setNotesValue(entry.notes || ''); setEditingNotes(true) }}
                    aria-label="Redigera anteckning"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
              {editingNotes ? (
                <div className="space-y-2">
                  <Textarea
                    value={notesValue}
                    onChange={(e) => setNotesValue(e.target.value)}
                    placeholder="Intern anteckning..."
                    className="resize-none text-sm"
                    rows={3}
                    maxLength={2000}
                    autoFocus
                  />
                  <div className="flex gap-1 justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      onClick={() => setEditingNotes(false)}
                      disabled={savingNotes}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      className="h-7 px-2"
                      onClick={() => saveNotes(notesValue)}
                      disabled={savingNotes}
                    >
                      {savingNotes ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground italic">
                  {entry.notes || 'Ingen anteckning'}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Summering</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Debet</span>
              <span className="tabular-nums font-medium">
                {totalDebit.toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Kredit</span>
              <span className="tabular-nums font-medium">
                {totalCredit.toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Antal rader</span>
              <span>{lines.length}</span>
            </div>
            {hasForeignCurrency && (
              <>
                <div className="border-t pt-2 mt-2 flex justify-between">
                  <span className="text-muted-foreground">Belopp i utländsk valuta</span>
                  <span className="tabular-nums font-medium">
                    {foreignTotal.toLocaleString('sv-SE', { minimumFractionDigits: 2 })} {foreignCurrency}
                  </span>
                </div>
                {foreignExchangeRate && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Omräkningskurs</span>
                    <span className="tabular-nums">
                      1 {foreignCurrency} = {foreignExchangeRate.toLocaleString('sv-SE', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} SEK
                    </span>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Underlag</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <div className="flex items-center gap-2">
              {attachmentCount > 0 ? (
                <>
                  <Paperclip className="h-4 w-4 text-muted-foreground" />
                  <span>{attachmentCount} {attachmentCount === 1 ? 'dokument' : 'dokument'}</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="h-4 w-4 text-warning-foreground" />
                  <span className="text-muted-foreground">Inga underlag bifogade</span>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Lines table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Kontorader</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Desktop table */}
          <div className="hidden sm:block">
            <table className="w-full text-sm">
              <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="py-2 w-48">Konto</th>
                  <th className="py-2">Beskrivning</th>
                  <th className="py-2 w-28 text-right">Debet</th>
                  <th className="py-2 w-28 text-right">Kredit</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => {
                  const hasForeignCurrency = line.currency && line.currency !== 'SEK' && line.amount_in_currency != null
                  return (
                    <tr key={line.id} className="border-b last:border-0">
                      <td className="py-2"><AccountNumber number={line.account_number} showName /></td>
                      <td className="py-2 text-muted-foreground">{line.line_description || ''}</td>
                      <td className="py-2 text-right tabular-nums">
                        {Number(line.debit_amount) > 0 && (
                          <>
                            {Number(line.debit_amount).toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
                            {hasForeignCurrency && Number(line.debit_amount) > 0 && (
                              <span className="block text-xs text-muted-foreground">
                                {Number(line.amount_in_currency).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} {line.currency}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {Number(line.credit_amount) > 0 && (
                          <>
                            {Number(line.credit_amount).toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
                            {hasForeignCurrency && Number(line.credit_amount) > 0 && (
                              <span className="block text-xs text-muted-foreground">
                                {Number(line.amount_in_currency).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} {line.currency}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td colSpan={2} className="py-2">Summa</td>
                  <td className="py-2 text-right tabular-nums">
                    {totalDebit.toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {totalCredit.toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="sm:hidden space-y-2">
            {lines.map((line) => {
              const hasForeignCurrency = line.currency && line.currency !== 'SEK' && line.amount_in_currency != null
              return (
                <div key={line.id} className="flex items-center justify-between py-2 border-b last:border-0 gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm"><AccountNumber number={line.account_number} showName /></div>
                    {line.line_description && (
                      <p className="text-xs text-muted-foreground truncate">{line.line_description}</p>
                    )}
                  </div>
                  <div className="text-right shrink-0 text-sm tabular-nums">
                    {Number(line.debit_amount) > 0 && (
                      <p>
                        {Number(line.debit_amount).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} D
                        {hasForeignCurrency && (
                          <span className="block text-xs text-muted-foreground">
                            {Number(line.amount_in_currency).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} {line.currency}
                          </span>
                        )}
                      </p>
                    )}
                    {Number(line.credit_amount) > 0 && (
                      <p>
                        {Number(line.credit_amount).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} K
                        {hasForeignCurrency && (
                          <span className="block text-xs text-muted-foreground">
                            {Number(line.amount_in_currency).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} {line.currency}
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                </div>
              )
            })}
            <div className="flex justify-between font-semibold text-sm pt-1">
              <span>Summa</span>
              <div className="flex gap-3 tabular-nums">
                <span>D: {totalDebit.toLocaleString('sv-SE', { minimumFractionDigits: 2 })}</span>
                <span>K: {totalCredit.toLocaleString('sv-SE', { minimumFractionDigits: 2 })}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Attachments */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Underlag</CardTitle>
        </CardHeader>
        <CardContent>
          <JournalEntryAttachments
            journalEntryId={entry.id}
            onCountChange={setAttachmentCount}
          />
        </CardContent>
      </Card>

      {/* Correction chain */}
      {chain.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Ändringshistorik</CardTitle>
          </CardHeader>
          <CardContent>
            <CorrectionChain currentEntryId={id} chain={fullChain} />
          </CardContent>
        </Card>
      )}

      {/* Correction dialog */}
      {showCorrection && entry && (
        <CorrectionEntryDialog
          entry={entry}
          open={showCorrection}
          onOpenChange={setShowCorrection}
          onCorrected={() => {
            setShowCorrection(false)
            fetchData()
          }}
        />
      )}

      {/* Delete confirmation dialog */}
      <ConfirmationDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        onConfirm={handleDelete}
        isSubmitting={isDeleting}
        title={entry?.status === 'draft' ? 'Radera utkast' : 'Radera verifikat'}
        warningText={
          entry?.status === 'draft'
            ? 'Utkastet har aldrig bokförts och kan tas bort utan att påverka verifikationsserien. Eventuella kopplade underlag behålls men avlänkas. Denna åtgärd kan inte ångras.'
            : `Verifikat ${entry?.voucher_series ?? ''}${entry?.voucher_number ?? ''} raderas permanent. Eventuella kopplade underlag behålls men avlänkas. Denna åtgärd kan inte ångras.`
        }
        confirmLabel="Radera permanent"
      >
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4">
          <AlertTriangle className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
          <div className="text-sm">
            <p className="font-medium mb-1">Permanent radering</p>
            <p className="text-muted-foreground">
              {entry?.status === 'draft'
                ? 'Utkastet och dess kontorader tas bort. Kopplade fakturor och transaktioner påverkas inte — de stannar kvar som obokförda. Underlag (kvitton, dokument) behålls men avlänkas.'
                : 'Verifikatet och dess kontorader tas bort. Kopplade transaktioner och fakturor behåller sina uppgifter men markeras som ej bokförda. Underlag (kvitton, dokument) behålls men avlänkas.'}
            </p>
          </div>
        </div>
      </ConfirmationDialog>
    </div>
  )
}
