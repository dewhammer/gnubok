'use client'

import Link from 'next/link'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ExternalLink } from 'lucide-react'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { AgentInboxItemView } from '@/app/(dashboard)/agent-inbox/page'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  tx: NonNullable<AgentInboxItemView['transaction']>
}

export default function TransactionDetailDialog({ open, onOpenChange, tx }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-baseline justify-between gap-3">
            <span className="truncate">{tx.description || 'Okänd transaktion'}</span>
            <span className="tabular-nums text-base font-medium flex-shrink-0">
              {formatCurrency(tx.amount, tx.currency)}
            </span>
          </DialogTitle>
          <DialogDescription>
            {formatDate(tx.date)} · Banktransaktion
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5">
            {tx.merchant_name && tx.merchant_name !== tx.description && (
              <>
                <dt className="text-muted-foreground">Handlare</dt>
                <dd>{tx.merchant_name}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Kategori</dt>
            <dd>{tx.category ?? '—'}</dd>
            <dt className="text-muted-foreground">Affärs/privat</dt>
            <dd>
              {tx.is_business === true
                ? 'Affärs'
                : tx.is_business === false
                ? 'Privat'
                : 'Okänt'}
            </dd>
            {tx.currency && tx.currency !== 'SEK' && (
              <>
                <dt className="text-muted-foreground">Valuta</dt>
                <dd>
                  {tx.currency}
                  {tx.amount_sek != null && (
                    <span className="text-muted-foreground">
                      {' '}
                      ({formatCurrency(tx.amount_sek, 'SEK')})
                    </span>
                  )}
                </dd>
                {tx.exchange_rate != null && (
                  <>
                    <dt className="text-muted-foreground">Växelkurs</dt>
                    <dd className="tabular-nums">{tx.exchange_rate}</dd>
                  </>
                )}
                {tx.exchange_rate_date && (
                  <>
                    <dt className="text-muted-foreground">Kursdatum</dt>
                    <dd>{formatDate(tx.exchange_rate_date)}</dd>
                  </>
                )}
              </>
            )}
            {tx.mcc_code != null && (
              <>
                <dt className="text-muted-foreground">MCC-kod</dt>
                <dd className="font-mono">{tx.mcc_code}</dd>
              </>
            )}
            {tx.external_id && (
              <>
                <dt className="text-muted-foreground">Externt ID</dt>
                <dd className="font-mono text-xs text-muted-foreground break-all">
                  {tx.external_id}
                </dd>
              </>
            )}
            {tx.bank_connection_id && (
              <>
                <dt className="text-muted-foreground">Bankanslutning</dt>
                <dd className="font-mono text-xs text-muted-foreground">
                  {tx.bank_connection_id.slice(0, 8)}…
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Transaktions-ID</dt>
            <dd className="font-mono text-xs text-muted-foreground break-all">
              {tx.id}
            </dd>
          </dl>

          <div className="pt-3 border-t">
            <Button variant="outline" size="sm" asChild>
              <Link href={`/transactions?highlight=${tx.id}`}>
                <ExternalLink className="h-3.5 w-3.5 mr-2" />
                Öppna i transaktionslistan
              </Link>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
