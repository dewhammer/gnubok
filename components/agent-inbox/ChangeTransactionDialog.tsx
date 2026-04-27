'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Loader2, Search, Sparkles, Check } from 'lucide-react'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import type { AIProposal, MatchProposalPayload } from '@/types'

type ChangeSource = 'user_alternative' | 'user_manual' | 'ai_regenerated'

interface ChangeTransactionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  proposal: AIProposal
  receiptTotal: number | null
  receiptDate: string | null
  onChanged: () => void
}

interface PickerTx {
  id: string
  date: string
  description: string | null
  amount: number
  currency: string | null
  merchant_name: string | null
}

export default function ChangeTransactionDialog({
  open,
  onOpenChange,
  proposal,
  receiptTotal,
  receiptDate,
  onChanged,
}: ChangeTransactionDialogProps) {
  const payload = proposal.proposal_json as MatchProposalPayload
  const alternatives = payload.alternatives ?? []

  const [selected, setSelected] = useState<{ id: string; source: ChangeSource } | null>(null)
  const [saving, setSaving] = useState(false)
  const [showAll, setShowAll] = useState(alternatives.length === 0)
  const [search, setSearch] = useState('')
  const [allTx, setAllTx] = useState<PickerTx[]>([])
  const [alternativeTx, setAlternativeTx] = useState<Record<string, PickerTx>>({})
  const [loadingList, setLoadingList] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset when dialog opens/closes or proposal changes.
  useEffect(() => {
    if (!open) {
      setSelected(null)
      setSearch('')
      setError(null)
    }
  }, [open, proposal.id])

  // Fetch human-readable context for the AI's alternatives so the user
  // can compare description/amount/date, not bare UUIDs.
  useEffect(() => {
    if (!open || alternatives.length === 0) return
    const ids = alternatives.map((a) => a.transaction_id)
    fetch(`/api/transactions/uncategorized?limit=50&offset=0`)
      .then((r) => r.json())
      .then((body) => {
        const list: PickerTx[] = body?.data?.transactions ?? []
        const map: Record<string, PickerTx> = {}
        for (const tx of list) if (ids.includes(tx.id)) map[tx.id] = tx
        setAlternativeTx(map)
      })
      .catch(() => { /* alternatives still show with reasoning text */ })
  }, [open, alternatives])

  // Fetch the full picker list when the user opens "Visa alla".
  const loadAllTransactions = useCallback(async () => {
    setLoadingList(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      params.set('limit', '30')
      if (search) params.set('search', search)
      if (receiptTotal) {
        params.set('amount_center', String(-Math.abs(receiptTotal)))
        params.set('amount_window', String(Math.max(5, Math.abs(receiptTotal) * 0.1)))
      }
      if (receiptDate) {
        params.set('date_center', receiptDate)
        params.set('date_window', '60')
      }
      const res = await fetch(`/api/transactions/uncategorized?${params.toString()}`)
      const body = await res.json()
      if (!res.ok) {
        setError(body?.error ?? 'Kunde inte hämta transaktioner')
        return
      }
      setAllTx(body?.data?.transactions ?? [])
    } catch {
      setError('Nätverksfel')
    } finally {
      setLoadingList(false)
    }
  }, [search, receiptTotal, receiptDate])

  // Refetch whenever the "show all" pane is open and the search changes.
  useEffect(() => {
    if (!open || !showAll) return
    loadAllTransactions()
  }, [open, showAll, loadAllTransactions])

  const handleConfirm = async () => {
    if (!selected) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/ai/proposals/${proposal.id}/change-match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: proposal.version,
          matched_transaction_id: selected.id,
          source: selected.source,
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(body?.error ?? 'Kunde inte uppdatera förslaget')
        setSaving(false)
        return
      }
      onChanged()
      onOpenChange(false)
    } catch {
      setError('Nätverksfel')
    } finally {
      setSaving(false)
    }
  }

  const currentMatchId = payload.matched_transaction_id

  const alternativesWithContext = useMemo(
    () =>
      alternatives.map((alt) => ({
        ...alt,
        tx: alternativeTx[alt.transaction_id] ?? null,
      })),
    [alternatives, alternativeTx]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Byt transaktion</DialogTitle>
          <DialogDescription>
            Välj en annan transaktion att koppla kvittot till. Du kan välja bland AI:ns
            alternativ eller söka i alla okategoriserade transaktioner.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-6 py-2">
          {/* AI alternatives */}
          {alternatives.length > 0 && (
            <section>
              <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5" />
                AI:ns alternativ ({alternatives.length})
              </h3>
              <div className="space-y-2">
                {alternativesWithContext.map((alt) => (
                  <AlternativeRow
                    key={alt.transaction_id}
                    tx={alt.tx}
                    transactionId={alt.transaction_id}
                    confidence={alt.confidence}
                    reasoning={alt.reasoning}
                    isCurrent={alt.transaction_id === currentMatchId}
                    isSelected={selected?.id === alt.transaction_id}
                    onSelect={() =>
                      setSelected({ id: alt.transaction_id, source: 'user_alternative' })
                    }
                  />
                ))}
              </div>
            </section>
          )}

          {/* Toggle manual picker */}
          {alternatives.length > 0 && !showAll && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAll(true)}
              className="w-full"
            >
              <Search className="h-3.5 w-3.5 mr-2" />
              Visa alla transaktioner
            </Button>
          )}

          {/* Manual picker */}
          {showAll && (
            <section>
              <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
                Alla okategoriserade transaktioner
              </h3>
              <div className="relative mb-2">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Sök beskrivning eller handlare…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8"
                />
              </div>
              {receiptTotal && (
                <p className="text-xs text-muted-foreground mb-2">
                  Filtrerat på belopp runt {formatCurrency(-Math.abs(receiptTotal), 'SEK')} och datum runt{' '}
                  {receiptDate ? formatDate(receiptDate) : '—'}. Rensa sökrutan för att se fler.
                </p>
              )}
              {loadingList ? (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : allTx.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  Inga matchande transaktioner
                </p>
              ) : (
                <div className="space-y-1">
                  {allTx.map((tx) => (
                    <PickerRow
                      key={tx.id}
                      tx={tx}
                      isCurrent={tx.id === currentMatchId}
                      isSelected={selected?.id === tx.id}
                      onSelect={() => setSelected({ id: tx.id, source: 'user_manual' })}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>

        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Avbryt
          </Button>
          <Button onClick={handleConfirm} disabled={!selected || saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Sparar…
              </>
            ) : (
              'Använd denna transaktion'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AlternativeRow({
  tx,
  transactionId,
  confidence,
  reasoning,
  isCurrent,
  isSelected,
  onSelect,
}: {
  tx: PickerTx | null
  transactionId: string
  confidence: number
  reasoning: string
  isCurrent: boolean
  isSelected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={isCurrent}
      className={cn(
        'w-full text-left rounded border p-3 transition-colors',
        isSelected && 'border-primary bg-primary/5',
        !isSelected && 'hover:bg-muted/40',
        isCurrent && 'opacity-50 cursor-not-allowed'
      )}
    >
      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="flex-1 min-w-0">
          {tx ? (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm truncate">{tx.description ?? 'Okänd'}</span>
                <span className="text-sm tabular-nums font-medium">
                  {formatCurrency(tx.amount, tx.currency ?? 'SEK')}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">{formatDate(tx.date)}</div>
            </>
          ) : (
            <div className="text-xs text-muted-foreground font-mono">
              {transactionId.slice(0, 8)}…
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {isCurrent && <Badge variant="outline" className="text-xs">Nuvarande</Badge>}
          <Badge className="text-xs">{Math.round(confidence * 100)}%</Badge>
          {isSelected && <Check className="h-4 w-4 text-primary" />}
        </div>
      </div>
      <p className="text-xs text-muted-foreground italic">&ldquo;{reasoning}&rdquo;</p>
    </button>
  )
}

function PickerRow({
  tx,
  isCurrent,
  isSelected,
  onSelect,
}: {
  tx: PickerTx
  isCurrent: boolean
  isSelected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={isCurrent}
      className={cn(
        'w-full text-left rounded border p-2.5 transition-colors',
        isSelected && 'border-primary bg-primary/5',
        !isSelected && 'hover:bg-muted/40',
        isCurrent && 'opacity-50 cursor-not-allowed'
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm truncate">{tx.description ?? 'Okänd'}</span>
        <span className="text-sm tabular-nums font-medium">
          {formatCurrency(tx.amount, tx.currency ?? 'SEK')}
        </span>
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground mt-0.5">
        <span>{formatDate(tx.date)}</span>
        <div className="flex items-center gap-1">
          {isCurrent && <Badge variant="outline" className="text-xs">Nuvarande</Badge>}
          {isSelected && <Check className="h-4 w-4 text-primary" />}
        </div>
      </div>
    </button>
  )
}

