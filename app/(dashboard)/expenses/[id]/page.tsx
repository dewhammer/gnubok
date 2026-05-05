'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { ArrowLeft, CheckCircle, CreditCard, FileText, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { AccountNumber } from '@/components/ui/account-number'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import type { SupplierInvoice, SupplierInvoiceItem, SupplierInvoicePayment, EntityType } from '@/types'

const statusConfig: Record<string, { label: string; color: string }> = {
  registered: { label: 'Obetald', color: 'bg-blue-100 text-blue-800' },
  approved: { label: 'Obetald', color: 'bg-yellow-100 text-yellow-800' },
  paid: { label: 'Betald', color: 'bg-success/10 text-success' },
  partially_paid: { label: 'Delbetald', color: 'bg-orange-100 text-orange-800' },
  overdue: { label: 'Förfallen', color: 'bg-destructive/10 text-destructive' },
  disputed: { label: 'Tvist', color: 'bg-purple-100 text-purple-800' },
  credited: { label: 'Krediterad', color: 'bg-gray-100 text-gray-800' },
}

function formatAmount(amount: number): string {
  return amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function ExpenseDetailPage() {
  const params = useParams()
  const router = useRouter()
  const { toast } = useToast()
  const [invoice, setInvoice] = useState<SupplierInvoice | null>(null)
  const [, setEntityType] = useState<EntityType>('enskild_firma')
  const [isLoading, setIsLoading] = useState(true)
  const [isPayDialogOpen, setIsPayDialogOpen] = useState(false)
  const [payAmount, setPayAmount] = useState('')
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().split('T')[0])
  const [isProcessing, setIsProcessing] = useState(false)
  const { dialogProps: confirmDialogProps, confirm: confirmAction } = useDestructiveConfirm()

  async function fetchInvoice() {
    setIsLoading(true)
    const res = await fetch(`/api/supplier-invoices/${params.id}`)
    const { data, error } = await res.json()
    if (error) {
      toast({ title: 'Kunde inte ladda utgift', description: error, variant: 'destructive' })
    } else {
      setInvoice(data)
      setPayAmount(String(data.remaining_amount))
      setPaymentDate(new Date().toISOString().split('T')[0])
    }
    setIsLoading(false)
  }

  async function fetchEntityType() {
    try {
      const res = await fetch('/api/settings')
      const { data } = await res.json()
      if (data?.entity_type) {
        setEntityType(data.entity_type)
      }
    } catch {
      // Default to enskild_firma
    }
  }

  useEffect(() => {
    fetchInvoice()
    fetchEntityType()
  }, [params.id])

  async function handleApprove() {
    setIsProcessing(true)
    const res = await fetch(`/api/supplier-invoices/${params.id}/approve`, { method: 'POST' })
    const result = await res.json()
    if (!res.ok) {
      toast({ title: 'Kunde inte godkänna', description: result.error, variant: 'destructive' })
    } else {
      toast({ title: 'Godkänd', description: 'Utgiften har godkänts' })
      fetchInvoice()
    }
    setIsProcessing(false)
  }

  async function handleMarkPaid() {
    setIsProcessing(true)
    const res = await fetch(`/api/supplier-invoices/${params.id}/mark-paid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: parseFloat(payAmount), payment_date: paymentDate }),
    })
    const result = await res.json()
    if (!res.ok) {
      toast({ title: 'Betalning misslyckades', description: result.error, variant: 'destructive' })
    } else {
      toast({
        title: result.status === 'paid' ? 'Betald' : 'Delbetalning registrerad',
        description: `${formatAmount(parseFloat(payAmount))} kr registrerat`,
      })
      setIsPayDialogOpen(false)
      fetchInvoice()
    }
    setIsProcessing(false)
  }

  async function handleCredit() {
    const ok = await confirmAction({
      title: 'Registrera kreditfaktura',
      description: 'En kreditfaktura skapas som reverserar den ursprungliga fakturan. Denna åtgärd kan inte ångras.',
      confirmLabel: 'Registrera kreditfaktura',
      variant: 'warning',
    })
    if (!ok) return
    setIsProcessing(true)
    const res = await fetch(`/api/supplier-invoices/${params.id}/credit`, { method: 'POST' })
    const result = await res.json()
    if (!res.ok) {
      toast({ title: 'Kunde inte kreditera', description: result.error, variant: 'destructive' })
    } else {
      toast({ title: 'Kreditfaktura registrerad' })
      fetchInvoice()
    }
    setIsProcessing(false)
  }

  async function handleDelete() {
    const ok = await confirmAction({
      title: 'Ta bort utgift',
      description: 'Utgiften och tillhörande data tas bort permanent. Denna åtgärd kan inte ångras.',
      confirmLabel: 'Ta bort',
      variant: 'destructive',
    })
    if (!ok) return
    const res = await fetch(`/api/supplier-invoices/${params.id}`, { method: 'DELETE' })
    const result = await res.json()
    if (!res.ok) {
      toast({ title: 'Kunde inte ta bort', description: result.error, variant: 'destructive' })
    } else {
      toast({ title: 'Borttagen' })
      router.push('/expenses')
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-4xl">
        <div className="h-8 bg-muted rounded w-48 animate-pulse" />
        <Card className="animate-pulse"><CardContent className="h-48" /></Card>
      </div>
    )
  }

  if (!invoice) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Utgiften hittades inte</p>
        <Button variant="outline" className="mt-4" onClick={() => router.push('/expenses')}>
          Tillbaka
        </Button>
      </div>
    )
  }

  const items = (invoice.items || []) as SupplierInvoiceItem[]
  const payments = (invoice.payments || []) as SupplierInvoicePayment[]
  const status = statusConfig[invoice.status] || { label: invoice.status, color: '' }

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="space-y-4">
        <div className="flex items-start gap-4">
          <Button variant="ghost" size="icon" className="shrink-0 mt-1" onClick={() => router.push('/expenses')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">
                Utgift #{invoice.arrival_number}
              </h1>
              <Badge className={status.color}>
                {status.label}
              </Badge>
            </div>
            <p className="text-muted-foreground truncate">
              {invoice.supplier?.name} · Faktura {invoice.supplier_invoice_number}
            </p>
          </div>
        </div>

        {/* Context-aware actions */}
        <div className="flex flex-col sm:flex-row gap-2 sm:justify-end">
          {invoice.status === 'registered' && (
            <>
              <Button className="w-full sm:w-auto" onClick={handleApprove} disabled={isProcessing}>
                <CheckCircle className="mr-2 h-4 w-4" />
                Godkänn
              </Button>
              <Button variant="destructive" className="w-full sm:w-auto" onClick={handleDelete} disabled={isProcessing}>
                <Trash2 className="mr-2 h-4 w-4 sm:mr-0" />
                <span className="sm:hidden">Ta bort</span>
              </Button>
            </>
          )}
          {['approved', 'overdue'].includes(invoice.status) && (
            <>
              <Button className="w-full sm:w-auto" onClick={() => setIsPayDialogOpen(true)} disabled={isProcessing}>
                <CreditCard className="mr-2 h-4 w-4" />
                Markera betald
              </Button>
              <Button variant="outline" className="w-full sm:w-auto" onClick={handleCredit} disabled={isProcessing}>
                <FileText className="mr-2 h-4 w-4" />
                Kreditfaktura
              </Button>
            </>
          )}
          {invoice.status === 'partially_paid' && (
            <Button className="w-full sm:w-auto" onClick={() => setIsPayDialogOpen(true)} disabled={isProcessing}>
              <CreditCard className="mr-2 h-4 w-4" />
              Registrera betalning
            </Button>
          )}
        </div>
      </div>

      {/* Card 1: Fakturadetaljer */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Fakturadetaljer</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Info grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Leverantör</span>
              <p className="font-medium">
                {invoice.supplier ? (
                  <Link href={`/suppliers/${invoice.supplier.id}`} className="text-primary hover:underline">
                    {invoice.supplier.name}
                  </Link>
                ) : '-'}
              </p>
              {invoice.supplier?.org_number && (
                <p className="text-xs text-muted-foreground">Org.nr: {invoice.supplier.org_number}</p>
              )}
            </div>
            <div>
              <span className="text-muted-foreground">Fakturanummer</span>
              <p className="font-medium">{invoice.supplier_invoice_number}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Ankomstnummer</span>
              <p className="font-medium font-mono">{invoice.arrival_number}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Fakturadatum</span>
              <p className="font-medium">{invoice.invoice_date}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Förfallodatum</span>
              <p className="font-medium">{invoice.due_date}</p>
            </div>
            {invoice.delivery_date && (
              <div>
                <span className="text-muted-foreground">Leveransdatum</span>
                <p className="font-medium">{invoice.delivery_date}</p>
              </div>
            )}
            {invoice.payment_reference && (
              <div>
                <span className="text-muted-foreground">OCR/referens</span>
                <p className="font-medium font-mono">{invoice.payment_reference}</p>
              </div>
            )}
          </div>

          {invoice.reverse_charge && (
            <Badge className="bg-purple-100 text-purple-800">Omvänd skattskyldighet</Badge>
          )}

          {/* Line items */}
          {items.length > 0 && (
            <div className="border-t pt-4">
              {/* Desktop: table */}
              <div className="hidden sm:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pb-2">Beskrivning</th>
                      <th className="pb-2 w-20">Konto</th>
                      <th className="pb-2 w-16 text-right">Moms%</th>
                      <th className="pb-2 w-28 text-right">Belopp</th>
                      <th className="pb-2 w-24 text-right">Moms</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id} className="border-b last:border-0">
                        <td className="py-2">{item.description}</td>
                        <td className="py-2"><AccountNumber number={item.account_number} /></td>
                        <td className="py-2 text-right">{Math.round(item.vat_rate * 100)}%</td>
                        <td className="py-2 text-right font-mono">{formatAmount(item.line_total)}</td>
                        <td className="py-2 text-right font-mono">{formatAmount(item.vat_amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile: stacked cards */}
              <div className="sm:hidden space-y-3">
                {items.map((item) => (
                  <div key={item.id} className="border rounded-lg p-3 space-y-2 text-sm">
                    <div className="flex justify-between items-start gap-2">
                      <span className="font-medium">{item.description || 'Ingen beskrivning'}</span>
                      <AccountNumber number={item.account_number} />
                    </div>
                    <div className="flex justify-between text-muted-foreground">
                      <span>Belopp</span>
                      <span className="font-mono">{formatAmount(item.line_total)}</span>
                    </div>
                    <div className="flex justify-between text-muted-foreground">
                      <span>Moms ({Math.round(item.vat_rate * 100)}%)</span>
                      <span className="font-mono">{formatAmount(item.vat_amount)}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Amounts summary */}
              <div className="mt-4 pt-4 border-t space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Netto (exkl. moms)</span>
                  <span className="font-mono">{formatAmount(invoice.subtotal)} {invoice.currency}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Moms</span>
                  <span className="font-mono">{formatAmount(invoice.vat_amount)} {invoice.currency}</span>
                </div>
                <div className="flex justify-between font-bold text-base pt-2 border-t">
                  <span>Totalt</span>
                  <span className="font-mono">{formatAmount(invoice.total)} {invoice.currency}</span>
                </div>
                <div className="flex justify-between pt-2">
                  <span className="text-muted-foreground">Betalt</span>
                  <span className="font-mono text-success">{formatAmount(invoice.paid_amount)} {invoice.currency}</span>
                </div>
                <div className="flex justify-between font-semibold">
                  <span>Kvar att betala</span>
                  <span className="font-mono">{formatAmount(invoice.remaining_amount)} {invoice.currency}</span>
                </div>
              </div>
            </div>
          )}

          {/* Notes inline */}
          {invoice.notes && (
            <div className="border-t pt-4">
              <p className="text-sm text-muted-foreground">{invoice.notes}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Card 2: Betalningar & bokföring (only if data exists) */}
      {(payments.length > 0 || invoice.registration_journal_entry_id) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Betalningar & bokföring</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Payment history */}
            {payments.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">Betalningshistorik</p>

                {/* Desktop: table */}
                <div className="hidden sm:block">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="pb-2">Datum</th>
                        <th className="pb-2 text-right">Belopp</th>
                        <th className="pb-2">Verifikation</th>
                        <th className="pb-2">Anteckning</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.map((p) => (
                        <tr key={p.id} className="border-b last:border-0">
                          <td className="py-2">{p.payment_date}</td>
                          <td className="py-2 text-right font-mono">{formatAmount(p.amount)} {p.currency}</td>
                          <td className="py-2">
                            {p.journal_entry_id ? (
                              <Link href={`/bookkeeping/${p.journal_entry_id}`} className="text-primary hover:underline font-mono text-xs">
                                {p.journal_entry_id.substring(0, 8)}...
                              </Link>
                            ) : '-'}
                          </td>
                          <td className="py-2 text-muted-foreground">{p.notes || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobile: stacked cards */}
                <div className="sm:hidden space-y-3">
                  {payments.map((p) => (
                    <div key={p.id} className="border rounded-lg p-3 space-y-1 text-sm">
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">{p.payment_date}</span>
                        <span className="font-mono font-medium">{formatAmount(p.amount)} {p.currency}</span>
                      </div>
                      {p.journal_entry_id && (
                        <div className="flex justify-between items-center">
                          <span className="text-muted-foreground">Verifikation</span>
                          <Link href={`/bookkeeping/${p.journal_entry_id}`} className="text-primary hover:underline font-mono text-xs">
                            {p.journal_entry_id.substring(0, 8)}...
                          </Link>
                        </div>
                      )}
                      {p.notes && (
                        <p className="text-muted-foreground text-xs pt-1">{p.notes}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Journal entry links */}
            <div className="text-sm space-y-2">
              <p className="font-medium">Verifikationer</p>
              {invoice.registration_journal_entry_id ? (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Registreringsverifikation</span>
                  <Link
                    href={`/bookkeeping/${invoice.registration_journal_entry_id}`}
                    className="text-primary hover:underline font-mono"
                  >
                    {invoice.registration_journal_entry_id.substring(0, 8)}...
                  </Link>
                </div>
              ) : (
                <p className="text-muted-foreground">Ingen registreringsverifikation</p>
              )}
              {invoice.payment_journal_entry_id && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Betalningsverifikation</span>
                  <Link
                    href={`/bookkeeping/${invoice.payment_journal_entry_id}`}
                    className="text-primary hover:underline font-mono"
                  >
                    {invoice.payment_journal_entry_id.substring(0, 8)}...
                  </Link>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <DestructiveConfirmDialog {...confirmDialogProps} />

      {/* Pay Dialog */}
      <Dialog open={isPayDialogOpen} onOpenChange={setIsPayDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Markera som betald</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="payment-date">Betalningsdatum</Label>
              <Input
                id="payment-date"
                type="date"
                value={paymentDate}
                max={new Date().toISOString().split('T')[0]}
                onChange={(e) => setPaymentDate(e.target.value)}
                className="w-full sm:w-48"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="payment-amount">Belopp att betala</Label>
              <Input
                id="payment-amount"
                type="number"
                step="0.01"
                value={payAmount}
                onChange={(e) => setPayAmount(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Kvar att betala: {formatAmount(invoice.remaining_amount)} {invoice.currency}
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsPayDialogOpen(false)}>
                Avbryt
              </Button>
              <Button onClick={handleMarkPaid} disabled={isProcessing}>
                {isProcessing ? 'Bearbetar...' : 'Registrera betalning'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
