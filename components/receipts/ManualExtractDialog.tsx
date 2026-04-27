'use client'

import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { Loader2 } from 'lucide-react'
import type { ReceiptRowWithPreview } from '@/app/(dashboard)/receipts/page'

// Fallback when AI can't read the image. The source document stays attached;
// we just let the user type the fields AI would have extracted so the row
// can move to 'ready' and be matched to a bank transaction.
export default function ManualExtractDialog({
  row,
  onClose,
  onSaved,
}: {
  row: ReceiptRowWithPreview
  onClose: () => void
  onSaved: () => void
}) {
  const data = row.extracted_data as {
    merchant?: { name?: string | null }
    receipt?: { date?: string | null; currency?: string | null }
    totals?: { total?: number | null; vatAmount?: number | null }
  } | null
  const [merchant, setMerchant] = useState(data?.merchant?.name ?? '')
  const [date, setDate] = useState(data?.receipt?.date ?? new Date().toISOString().slice(0, 10))
  const [total, setTotal] = useState<string>(data?.totals?.total != null ? String(data.totals.total) : '')
  const [vatAmount, setVatAmount] = useState<string>(data?.totals?.vatAmount != null ? String(data.totals.vatAmount) : '')
  const [currency, setCurrency] = useState(data?.receipt?.currency ?? 'SEK')
  const [saving, setSaving] = useState(false)
  const { toast } = useToast()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const totalNum = Number(total)
    if (!merchant.trim() || !date || !Number.isFinite(totalNum) || totalNum <= 0) {
      toast({
        title: 'Kontrollera fälten',
        description: 'Butiksnamn, datum och giltigt totalbelopp krävs.',
        variant: 'destructive',
      })
      return
    }
    const vatNum = vatAmount.trim() === '' ? null : Number(vatAmount)
    if (vatNum !== null && !Number.isFinite(vatNum)) {
      toast({ title: 'Ogiltigt momsbelopp', variant: 'destructive' })
      return
    }

    setSaving(true)
    try {
      const res = await fetch('/api/extensions/ext/invoice-inbox/manual-extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inbox_item_id: row.id,
          merchant: merchant.trim(),
          date,
          total: totalNum,
          currency,
          vat_amount: vatNum,
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        toast({ title: 'Kunde inte spara', description: body.error, variant: 'destructive' })
        return
      }
      toast({ title: 'Kvitto sparat' })
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Skriv in kvittouppgifter</DialogTitle>
          <DialogDescription>
            Använd det här när AI inte kan läsa bilden. Bilden behålls som underlag —
            du anger bara siffrorna så kan kvittot matchas mot en banktransaktion.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="merchant">Butik / leverantör</Label>
            <Input
              id="merchant"
              value={merchant}
              onChange={(e) => setMerchant(e.target.value)}
              placeholder="t.ex. ICA Maxi"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="date">Datum</Label>
              <Input
                id="date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="currency">Valuta</Label>
              <Input
                id="currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
                maxLength={3}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="total">Totalbelopp</Label>
              <Input
                id="total"
                type="number"
                step="0.01"
                inputMode="decimal"
                value={total}
                onChange={(e) => setTotal(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vat">Varav moms (valfritt)</Label>
              <Input
                id="vat"
                type="number"
                step="0.01"
                inputMode="decimal"
                value={vatAmount}
                onChange={(e) => setVatAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              Avbryt
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sparar…
                </>
              ) : (
                'Spara'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
