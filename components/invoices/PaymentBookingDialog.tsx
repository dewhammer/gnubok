'use client'

import { useState, useEffect, useMemo } from 'react'
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
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { proposePaymentLines } from '@/lib/bookkeeping/propose-payment-lines'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatCurrency } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import { Plus, Trash2, Loader2 } from 'lucide-react'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'
import type { Invoice, InvoiceItem, Customer, BASAccount, EntityType } from '@/types'

interface InvoiceWithRelations extends Invoice {
  customer: Customer
  items: InvoiceItem[]
}

interface PaymentBookingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  invoice: InvoiceWithRelations
  onSuccess: () => void
}

const BLANK_LINE: FormLine = { account_number: '', debit_amount: '', credit_amount: '', line_description: '' }

export default function PaymentBookingDialog({
  open,
  onOpenChange,
  invoice,
  onSuccess,
}: PaymentBookingDialogProps) {
  const { toast } = useToast()
  const supabase = createClient()
  const { company } = useCompany()

  const [accounts, setAccounts] = useState<BASAccount[]>([])
  const [lines, setLines] = useState<FormLine[]>([])
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().split('T')[0])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isInitialized, setIsInitialized] = useState(false)

  // Load accounts and settings when dialog opens
  useEffect(() => {
    if (!open) {
      setIsInitialized(false)
      return
    }

    let cancelled = false

    async function init() {
      try {
        // Fetch accounts
        const accountsRes = await fetch('/api/bookkeeping/accounts')
        if (!accountsRes.ok) throw new Error('Kunde inte ladda kontoplanen')
        const accountsData = await accountsRes.json()
        const fetchedAccounts: BASAccount[] = accountsData.data || []

        if (!company?.id) throw new Error('Inget aktivt företag')

        // Fetch company settings
        const { data: settings, error: settingsError } = await supabase
          .from('company_settings')
          .select('accounting_method, entity_type')
          .eq('company_id', company.id)
          .maybeSingle()

        if (settingsError) throw new Error('Kunde inte ladda företagsinställningar')
        if (cancelled) return

        setAccounts(fetchedAccounts)

        const accountingMethod = (settings?.accounting_method || 'accrual') as 'accrual' | 'cash'
        const entityType = (settings?.entity_type as EntityType) || 'enskild_firma'

        const proposed = proposePaymentLines({
          invoice: {
            invoice_number: invoice.invoice_number,
            total: invoice.total,
            total_sek: invoice.total_sek,
            subtotal: invoice.subtotal,
            subtotal_sek: invoice.subtotal_sek,
            vat_amount: invoice.vat_amount,
            vat_amount_sek: invoice.vat_amount_sek,
            currency: invoice.currency,
            exchange_rate: invoice.exchange_rate,
            vat_treatment: invoice.vat_treatment,
            items: invoice.items,
          },
          accountingMethod,
          entityType,
        })

        setLines(proposed)
        setPaymentDate(new Date().toISOString().split('T')[0])
        setIsInitialized(true)
      } catch (err) {
        if (cancelled) return
        toast({
          title: 'Kunde inte ladda bokföringsdialog',
          description: err instanceof Error ? err.message : 'Försök igen.',
          variant: 'destructive',
        })
        onOpenChange(false)
      }
    }

    init()
    return () => { cancelled = true }
  }, [open, invoice.id, company?.id])

  // Balance computation
  const { totalDebit, totalCredit, isBalanced } = useMemo(() => {
    let totalDebit = 0
    let totalCredit = 0
    for (const line of lines) {
      totalDebit += parseFloat(line.debit_amount) || 0
      totalCredit += parseFloat(line.credit_amount) || 0
    }
    const isBalanced = Math.round((totalDebit - totalCredit) * 100) === 0 && totalDebit > 0
    return { totalDebit, totalCredit, isBalanced }
  }, [lines])

  const updateLine = (index: number, field: keyof FormLine, value: string) => {
    setLines((prev) => {
      const next = [...prev]
      const updated = { ...next[index], [field]: value }

      // Debit/credit exclusion: clear the other when one is entered
      if (field === 'debit_amount' && value) {
        updated.credit_amount = ''
      } else if (field === 'credit_amount' && value) {
        updated.debit_amount = ''
      }

      next[index] = updated
      return next
    })
  }

  const addLine = () => {
    setLines((prev) => [...prev, { ...BLANK_LINE }])
  }

  const removeLine = (index: number) => {
    if (lines.length <= 2) return
    setLines((prev) => prev.filter((_, i) => i !== index))
  }

  const handleSubmit = async () => {
    if (!isBalanced) return

    setIsSubmitting(true)

    try {
      const apiLines = lines
        .filter((l) => l.account_number && (parseFloat(l.debit_amount) || parseFloat(l.credit_amount)))
        .map((l) => ({
          account_number: l.account_number,
          debit_amount: parseFloat(l.debit_amount) || 0,
          credit_amount: parseFloat(l.credit_amount) || 0,
          line_description: l.line_description || undefined,
        }))

      const response = await fetch(`/api/invoices/${invoice.id}/mark-paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payment_date: paymentDate,
          lines: apiLines,
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        const error = new Error('Kunde inte markera som betald') as Error & { body?: unknown; status?: number }
        error.body = data
        error.status = response.status
        throw error
      }

      onOpenChange(false)
      onSuccess()
    } catch (error) {
      const anyErr = error as { body?: unknown; status?: number }
      toast({
        title: 'Bokföring misslyckades',
        description: getErrorMessage(anyErr.body ?? error, { context: 'invoice', statusCode: anyErr.status }),
        variant: 'destructive',
      })
    }

    setIsSubmitting(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[680px]">
        <DialogHeader>
          <DialogTitle>Bokför betalning — {invoice.invoice_number}</DialogTitle>
          <DialogDescription>
            {formatCurrency(invoice.total, invoice.currency)}
            {invoice.currency !== 'SEK' && invoice.total_sek && (
              <> ({formatCurrency(invoice.total_sek)} SEK)</>
            )}
          </DialogDescription>
        </DialogHeader>

        {!isInitialized ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            {/* Payment date */}
            <div className="space-y-1.5">
              <Label htmlFor="payment-date">Betalningsdatum</Label>
              <Input
                id="payment-date"
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
                className="w-full sm:w-48"
              />
            </div>

            {/* Journal entry lines */}
            {/* Mobile card layout */}
            <div className="sm:hidden space-y-3">
              {lines.map((line, index) => (
                <div key={index} className="rounded-lg border bg-card p-3 space-y-2">
                  <div className="flex items-start gap-2">
                    <div className="flex-1">
                      <AccountCombobox
                        value={line.account_number}
                        accounts={accounts}
                        onChange={(val) => updateLine(index, 'account_number', val)}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 min-h-[44px] min-w-[44px] shrink-0 -mr-1 -mt-1"
                      onClick={() => removeLine(index)}
                      disabled={lines.length <= 2}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Debet</Label>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="0,00"
                        value={line.debit_amount}
                        onChange={(e) => updateLine(index, 'debit_amount', e.target.value)}
                        className="font-mono text-right"
                        inputMode="decimal"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Kredit</Label>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="0,00"
                        value={line.credit_amount}
                        onChange={(e) => updateLine(index, 'credit_amount', e.target.value)}
                        className="font-mono text-right"
                        inputMode="decimal"
                      />
                    </div>
                  </div>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={addLine} className="w-full">
                <Plus className="mr-1 h-3.5 w-3.5" /> Lägg till rad
              </Button>
            </div>

            {/* Desktop table layout */}
            <div className="hidden sm:block space-y-2">
              {/* Header */}
              <div className="grid grid-cols-[1fr_120px_120px_32px] gap-2 text-xs font-medium text-muted-foreground px-1">
                <span>Konto</span>
                <span className="text-right">Debet</span>
                <span className="text-right">Kredit</span>
                <span />
              </div>

              {/* Lines */}
              {lines.map((line, index) => (
                <div key={index} className="grid grid-cols-[1fr_120px_120px_32px] gap-2 items-start">
                  <div className="min-w-0">
                    <AccountCombobox
                      value={line.account_number}
                      accounts={accounts}
                      onChange={(val) => updateLine(index, 'account_number', val)}
                    />
                  </div>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0,00"
                    value={line.debit_amount}
                    onChange={(e) => updateLine(index, 'debit_amount', e.target.value)}
                    className="font-mono text-right h-8"
                  />
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0,00"
                    value={line.credit_amount}
                    onChange={(e) => updateLine(index, 'credit_amount', e.target.value)}
                    className="font-mono text-right h-8"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={() => removeLine(index)}
                    disabled={lines.length <= 2}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}

              {/* Add row */}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={addLine}
                className="text-muted-foreground"
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                Lägg till rad
              </Button>
            </div>

            {/* Balance indicator */}
            <div className="flex items-center justify-between border-t pt-3">
              <div className="flex items-center gap-2">
                {isBalanced ? (
                  <Badge variant="secondary" className="bg-success/10 text-success">
                    Debet = Kredit
                  </Badge>
                ) : (
                  <Badge variant="destructive">
                    Obalanserad ({formatCurrency(Math.abs(totalDebit - totalCredit))})
                  </Badge>
                )}
              </div>
              <div className="text-sm text-muted-foreground font-mono">
                {formatCurrency(totalDebit)} / {formatCurrency(totalCredit)}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting} className="w-full sm:w-auto min-h-11">
            Avbryt
          </Button>
          <Button onClick={handleSubmit} disabled={!isBalanced || isSubmitting || !isInitialized} className="w-full sm:w-auto min-h-11">
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Bekräfta &amp; bokför
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
