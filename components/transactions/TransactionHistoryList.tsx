'use client'

import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatCurrency, formatDate } from '@/lib/utils'
import { getCategoryDisplayName } from '@/lib/tax/expense-warnings'
import { Search, ArrowUpRight, ArrowDownRight, ArrowLeftRight, Check, Link2, FileText, Loader2 } from 'lucide-react'
import { TransactionAttachmentIndicator } from './TransactionAttachmentIndicator'
import type { TransactionWithInvoice, HistoryFilter } from './transaction-types'

interface TransactionHistoryListProps {
  transactions: TransactionWithInvoice[]
  onOpenMatchDialog: (transaction: TransactionWithInvoice) => void
  onOpenCategoryDialog: (transaction: TransactionWithInvoice) => void
  hasMore?: boolean
  isLoadingMore?: boolean
  onLoadMore?: () => void
}

export default function TransactionHistoryList({
  transactions,
  onOpenMatchDialog,
  onOpenCategoryDialog,
  hasMore,
  isLoadingMore,
  onLoadMore,
}: TransactionHistoryListProps) {
  const [searchTerm, setSearchTerm] = useState('')
  const [filter, setFilter] = useState<HistoryFilter>('all')

  const filtered = transactions.filter((t) => {
    const matchesSearch = t.description.toLowerCase().includes(searchTerm.toLowerCase())
    const matchesFilter =
      filter === 'all' ||
      (filter === 'business' && t.is_business === true) ||
      (filter === 'private' && t.is_business === false)
    return matchesSearch && matchesFilter
  })

  return (
    <div className="space-y-4">
      {/* Search + filter pills */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Sök transaktioner..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
          />
        </div>
        <div className="flex gap-1.5">
          {(['all', 'business', 'private'] as const).map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? 'default' : 'outline'}
              className="h-9"
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'Alla' : f === 'business' ? 'Företag' : 'Privat'}
            </Button>
          ))}
        </div>
      </div>

      {/* Transaction list */}
      {filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <ArrowLeftRight className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium">Inga transaktioner</h3>
            <p className="text-muted-foreground text-center mt-1">
              {searchTerm
                ? 'Inga transaktioner matchar din sökning'
                : 'Inga transaktioner att visa med valt filter'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((transaction) => (
            <Card
              key={transaction.id}
              data-tx-id={transaction.id}
              className="hover:border-primary/50 transition-colors"
            >
              <CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className={`h-9 w-9 rounded-full flex items-center justify-center flex-shrink-0 ${
                        transaction.amount > 0
                          ? 'bg-success/10 text-success'
                          : 'bg-destructive/10 text-destructive'
                      }`}
                    >
                      {transaction.amount > 0 ? (
                        <ArrowUpRight className="h-5 w-5" />
                      ) : (
                        <ArrowDownRight className="h-5 w-5" />
                      )}
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <p className="font-medium">{transaction.description}</p>
                        <TransactionAttachmentIndicator documentId={transaction.document_id} />
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                        <span>{formatDate(transaction.date)}</span>
                        {transaction.is_business !== null &&
                          !(
                            transaction.is_business &&
                            transaction.category === 'uncategorized' &&
                            transaction.journal_entry_id
                          ) && (
                            <>
                              <span>·</span>
                              <Badge
                                variant={transaction.is_business ? 'default' : 'secondary'}
                              >
                                {transaction.is_business
                                  ? getCategoryDisplayName(transaction.category)
                                  : 'Privat'}
                              </Badge>
                            </>
                          )}
                        {transaction.invoice_id && (
                          <>
                            <span>·</span>
                            <Badge variant="outline" className="text-primary border-primary">
                              <Link2 className="h-3 w-3 mr-1" />
                              Kopplad till faktura
                            </Badge>
                          </>
                        )}
                        {transaction.journal_entry_id ? (
                          <>
                            <span>·</span>
                            <Badge variant="outline" className="text-success border-success">
                              <Check className="h-3 w-3 mr-1" />
                              Bokförd
                            </Badge>
                          </>
                        ) : (
                          <>
                            <span>·</span>
                            <button
                              type="button"
                              className="inline-flex items-center rounded-md border border-warning px-2.5 py-0.5 text-xs font-semibold text-warning-foreground hover:bg-warning/10 transition-colors"
                              onClick={() => onOpenCategoryDialog(transaction)}
                            >
                              Ej bokförd
                            </button>
                          </>
                        )}
                        {transaction.potential_invoice && !transaction.invoice_id && (
                          <>
                            <span>·</span>
                            <button
                              type="button"
                              className="inline-flex items-center rounded-md border border-primary px-2.5 py-0.5 text-xs font-semibold text-primary hover:bg-primary/10 transition-colors"
                              onClick={() => onOpenMatchDialog(transaction)}
                            >
                              <FileText className="h-3 w-3 mr-1" />
                              Möjlig match: Faktura {transaction.potential_invoice.invoice_number}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {!transaction.journal_entry_id && (
                      <Button
                        size="sm"
                        variant="default"
                        className="h-10 text-xs"
                        onClick={() => onOpenCategoryDialog(transaction)}
                      >
                        Bokför
                      </Button>
                    )}
                    <div className="text-right">
                      <p className="font-medium tabular-nums">
                        {transaction.amount > 0 ? '+' : ''}
                        {formatCurrency(transaction.amount, transaction.currency)}
                      </p>
                      {transaction.currency !== 'SEK' && transaction.amount_sek && (
                        <p className="text-sm text-muted-foreground">
                          {formatCurrency(transaction.amount_sek)}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
          {hasMore && onLoadMore && !searchTerm && (
            <div className="flex justify-center pt-4">
              <Button
                variant="outline"
                onClick={onLoadMore}
                disabled={isLoadingMore}
              >
                {isLoadingMore ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Laddar...
                  </>
                ) : (
                  'Ladda fler'
                )}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
