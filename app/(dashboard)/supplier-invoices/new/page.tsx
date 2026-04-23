'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useForm, Controller, useFieldArray } from 'react-hook-form'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { ArrowLeft, Plus, Trash2, Lock, AlertCircle } from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { SupplierInvoiceReviewContent } from '@/components/suppliers/SupplierInvoiceReviewContent'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { getAccountDescription } from '@/lib/bookkeeping/account-descriptions'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { useUnsavedChanges } from '@/lib/hooks/use-unsaved-changes'
import type { Supplier, BASAccount, VatTreatment } from '@/types'

interface LineItem {
  description: string
  amount: number
  account_number: string
  vat_rate: number
}

interface FormData {
  supplier_id: string
  supplier_invoice_number: string
  invoice_date: string
  due_date: string
  delivery_date: string
  currency: string
  exchange_rate: string
  reverse_charge: boolean
  payment_reference: string
  notes: string
  items: LineItem[]
}

function formatAmount(amount: number): string {
  return amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function inferVatTreatment(items: LineItem[], reverseCharge: boolean): VatTreatment {
  if (reverseCharge) return 'reverse_charge'

  const rates = new Set(items.map((i) => i.vat_rate))
  if (rates.size === 1) {
    const rate = rates.values().next().value!
    if (rate === 0.25) return 'standard_25'
    if (rate === 0.12) return 'reduced_12'
    if (rate === 0.06) return 'reduced_6'
    if (rate === 0) return 'exempt'
  }

  return 'standard_25'
}

export default function NewSupplierInvoicePage() {
  const router = useRouter()
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [accounts, setAccounts] = useState<BASAccount[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showReview, setShowReview] = useState(false)
  const [pendingData, setPendingData] = useState<FormData | null>(null)
  const [conflict, setConflict] = useState<{
    message: string
    existing: { id: string; supplier_invoice_number: string; status: string; credit_note_id: string | null } | null
  } | null>(null)
  const [isResolvingConflict, setIsResolvingConflict] = useState(false)
  const invoiceNumberInputRef = useRef<HTMLInputElement | null>(null)

  const { register, control, handleSubmit, watch, setValue, formState: { isDirty } } = useForm<FormData>({
    defaultValues: {
      supplier_id: '',
      supplier_invoice_number: '',
      invoice_date: new Date().toISOString().split('T')[0],
      due_date: '',
      delivery_date: '',
      currency: 'SEK',
      exchange_rate: '',
      reverse_charge: false,
      payment_reference: '',
      notes: '',
      items: [
        {
          description: '',
          amount: 0,
          account_number: '5010',
          vat_rate: 0.25,
        },
      ],
    },
  })

  useUnsavedChanges(isDirty)

  const { fields, append, remove } = useFieldArray({ control, name: 'items' })
  const watchedItems = watch('items')
  const watchedSupplierId = watch('supplier_id')
  const watchedCurrency = watch('currency')

  useEffect(() => {
    fetchSuppliers()
    fetchAccounts()
  }, [])

  // Auto-fill due date when supplier is selected
  useEffect(() => {
    if (watchedSupplierId) {
      const supplier = suppliers.find((s) => s.id === watchedSupplierId)
      if (supplier) {
        const invoiceDate = watch('invoice_date')
        if (invoiceDate) {
          const due = new Date(invoiceDate)
          due.setDate(due.getDate() + supplier.default_payment_terms)
          setValue('due_date', due.toISOString().split('T')[0])
        }
        if (supplier.default_expense_account && fields.length > 0) {
          setValue('items.0.account_number', supplier.default_expense_account)
        }
        if (supplier.default_currency) {
          setValue('currency', supplier.default_currency)
        }
        if (supplier.supplier_type === 'eu_business') {
          setValue('reverse_charge', true)
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedSupplierId, suppliers, watch, setValue, fields.length])

  async function fetchSuppliers() {
    const res = await fetch('/api/suppliers')
    const { data } = await res.json()
    setSuppliers(data || [])
  }

  async function fetchAccounts() {
    const res = await fetch('/api/bookkeeping/accounts')
    const { data } = await res.json()
    setAccounts(data || [])
  }

  function handleAccountChange(index: number, accountNumber: string) {
    setValue(`items.${index}.account_number`, accountNumber)
    // Auto-fill description from account name if description is empty
    const currentDesc = watch(`items.${index}.description`)
    if (!currentDesc && accountNumber.length === 4) {
      const desc = getAccountDescription(accountNumber)
      if (desc) {
        setValue(`items.${index}.description`, desc.name)
      }
    }
  }

  // Calculate totals
  const itemTotals = (watchedItems || []).map((item) => {
    const lineTotal = Math.round((item.amount || 0) * 100) / 100
    const vatAmount = Math.round(lineTotal * (item.vat_rate || 0) * 100) / 100
    return { lineTotal, vatAmount }
  })

  const subtotal = itemTotals.reduce((sum, t) => sum + t.lineTotal, 0)
  const totalVat = itemTotals.reduce((sum, t) => sum + t.vatAmount, 0)
  const total = Math.round((subtotal + totalVat) * 100) / 100

  function onSubmit(data: FormData) {
    if (!data.supplier_id) {
      toast({ title: 'Leverantör saknas', description: 'Välj en leverantör innan du fortsätter.', variant: 'destructive' })
      return
    }
    if (!data.supplier_invoice_number) {
      toast({ title: 'Fakturanummer saknas', description: 'Ange leverantörens fakturanummer.', variant: 'destructive' })
      return
    }

    setPendingData(data)
    setShowReview(true)
  }

  async function submitInvoice(): Promise<{ ok: boolean; status: number; result: { data?: { id: string; arrival_number: number }; error?: string; message?: string; existing?: { id: string; supplier_invoice_number: string; status: string; credit_note_id: string | null } } }> {
    if (!pendingData) return { ok: false, status: 0, result: {} }

    const vatTreatment = inferVatTreatment(pendingData.items, pendingData.reverse_charge)

    const payload = {
      supplier_id: pendingData.supplier_id,
      supplier_invoice_number: pendingData.supplier_invoice_number,
      invoice_date: pendingData.invoice_date,
      due_date: pendingData.due_date,
      delivery_date: pendingData.delivery_date || undefined,
      currency: pendingData.currency,
      exchange_rate: pendingData.exchange_rate ? parseFloat(pendingData.exchange_rate) : undefined,
      vat_treatment: vatTreatment,
      reverse_charge: pendingData.reverse_charge,
      payment_reference: pendingData.payment_reference || undefined,
      notes: pendingData.notes || undefined,
      items: pendingData.items.map((item) => ({
        description: item.description,
        amount: item.amount,
        account_number: item.account_number,
        vat_rate: item.vat_rate,
      })),
    }

    const res = await fetch('/api/supplier-invoices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    const result = await res.json()
    return { ok: res.ok, status: res.status, result }
  }

  async function handleConfirm() {
    if (!pendingData) return
    setIsSubmitting(true)

    const { ok, status, result } = await submitInvoice()

    if (ok && result.data) {
      toast({ title: 'Faktura registrerad', description: `Ankomstnummer: ${result.data.arrival_number}` })
      setShowReview(false)
      router.push(`/supplier-invoices/${result.data.id}`)
    } else if (status === 409 && result.error === 'duplicate_supplier_invoice_number') {
      // Surface the explanatory modal instead of a toast — the user has real choices to make.
      setShowReview(false)
      setConflict({
        message: result.message || 'Det finns redan en faktura med detta nummer från denna leverantör.',
        existing: result.existing ?? null,
      })
    } else {
      toast({
        title: 'Kunde inte registrera faktura',
        description: getErrorMessage(result, { context: 'supplier_invoice', statusCode: status }),
        variant: 'destructive',
      })
    }

    setIsSubmitting(false)
  }

  async function handleUncreditAndRetry() {
    if (!conflict?.existing) return
    const existingId = conflict.existing.id
    const existingNumber = conflict.existing.supplier_invoice_number
    setIsResolvingConflict(true)

    const uncreditRes = await fetch(
      `/api/supplier-invoices/${existingId}/uncredit`,
      { method: 'POST' }
    )
    const uncreditResult = await uncreditRes.json()
    if (!uncreditRes.ok) {
      toast({
        title: 'Kunde inte ångra kreditering',
        description: getErrorMessage(uncreditResult, { context: 'supplier_invoice', statusCode: uncreditRes.status }),
        variant: 'destructive',
      })
      setIsResolvingConflict(false)
      return
    }

    // The duplicate number is now free — drop the dialog regardless of what
    // happens next, otherwise the user is left staring at a stale "number in
    // use" prompt that no longer matches reality.
    setConflict(null)

    const { ok, status, result } = await submitInvoice()
    setIsResolvingConflict(false)

    if (ok && result.data) {
      toast({
        title: 'Kreditering ångrad och faktura registrerad',
        description: `Ankomstnummer: ${result.data.arrival_number}`,
      })
      router.push(`/supplier-invoices/${result.data.id}`)
      return
    }

    // Uncredit succeeded but the resubmit hit a different validation error.
    // Tell the user exactly what happened so they don't assume the uncredit
    // also failed, and leave them on the form to fix and retry.
    toast({
      title: 'Kreditering ångrad — men nya fakturan kunde inte registreras',
      description: `Faktura ${existingNumber} är återställd och numret är ledigt. ${getErrorMessage(result, { context: 'supplier_invoice', statusCode: status })}`,
      variant: 'destructive',
    })
  }

  function handlePickNewNumber() {
    setConflict(null)
    setTimeout(() => invoiceNumberInputRef.current?.focus(), 0)
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => router.push('/supplier-invoices')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">Registrera leverantörsfaktura</h1>
          <p className="text-muted-foreground">
            Registrera en inkommande faktura (uppfyller BFL verifikationskrav)
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Supplier & Reference */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Leverantör & referens</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Leverantör *</Label>
                <Controller
                  name="supplier_id"
                  control={control}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger>
                        <SelectValue placeholder="Välj leverantör" />
                      </SelectTrigger>
                      <SelectContent>
                        {suppliers.map((s) => (
                          <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <div className="space-y-2">
                <Label>Leverantörens fakturanummer *</Label>
                {(() => {
                  const { ref: rhfRef, ...rest } = register('supplier_invoice_number')
                  return (
                    <Input
                      placeholder="Fakturanr från leverantören"
                      {...rest}
                      ref={(el) => {
                        rhfRef(el)
                        invoiceNumberInputRef.current = el
                      }}
                    />
                  )
                })()}
              </div>
            </div>
            <div className="space-y-2">
              <Label>OCR / Betalningsreferens</Label>
              <Input
                placeholder="OCR-nummer"
                {...register('payment_reference')}
              />
            </div>
          </CardContent>
        </Card>

        {/* Dates */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Datum</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Fakturadatum *</Label>
                <Input type="date" {...register('invoice_date')} />
              </div>
              <div className="space-y-2">
                <Label>Förfallodatum *</Label>
                <Input type="date" {...register('due_date')} />
              </div>
              <div className="space-y-2">
                <Label>Leveransdatum (ML krav)</Label>
                <Input type="date" {...register('delivery_date')} />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Currency & Reverse Charge */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Valuta & moms</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Valuta</Label>
                <Controller
                  name="currency"
                  control={control}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="SEK">SEK</SelectItem>
                        <SelectItem value="EUR">EUR</SelectItem>
                        <SelectItem value="USD">USD</SelectItem>
                        <SelectItem value="GBP">GBP</SelectItem>
                        <SelectItem value="NOK">NOK</SelectItem>
                        <SelectItem value="DKK">DKK</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              {watchedCurrency !== 'SEK' && (
                <div className="space-y-2">
                  <Label>Växelkurs</Label>
                  <Input
                    type="number"
                    step="0.0001"
                    placeholder="1.0000"
                    {...register('exchange_rate')}
                  />
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Controller
                name="reverse_charge"
                control={control}
                render={({ field }) => (
                  <Checkbox
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                )}
              />
              <Label>Omvänd skattskyldighet (reverse charge)</Label>
            </div>
          </CardContent>
        </Card>

        {/* Line Items */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">Kontering</CardTitle>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                append({
                  description: '',
                  amount: 0,
                  account_number: '',
                  vat_rate: 0.25,
                })
              }
            >
              <Plus className="mr-2 h-4 w-4" />
              Lägg till rad
            </Button>
          </CardHeader>
          <CardContent>
            {/* Desktop table */}
            <div className="hidden sm:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2 w-28">Konto</th>
                    <th className="pb-2">Beskrivning</th>
                    <th className="pb-2 w-32">Belopp (exkl.)</th>
                    <th className="pb-2 w-24">Momssats</th>
                    <th className="pb-2 w-24 text-right">Moms</th>
                    <th className="pb-2 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map((field, index) => (
                    <tr key={field.id} className="border-b last:border-0 align-top">
                      <td className="py-2 pr-2">
                        <Controller
                          name={`items.${index}.account_number`}
                          control={control}
                          render={({ field: f }) => (
                            <AccountCombobox
                              value={f.value}
                              accounts={accounts}
                              onChange={(val) => handleAccountChange(index, val)}
                            />
                          )}
                        />
                      </td>
                      <td className="py-2 pr-2">
                        <Input
                          placeholder="Beskrivning"
                          {...register(`items.${index}.description`)}
                        />
                      </td>
                      <td className="py-2 pr-2">
                        <Controller
                          name={`items.${index}.amount`}
                          control={control}
                          render={({ field }) => (
                            <Input
                              type="number"
                              step="0.01"
                              placeholder="0,00"
                              value={field.value || ''}
                              onChange={(e) => field.onChange(e.target.value === '' ? 0 : parseFloat(e.target.value) || 0)}
                            />
                          )}
                        />
                      </td>
                      <td className="py-2 pr-2">
                        <Controller
                          name={`items.${index}.vat_rate`}
                          control={control}
                          render={({ field: f }) => (
                            <Select
                              value={String(f.value)}
                              onValueChange={(v) => f.onChange(parseFloat(v))}
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="0.25">25%</SelectItem>
                                <SelectItem value="0.12">12%</SelectItem>
                                <SelectItem value="0.06">6%</SelectItem>
                                <SelectItem value="0">0%</SelectItem>
                              </SelectContent>
                            </Select>
                          )}
                        />
                      </td>
                      <td className="py-2 pr-2 text-right font-mono pt-4">
                        {formatAmount(itemTotals[index]?.vatAmount || 0)}
                      </td>
                      <td className="py-2 pt-3">
                        {fields.length > 1 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => remove(index)}
                          >
                            <Trash2 className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile cards */}
            <div className="sm:hidden space-y-4">
              {fields.map((field, index) => (
                <div key={field.id} className="border rounded-lg p-3 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1">
                      <Controller
                        name={`items.${index}.account_number`}
                        control={control}
                        render={({ field: f }) => (
                          <AccountCombobox
                            value={f.value}
                            accounts={accounts}
                            onChange={(val) => handleAccountChange(index, val)}
                          />
                        )}
                      />
                    </div>
                    {fields.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="shrink-0"
                        onClick={() => remove(index)}
                      >
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    )}
                  </div>
                  <Input
                    placeholder="Beskrivning"
                    {...register(`items.${index}.description`)}
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Belopp (exkl.)</label>
                      <Controller
                        name={`items.${index}.amount`}
                        control={control}
                        render={({ field }) => (
                          <Input
                            type="number"
                            step="0.01"
                            placeholder="0,00"
                            value={field.value || ''}
                            onChange={(e) => field.onChange(e.target.value === '' ? 0 : parseFloat(e.target.value) || 0)}
                          />
                        )}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Momssats</label>
                      <Controller
                        name={`items.${index}.vat_rate`}
                        control={control}
                        render={({ field: f }) => (
                          <Select
                            value={String(f.value)}
                            onValueChange={(v) => f.onChange(parseFloat(v))}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="0.25">25%</SelectItem>
                              <SelectItem value="0.12">12%</SelectItem>
                              <SelectItem value="0.06">6%</SelectItem>
                              <SelectItem value="0">0%</SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                      />
                    </div>
                  </div>
                  <div className="text-right text-sm text-muted-foreground">
                    Moms: <span className="font-mono">{formatAmount(itemTotals[index]?.vatAmount || 0)} kr</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Totals */}
            <div className="mt-4 pt-4 border-t space-y-2 text-right">
              <div className="flex justify-end gap-8">
                <span className="text-muted-foreground">Netto (exkl. moms)</span>
                <span className="font-mono w-32">{formatAmount(subtotal)} kr</span>
              </div>
              <div className="flex justify-end gap-8">
                <span className="text-muted-foreground">Moms</span>
                <span className="font-mono w-32">{formatAmount(totalVat)} kr</span>
              </div>
              <div className="flex justify-end gap-8 font-bold text-lg">
                <span>Totalt</span>
                <span className="font-mono w-32">{formatAmount(total)} kr</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Notes */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Anteckningar</CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea
              placeholder="Interna anteckningar om denna faktura..."
              {...register('notes')}
            />
          </CardContent>
        </Card>

        {/* Submit */}
        <div className="flex justify-end gap-4">
          <Button type="button" variant="outline" onClick={() => router.push('/supplier-invoices')}>
            Avbryt
          </Button>
          <Button
            type="submit"
            disabled={isSubmitting || !canWrite}
            title={!canWrite ? 'Du har endast läsbehörighet i detta företag' : undefined}
          >
            {!canWrite && <Lock className="mr-2 h-4 w-4 inline" />}
            Granska & registrera
          </Button>
        </div>
      </form>

      {pendingData && (() => {
        const selectedSupplier = suppliers.find((s) => s.id === pendingData.supplier_id)
        if (!selectedSupplier) return null
        return (
          <ConfirmationDialog
            open={showReview}
            onOpenChange={setShowReview}
            onConfirm={handleConfirm}
            isSubmitting={isSubmitting}
            title="Granska leverantörsfaktura"
            warningText="Leverantörsfakturan registreras och en verifikation bokförs. Verifikationen kan inte redigeras direkt, men kan korrigeras via en ändringsverifikation."
            confirmLabel="Bekräfta & registrera"
          >
            <SupplierInvoiceReviewContent
              supplier={selectedSupplier}
              invoiceNumber={pendingData.supplier_invoice_number}
              invoiceDate={pendingData.invoice_date}
              dueDate={pendingData.due_date}
              deliveryDate={pendingData.delivery_date || undefined}
              currency={pendingData.currency}
              exchangeRate={pendingData.exchange_rate || undefined}
              reverseCharge={pendingData.reverse_charge}
              paymentReference={pendingData.payment_reference || undefined}
              items={pendingData.items}
              subtotal={subtotal}
              totalVat={totalVat}
              total={total}
            />
          </ConfirmationDialog>
        )
      })()}

      <Dialog open={!!conflict} onOpenChange={(open) => !open && setConflict(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-destructive" />
              Fakturanummer används redan
            </DialogTitle>
            <DialogDescription>{conflict?.message}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            {conflict?.existing && (
              <Button
                variant="outline"
                onClick={() => router.push(`/supplier-invoices/${conflict.existing!.id}`)}
                disabled={isResolvingConflict}
              >
                Visa befintlig faktura
              </Button>
            )}
            {conflict?.existing?.status === 'credited' && (
              <Button onClick={handleUncreditAndRetry} disabled={isResolvingConflict}>
                {isResolvingConflict ? 'Bearbetar...' : 'Ångra kreditering & återförsök'}
              </Button>
            )}
            <Button variant="ghost" onClick={handlePickNewNumber} disabled={isResolvingConflict}>
              Använd ett annat nummer
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
