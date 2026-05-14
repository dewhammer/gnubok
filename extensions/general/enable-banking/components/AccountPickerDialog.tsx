'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import type { StoredAccount } from '../types'

interface AccountPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  connectionId: string
  bankName: string
  accounts: StoredAccount[]
  // True when the connection is still in pending_selection — closing without
  // saving is allowed but the user is reminded that no sync runs until they
  // confirm.
  isInitialSelection: boolean
  onSaved: () => void
}

const LOOKBACK_OPTIONS = [
  { days: 90, label: 'Senaste 90 dagar (PSD2 standard, rekommenderas)' },
  { days: 180, label: 'Senaste 180 dagar' },
  { days: 365, label: 'Senaste 365 dagar' },
] as const

export function AccountPickerDialog({
  open,
  onOpenChange,
  connectionId,
  bankName,
  accounts,
  isInitialSelection,
  onSaved,
}: AccountPickerDialogProps) {
  const { toast } = useToast()
  // Memoise so the client has a stable reference across re-renders. Without this,
  // listing `supabase` in the SIE-fetch effect's deps would re-fire that query on
  // every checkbox tick or parent re-render.
  const supabase = useMemo(() => createClient(), [])
  const { company } = useCompany()

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [isSaving, setIsSaving] = useState(false)
  const [lookbackDays, setLookbackDays] = useState<number>(90)
  const [sieLastDate, setSieLastDate] = useState<string | null>(null)
  const [showCustomLookback, setShowCustomLookback] = useState(false)

  useEffect(() => {
    if (open) {
      // Start the dialog reflecting the current state. Accounts without an
      // explicit enabled flag are treated as enabled (back-compat).
      const initial = new Set<string>(
        accounts.filter(a => a.enabled !== false).map(a => a.uid)
      )
      setSelected(initial)
      setShowCustomLookback(false)
    }
  }, [open, accounts])

  // Fetch the latest SIE import end date so we can anchor the backfill to
  // "day after last SIE entry" (SpeedLedger pattern). Only matters on the
  // initial activation flow — selection edits don't re-run sync.
  useEffect(() => {
    if (!open || !isInitialSelection || !company?.id) {
      setSieLastDate(null)
      return
    }
    let cancelled = false
    ;(async () => {
      const { data } = await supabase
        .from('sie_imports')
        .select('fiscal_year_end')
        .eq('company_id', company.id)
        .eq('status', 'completed')
        .order('fiscal_year_end', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (cancelled) return
      const fye = (data as { fiscal_year_end?: string } | null)?.fiscal_year_end || null
      setSieLastDate(fye)
      if (fye) {
        // Anchor lookback to (today - (fye + 1 day)), clamped to [30, 365].
        const dayAfter = new Date(fye)
        dayAfter.setDate(dayAfter.getDate() + 1)
        const days = Math.ceil((Date.now() - dayAfter.getTime()) / (24 * 60 * 60 * 1000))
        setLookbackDays(Math.min(365, Math.max(30, days)))
      } else {
        setLookbackDays(90)
      }
    })()
    return () => { cancelled = true }
  }, [open, isInitialSelection, company?.id, supabase])

  const allSelected = accounts.length > 0 && selected.size === accounts.length
  const noneSelected = selected.size === 0

  const sortedAccounts = useMemo(
    () => [...accounts].sort((a, b) => (a.name || a.iban || '').localeCompare(b.name || b.iban || '')),
    [accounts]
  )

  function toggle(uid: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(uid)) next.delete(uid)
      else next.add(uid)
      return next
    })
  }

  function selectAll() {
    setSelected(new Set(accounts.map(a => a.uid)))
  }

  function selectNone() {
    setSelected(new Set())
  }

  async function handleSave() {
    if (noneSelected) {
      toast({
        title: 'Välj minst ett konto',
        description: 'Avmarkera alla konton och koppla bort banken istället om inga konton ska synkas.',
        variant: 'destructive',
      })
      return
    }

    setIsSaving(true)
    try {
      const response = await fetch('/api/extensions/ext/enable-banking/accounts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connection_id: connectionId,
          enabled_uids: Array.from(selected),
          ...(isInitialSelection ? { initial_lookback_days: lookbackDays } : {}),
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Kunde inte spara kontoval')
      }

      // Surface the actual backfill result so the user sees what the bank returned.
      if (isInitialSelection && data.initial_sync) {
        const { imported, returned_min_date, returned_max_date } = data.initial_sync as {
          imported: number
          returned_min_date: string | null
          returned_max_date: string | null
        }
        const range = returned_min_date && returned_max_date
          ? ` från ${returned_min_date} till ${returned_max_date}`
          : ''
        toast({
          title: 'Konton sparade',
          description: `Importerade ${imported} transaktioner${range}.`,
        })
      } else if (isInitialSelection && data.initial_sync_error) {
        toast({
          title: 'Konton sparade — bakgrundssync misslyckades',
          description: 'Vi försöker igen vid nästa körning. Bankanslutningen är aktiv.',
          variant: 'destructive',
        })
      } else {
        toast({
          title: 'Kontoval sparat',
          description: `${data.enabled_count} av ${data.total_count} konton kommer synkas.`,
        })
      }

      onOpenChange(false)
      onSaved()
    } catch (error) {
      toast({
        title: 'Fel',
        description: error instanceof Error ? error.message : 'Kunde inte spara kontoval',
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  // Day-after-SIE date for the callout
  const dayAfterSie = useMemo(() => {
    if (!sieLastDate) return null
    const d = new Date(sieLastDate)
    d.setDate(d.getDate() + 1)
    return d.toISOString().split('T')[0]
  }, [sieLastDate])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Välj konton att synka — {bankName}</DialogTitle>
          <DialogDescription>
            {isInitialSelection
              ? 'Banken har gett åtkomst till följande konton. Avmarkera de konton du inte vill synka transaktioner från. Inga transaktioner hämtas innan du sparar.'
              : 'Justera vilka konton som ska synkas. Konton du avmarkerar slutar synkas från nästa körning; redan importerade transaktioner ligger kvar.'}
          </DialogDescription>
        </DialogHeader>

        {isInitialSelection && (
          <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm">
            {sieLastDate && dayAfterSie ? (
              <div className="space-y-2">
                <p>
                  Vi hittade en SIE-import som täcker fram till{' '}
                  <span className="font-medium tabular-nums">{sieLastDate}</span>.
                  Vi hämtar bankhistorik från{' '}
                  <span className="font-medium tabular-nums">{dayAfterSie}</span>{' '}
                  så att inget överlappar din tidigare bokföring.
                </p>
                <button
                  type="button"
                  onClick={() => setShowCustomLookback(v => !v)}
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                  disabled={isSaving}
                >
                  {showCustomLookback ? 'Använd föreslagen period' : 'Anpassa period'}
                </button>
                {showCustomLookback && (
                  <Select
                    value={String(lookbackDays)}
                    onValueChange={(v) => setLookbackDays(Number(v))}
                    disabled={isSaving}
                  >
                    <SelectTrigger className="mt-2 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LOOKBACK_OPTIONS.map(opt => (
                        <SelectItem key={opt.days} value={String(opt.days)}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <label className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Hämta historik från
                </label>
                <Select
                  value={String(lookbackDays)}
                  onValueChange={(v) => setLookbackDays(Number(v))}
                  disabled={isSaving}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOOKBACK_OPTIONS.map(opt => (
                      <SelectItem key={opt.days} value={String(opt.days)}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  PSD2-bankregler begränsar oftast historiken till 90 dagar bakåt.
                  Vi visar exakt vad banken returnerade efter sparat val.
                  För äldre data, använd SIE- eller CSV-import.
                </p>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {selected.size} av {accounts.length} valda
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={selectAll}
              disabled={allSelected || isSaving}
              className="underline-offset-2 hover:underline disabled:opacity-50 disabled:no-underline"
            >
              Markera alla
            </button>
            <span aria-hidden>·</span>
            <button
              type="button"
              onClick={selectNone}
              disabled={noneSelected || isSaving}
              className="underline-offset-2 hover:underline disabled:opacity-50 disabled:no-underline"
            >
              Avmarkera alla
            </button>
          </div>
        </div>

        <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-border divide-y divide-border">
          {sortedAccounts.map(account => {
            const isChecked = selected.has(account.uid)
            return (
              <label
                key={account.uid}
                className="flex cursor-pointer items-center gap-3 p-3 hover:bg-muted/50"
              >
                <Checkbox
                  checked={isChecked}
                  onCheckedChange={() => toggle(account.uid)}
                  disabled={isSaving}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {account.name || account.iban || 'Okänt konto'}
                  </p>
                  {account.iban && (
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {account.iban.replace(/(.{4})/g, '$1 ').trim()}
                    </p>
                  )}
                </div>
                {account.balance !== undefined && (
                  <p className="text-sm font-medium tabular-nums shrink-0">
                    {new Intl.NumberFormat('sv-SE', {
                      style: 'currency',
                      currency: account.currency,
                    }).format(account.balance)}
                  </p>
                )}
              </label>
            )
          })}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Avbryt
          </Button>
          <Button type="button" onClick={handleSave} disabled={isSaving || noneSelected}>
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {isInitialSelection ? 'Sparar och hämtar transaktioner…' : 'Sparar…'}
              </>
            ) : (
              'Spara val'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
