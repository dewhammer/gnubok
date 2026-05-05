'use client'

import { motion } from 'framer-motion'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { ArrowUpRight, ArrowDownRight, FileText, Loader2, Trash2 } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/info-tooltip'
import { getAccountName, formatAccountWithName } from '@/lib/bookkeeping/client-account-names'
import { getTemplateById } from '@/lib/bookkeeping/booking-templates'
import { isCounterpartyTemplateId } from '@/lib/bookkeeping/counterparty-templates'
import type { TransactionWithInvoice, CategorizeHandler } from './transaction-types'
import type { SuggestedCategory, SuggestedTemplate } from '@/lib/transactions/category-suggestions'

interface TransactionInboxCardProps {
  transaction: TransactionWithInvoice
  suggestions?: SuggestedCategory[]
  templateSuggestions?: SuggestedTemplate[]
  processingId: string | null
  isBatchMode: boolean
  isSelected: boolean
  entityType?: string
  onCategorize: CategorizeHandler
  onMarkPrivate: (id: string) => void
  onOpenMatchDialog: (transaction: TransactionWithInvoice) => void
  onOpenCategoryDialog: (transaction: TransactionWithInvoice) => void
  onDelete?: (id: string) => void
  onOpenQuickReview?: (transaction: TransactionWithInvoice, suggestion: SuggestedCategory) => void
  onOpenTemplateReview?: (transaction: TransactionWithInvoice, templateId: string) => void
  onToggleSelect: (id: string) => void
  onAnimationComplete?: (id: string) => void
}

