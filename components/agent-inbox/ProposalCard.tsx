'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Receipt as ReceiptIcon, Landmark } from 'lucide-react'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import type { AgentInboxItemView } from '@/app/(dashboard)/agent-inbox/page'
import type { BookingProposalPayload, MatchProposalPayload } from '@/types'
import ReceiptDetailDialog from './ReceiptDetailDialog'
import TransactionDetailDialog from './TransactionDetailDialog'
import { assessReceiptQuality } from './receipt-quality'

interface ProposalCardProps {
  item: AgentInboxItemView
  isSelected: boolean
  isBusy: boolean
  onToggleSelect: () => void
  onAccept: () => void
  onReject: () => void
  onEdit: () => void
  onChangeMatch?: () => void
}

function confidenceLabel(c: number | null): string {
  if (c === null) return 'Ingen säkerhet'
  const pct = Math.round(c * 100)
  return `${pct}% säkerhet`
}

function confidenceColor(c: number | null): string {
  if (c === null) return 'bg-muted'
  if (c >= 0.9) return 'bg-success/15 text-success-foreground'
  if (c >= 0.6) return 'bg-warning/15 text-warning-foreground'
  return 'bg-destructive/15 text-destructive-foreground'
}

export default function ProposalCard({
  item,
  isSelected,
  isBusy,
  onToggleSelect,
  onAccept,
  onReject,
  onEdit,
  onChangeMatch,
}: ProposalCardProps) {
  const proposal = item.proposal!
  const inbox = item.inbox_item
  const tx = item.transaction
  const isMatch = proposal.step_type === 'match'
  const isUserEdited = Boolean(proposal.edit_diff)
  // BFL compliance: can't book without a source document. Block match-accept
  // when no receipt file is attached — the server-side validator enforces this
  // too, but disabling the button client-side avoids a round-trip error.
  const receiptMissing = isMatch && !inbox.document_id

  const matchPayload = isMatch ? (proposal.proposal_json as MatchProposalPayload) : null
  const bookingPayload = !isMatch ? (proposal.proposal_json as BookingProposalPayload) : null

  return (
    <Card className="transition-colors">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className="pt-1">
            <Checkbox checked={isSelected} onCheckedChange={onToggleSelect} aria-label="Markera" />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <Badge variant="outline">{isMatch ? 'Match' : 'Bokföring'}</Badge>
              <Badge className={confidenceColor(proposal.confidence)}>
                {confidenceLabel(proposal.confidence)}
              </Badge>
              {isUserEdited && (
                <Badge variant="outline" className="text-xs border-success/40 text-success-foreground">
                  Ändrad av användare
                </Badge>
              )}
              {inbox.document && (
                <span className="text-xs text-muted-foreground truncate">
                  {inbox.document.file_name}
                </span>
              )}
            </div>

            {isMatch && matchPayload && (
              <MatchProposalBody
                payload={matchPayload}
                reasoning={proposal.reasoning}
                transaction={tx}
                inbox={inbox}
              />
            )}

            {!isMatch && bookingPayload && (
              <BookingProposalBody payload={bookingPayload} reasoning={proposal.reasoning} />
            )}

            {receiptMissing && (
              <p className="text-xs text-muted-foreground mt-3 flex items-center gap-1.5">
                <span className="inline-block w-1 h-1 rounded-full bg-warning" />
                Kvittobild saknas — ladda upp i kvittodialogen innan du kan godkänna.
              </p>
            )}

            <div className="flex gap-2 mt-4 flex-wrap">
              <Button
                size="sm"
                onClick={onAccept}
                disabled={isBusy || receiptMissing}
                title={receiptMissing ? 'Kvittobild krävs för att bokföra' : undefined}
              >
                {isBusy ? '…' : 'Godkänn'}
              </Button>
              {isMatch && onChangeMatch && (
                <Button size="sm" variant="outline" onClick={onChangeMatch} disabled={isBusy}>
                  Byt transaktion
                </Button>
              )}
              {!isMatch && (
                <Button size="sm" variant="outline" onClick={onEdit} disabled={isBusy}>
                  Redigera
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={onReject} disabled={isBusy}>
                Avvisa
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function MatchProposalBody({
  payload,
  reasoning,
  transaction,
  inbox,
}: {
  payload: MatchProposalPayload
  reasoning: string | null
  transaction: AgentInboxItemView['transaction']
  inbox: AgentInboxItemView['inbox_item']
}) {
  const proposedTx = transaction && transaction.id === payload.matched_transaction_id ? transaction : null
  return (
    <div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <ReceiptBox inbox={inbox} />
        {proposedTx ? (
          <TransactionBox tx={proposedTx} />
        ) : (
          <div className="rounded border bg-muted/40 p-3 text-sm text-muted-foreground">
            Föreslagen transaktion: {payload.matched_transaction_id}
          </div>
        )}
      </div>
      <ReasoningDisclosure reasoning={reasoning} alternatives={payload.alternatives} />
    </div>
  )
}

function ReasoningDisclosure({
  reasoning,
  alternatives,
}: {
  reasoning: string | null
  alternatives?: MatchProposalPayload['alternatives']
}) {
  const [open, setOpen] = useState(false)
  const hasReasoning = Boolean(reasoning)
  const hasAlternatives = alternatives && alternatives.length > 0
  if (!hasReasoning && !hasAlternatives) return null

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
      >
        {open ? 'Dölj AI:ns resonemang' : 'Visa AI:ns resonemang'}
        {hasAlternatives && ` (${alternatives!.length} alternativ)`}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {reasoning && (
            <p className="text-xs text-muted-foreground italic">&ldquo;{reasoning}&rdquo;</p>
          )}
          {hasAlternatives && (
            <ul className="space-y-1 text-xs">
              {alternatives!.map((alt) => (
                <li key={alt.transaction_id} className="text-muted-foreground">
                  <span className="tabular-nums">{Math.round(alt.confidence * 100)}%</span> — {alt.reasoning}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function ReceiptBox({
  inbox,
}: {
  inbox: AgentInboxItemView['inbox_item']
}) {
  const [open, setOpen] = useState(false)
  const data = (inbox.extracted_data as {
    merchant?: { name?: string | null }
    receipt?: { date?: string | null; currency?: string | null }
    totals?: { total?: number | null }
  } | null) ?? {}
  const merchant = data.merchant?.name ?? inbox.document?.file_name ?? 'Okänt kvitto'
  const total = data.totals?.total ?? null
  const currency = data.receipt?.currency ?? 'SEK'
  const date = data.receipt?.date ?? null
  const quality = assessReceiptQuality(inbox)
  const hasFile = Boolean(inbox.document_id)
  const needsAttention = !hasFile || !quality.ok

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'w-full text-left rounded border bg-muted/40 p-3 text-sm transition-colors hover:bg-muted/60 hover:border-primary/40',
          needsAttention && 'border-warning/50 bg-warning/5 hover:bg-warning/10'
        )}
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate">{merchant}</span>
          {total != null && (
            <span className="tabular-nums font-medium">
              {formatCurrency(total, currency)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
          <ReceiptIcon className="h-3 w-3" />
          <span>Kvitto · {date ? formatDate(date) : 'Okänt datum'}</span>
        </div>
        {!hasFile && (
          <p className="mt-2 text-xs text-warning-foreground">
            Ingen kvittobild — klicka för att ladda upp
          </p>
        )}
        {hasFile && !quality.ok && (
          <p className="mt-2 text-xs text-warning-foreground">
            {quality.message}
          </p>
        )}
      </button>
      <ReceiptDetailDialog open={open} onOpenChange={setOpen} inbox={inbox} />
    </>
  )
}

function TransactionBox({
  tx,
}: {
  tx: NonNullable<AgentInboxItemView['transaction']>
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full text-left rounded border bg-muted/40 p-3 text-sm transition-colors hover:bg-muted/60 hover:border-primary/40"
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate">{tx.description || 'Okänd'}</span>
          <span className="tabular-nums font-medium">
            {formatCurrency(tx.amount, tx.currency)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
          <Landmark className="h-3 w-3" />
          <span>Banktransaktion · {formatDate(tx.date)}</span>
        </div>
      </button>
      <TransactionDetailDialog open={open} onOpenChange={setOpen} tx={tx} />
    </>
  )
}

function BookingProposalBody({
  payload,
  reasoning,
}: {
  payload: BookingProposalPayload
  reasoning: string | null
}) {
  const totalDebit = payload.lines.reduce((s, l) => s + l.debit_amount, 0)
  return (
    <div>
      <div className="rounded border bg-muted/40 p-3 text-sm">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground">
              <th className="text-left font-normal pb-1">Konto</th>
              <th className="text-right font-normal pb-1">Debet</th>
              <th className="text-right font-normal pb-1">Kredit</th>
            </tr>
          </thead>
          <tbody>
            {payload.lines.map((line, i) => (
              <tr key={i} className="border-t border-border/40">
                <td className="py-1">
                  <span className="font-mono">{line.account_number}</span>{' '}
                  <span className="text-muted-foreground">{line.description}</span>
                </td>
                <td className="py-1 text-right tabular-nums">
                  {line.debit_amount > 0 ? line.debit_amount.toFixed(2) : ''}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {line.credit_amount > 0 ? line.credit_amount.toFixed(2) : ''}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="text-xs text-muted-foreground">
            <tr className="border-t">
              <td className="pt-1">
                {payload.vat_treatment && <span>Moms: {payload.vat_treatment}</span>}
                {payload.default_private && <span className="ml-2">Privat uttag</span>}
              </td>
              <td className="pt-1 text-right tabular-nums">{totalDebit.toFixed(2)}</td>
              <td className="pt-1 text-right tabular-nums">{totalDebit.toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <ReasoningDisclosure reasoning={reasoning} />
    </div>
  )
}
