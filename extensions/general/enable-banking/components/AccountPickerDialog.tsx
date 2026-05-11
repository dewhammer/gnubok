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
import { useToast } from '@/components/ui/use-toast'
import { Loader2 } from 'lucide-react'
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
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (open) {
      // Start the dialog reflecting the current state. Accounts without an
      // explicit enabled flag are treated as enabled (back-compat).
      const initial = new Set<string>(
        accounts.filter(a => a.enabled !== false).map(a => a.uid)
      )
      setSelected(initial)
    }
  }, [open, accounts])

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
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Kunde inte spara kontoval')
      }

      toast({
        title: 'Kontoval sparat',
        description: `${data.enabled_count} av ${data.total_count} konton kommer synkas.`,
      })
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
                Sparar…
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