export default function TransactionInboxCard({
  transaction,
  suggestions,
  templateSuggestions,
  processingId,
  isBatchMode,
  isSelected,
  entityType = 'enskild_firma',
  onCategorize,
  onMarkPrivate,
  onOpenMatchDialog,
  onOpenCategoryDialog,
  onDelete,
  onOpenQuickReview,
  onOpenTemplateReview,
  onToggleSelect,
  onAnimationComplete,
}: TransactionInboxCardProps) {
  const isProcessing = processingId === transaction.id
  const isDisabled = processingId !== null && processingId !== transaction.id
  const isIncome = transaction.amount > 0
  const hasInvoiceMatch = !!transaction.potential_invoice && !transaction.invoice_id
  const hasSupplierInvoiceMatch = !!transaction.potential_supplier_invoice && !transaction.supplier_invoice_id
  const topSuggestion = suggestions?.[0]
  const isUncategorized = transaction.is_business === null && !transaction.journal_entry_id
  const showCheckbox = isBatchMode && isUncategorized
  const isDeletable = !transaction.journal_entry_id

  function handleSuggestionClick(suggestion: SuggestedCategory) {
    if (onOpenQuickReview) {
      onOpenQuickReview(transaction, suggestion)
    } else {
      onCategorize(transaction.id, true, suggestion.category)
    }
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95, x: -16 }}
      transition={{ duration: 0.25, ease: [0.25, 0.46, 0.45, 0.94] }}
      onAnimationComplete={(definition) => {
        // Only call on exit animation
        if (typeof definition === 'object' && 'opacity' in definition && definition.opacity === 0) {
          onAnimationComplete?.(transaction.id)
        }
      }}
    >
      <Card
        className={cn(
          'transition-colors',
          hasInvoiceMatch || hasSupplierInvoiceMatch ? 'border-primary/50' : 'border-warning/50',
          isSelected && 'border-primary bg-primary/[0.02]',
          isDisabled && 'opacity-50'
        )}
        onClick={showCheckbox ? () => onToggleSelect(transaction.id) : undefined}
      >
        <CardContent className="py-4">
          <div className="flex items-start justify-between gap-4">
            {/* Left: checkbox + icon + info */}
            <div className="flex items-start gap-3 min-w-0 flex-1">
              {showCheckbox && (
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={() => onToggleSelect(transaction.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="mt-1"
                />
              )}
              <div
                className={`h-9 w-9 rounded-full flex items-center justify-center flex-shrink-0 ${isIncome ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'}`}
                aria-hidden="true"
              >
                {isIncome ? (
                  <ArrowUpRight className="h-5 w-5" />
                ) : (
                  <ArrowDownRight className="h-5 w-5" />
                )}
              </div>
              <div className="min-w-0">
                <p className="font-medium truncate">{transaction.description}</p>
                <p className="text-sm text-muted-foreground">{formatDate(transaction.date)}</p>
              </div>
            </div>

            {/* Right: amount */}
            <div className="text-right flex-shrink-0">
              <p className={cn('font-medium tabular-nums', isIncome && 'text-success')}>
                {isIncome ? '+' : ''}
                {formatCurrency(transaction.amount, transaction.currency)}
              </p>
              {transaction.currency !== 'SEK' && transaction.amount_sek && (
                <p className="text-sm text-muted-foreground">
                  {formatCurrency(transaction.amount_sek)}
                </p>
              )}
            </div>
          </div>

          {/* Inline action buttons - only shown when not in batch mode */}
          {!isBatchMode && (
            <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t">
              {/* Primary action: invoice match or top suggestion */}
              {hasInvoiceMatch ? (
                <Button
                  size="sm"
                  variant="default"
                  className="h-9 text-xs max-w-full truncate"
                  onClick={() => onOpenMatchDialog(transaction)}
                  disabled={isProcessing || isDisabled}
                >
                  {isProcessing ? (
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin flex-shrink-0" />
                  ) : (
                    <FileText className="mr-1.5 h-3 w-3 flex-shrink-0" />
                  )}
                  Matcha Faktura {transaction.potential_invoice!.invoice_number}
                </Button>
              ) : hasSupplierInvoiceMatch ? (
                <Button
                  size="sm"
                  variant="default"
                  className="h-9 text-xs max-w-full truncate"
                  onClick={() => onOpenMatchDialog(transaction)}
                  disabled={isProcessing || isDisabled}
                >
                  {isProcessing ? (
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin flex-shrink-0" />
                  ) : (
                    <FileText className="mr-1.5 h-3 w-3 flex-shrink-0" />
                  )}
                  Matcha Leverantörsfaktura {transaction.potential_supplier_invoice!.supplier_invoice_number}
                </Button>
              ) : templateSuggestions && templateSuggestions.length > 0 ? (
                <>
                  {templateSuggestions.slice(0, 2).map((ts, idx) => {
                    const isCounterparty = isCounterpartyTemplateId(ts.template_id)
                    const tmpl = isCounterparty ? null : getTemplateById(ts.template_id)
                    return (
                      <Button
                        key={ts.template_id}
                        size="sm"
                        variant={idx === 0 ? 'default' : 'outline'}
                        className="h-auto py-1.5 text-xs"
                        onClick={() => {
                          if (onOpenTemplateReview && (isCounterparty || tmpl)) {
                            onOpenTemplateReview(transaction, ts.template_id)
                          } else if (topSuggestion) {
                            handleSuggestionClick(topSuggestion)
                          }
                        }}
                        disabled={isProcessing || isDisabled}
                      >
                        <div className="flex flex-col items-start">
                          <div className="flex items-center">
                            {isProcessing && idx === 0 ? (
                              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                            ) : null}
                            {ts.name_sv}
                          </div>
                          <span className="opacity-70 font-normal text-[10px]">
                            {isCounterparty
                              ? `${ts.description_sv}`
                              : getAccountName(tmpl?.debit_account || ts.debit_account)
                            }
                          </span>
                        </div>
                      </Button>
                    )
                  })}
                </>
              ) : topSuggestion ? (
                <Button
                  size="sm"
                  variant="default"
                  className="h-9 text-xs"
                  onClick={() => handleSuggestionClick(topSuggestion)}
                  disabled={isProcessing || isDisabled}
                >
                  {isProcessing ? (
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                  ) : null}
                  {topSuggestion.label}
                  {topSuggestion.account && (
                    <span className="ml-1 opacity-70 font-normal">
                      ({formatAccountWithName(topSuggestion.account)})
                    </span>
                  )}
                  {topSuggestion.confidence >= 0.8 && (
                    <Badge variant="secondary" className="ml-1.5 text-[10px] px-1 py-0">
                      {Math.round(topSuggestion.confidence * 100)}%
                    </Badge>
                  )}
                </Button>
              ) : null}

              {/* Open category dialog / template picker */}
              <Button
                size="sm"
                variant={!hasInvoiceMatch && !hasSupplierInvoiceMatch && !topSuggestion && (!templateSuggestions || templateSuggestions.length === 0) ? 'default' : 'outline'}
                className="h-9 text-xs"
                onClick={() => onOpenCategoryDialog(transaction)}
                disabled={isProcessing || isDisabled}
              >
                Välj mall...
              </Button>

              {/* Delete button — available for all unbooked transactions */}
              {isDeletable && onDelete && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-9 w-9 p-0 ml-auto text-muted-foreground hover:text-destructive"
                  onClick={() => onDelete(transaction.id)}
                  disabled={isProcessing || isDisabled}
                  aria-label="Ta bort transaktion"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  )
}
