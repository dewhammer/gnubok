'use client'

import { cn } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { EntityType } from '@/types'

interface ReportItem {
  value: string
  label: string
  entityType?: EntityType
}

interface ReportCategory {
  label: string
  items: ReportItem[]
}

const CATEGORIES: ReportCategory[] = [
  {
    label: 'Löpande',
    items: [
      { value: 'resultatrapport', label: 'Resultatrapport' },
      { value: 'balansrapport', label: 'Balansrapport' },
      { value: 'trial-balance', label: 'Saldobalans' },
    ],
  },
  {
    label: 'Bokslut',
    items: [
      { value: 'income-statement', label: 'Resultaträkning' },
      { value: 'balance-sheet', label: 'Balansräkning' },
    ],
  },
  {
    label: 'Skatt & moms',
    items: [
      { value: 'vat-declaration', label: 'Momsdeklaration' },
      { value: 'periodisk-sammanstallning', label: 'Periodisk sammanställning' },
      { value: 'ne-declaration', label: 'NE-bilaga', entityType: 'enskild_firma' },
      { value: 'ink2-declaration', label: 'INK2', entityType: 'aktiebolag' },
    ],
  },
  {
    label: 'Huvudböcker',
    items: [
      { value: 'huvudbok', label: 'Huvudbok' },
      { value: 'grundbok', label: 'Grundbok' },
      { value: 'kundreskontra', label: 'Kundreskontra' },
      { value: 'supplier-ledger', label: 'Leverantörsreskontra' },
    ],
  },
  {
    label: 'Avstämning',
    items: [
      { value: 'bank-reconciliation', label: 'Bankavstämning' },
    ],
  },
]

interface ReportsNavProps {
  active: string
  onChange: (value: string) => void
  entityType?: EntityType
}

export function ReportsNav({ active, onChange, entityType }: ReportsNavProps) {
  const filtered = CATEGORIES
    .map(cat => ({
      ...cat,
      items: cat.items.filter(item => !item.entityType || item.entityType === entityType),
    }))
    .filter(cat => cat.items.length > 0)

  return (
    <>
      {/* Mobile: grouped select */}
      <div className="sm:hidden">
        <Select value={active} onValueChange={onChange}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {filtered.map(cat => (
              <SelectGroup key={cat.label}>
                <SelectLabel>{cat.label}</SelectLabel>
                {cat.items.map(item => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Desktop: vertical left rail */}
      <nav
        className="hidden sm:block w-56 flex-shrink-0 sticky top-8 self-start"
        aria-label="Rapportkategorier"
      >
        <ul className="space-y-6">
          {filtered.map(cat => (
            <li key={cat.label}>
              <p className="text-[11px] font-semibold text-muted-foreground/80 uppercase tracking-[0.08em] mb-2 px-3">
                {cat.label}
              </p>
              <ul className="space-y-px">
                {cat.items.map(item => {
                  const isActive = active === item.value
                  return (
                    <li key={item.value}>
                      <button
                        type="button"
                        onClick={() => onChange(item.value)}
                        aria-current={isActive ? 'page' : undefined}
                        className={cn(
                          'w-full text-left px-3 py-1.5 rounded-md text-[13px] transition-colors',
                          isActive
                            ? 'bg-primary/10 text-foreground font-medium'
                            : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'
                        )}
                      >
                        {item.label}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </li>
          ))}
        </ul>
      </nav>
    </>
  )
}
