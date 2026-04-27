'use client'

import Link from 'next/link'
import { SettingsFormWrapper } from '@/components/settings/SettingsFormWrapper'
import { SettingsLoadingSkeleton } from '@/components/settings/SettingsLoadingSkeleton'
import { PeriodLockingSettings } from '@/components/settings/PeriodLockingSettings'
import { VoucherSeriesManager } from '@/components/settings/VoucherSeriesManager'
import { useSettings } from '@/components/settings/useSettings'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ExternalLink, Sparkles } from 'lucide-react'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { isAgentInboxEnabled } from '@/lib/ai/feature-flag'
import type { CompanySettings } from '@/types'

const SERIES_OPTIONS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

export default function BookkeepingSettingsPage() {
  const { settings, isLoading, updateSettings } = useSettings()
  const aiAgentAvailable = ENABLED_EXTENSION_IDS.has('ai-agent') && isAgentInboxEnabled()

  if (isLoading || !settings) return <SettingsLoadingSkeleton />

  function handleSave(formData: FormData) {
    const autoLockValue = formData.get('auto_lock_period_days') as string
    const lockedThrough = (formData.get('bookkeeping_locked_through') as string) || null
    const accountingMethod = (formData.get('accounting_method') as string) || 'accrual'
    const defaultVoucherSeries = (formData.get('default_voucher_series') as string) || 'A'
    const aiFlowEnabled = formData.get('ai_flow_enabled') === 'on'

    const updates: Record<string, unknown> = {
      bookkeeping_locked_through: lockedThrough,
      auto_lock_period_days: autoLockValue === 'none' ? null : parseInt(autoLockValue),
      accounting_method: accountingMethod,
      default_voucher_series: defaultVoucherSeries,
    }
    if (aiAgentAvailable) {
      updates.ai_flow_enabled = aiFlowEnabled
    }
    return {
      updates,
      onSuccess: (data: Record<string, unknown>) => {
        updateSettings(data as Partial<CompanySettings>)
      },
    }
  }

  return (
    <div className="space-y-8">
      <SettingsFormWrapper onSave={handleSave} className="space-y-8">
        {/* Accounting method */}
        <section className="space-y-4">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Bokföringsmetod
          </h2>
          <div className="space-y-2">
            <Label htmlFor="accounting_method">Metod</Label>
            <select
              id="accounting_method"
              name="accounting_method"
              defaultValue={settings.accounting_method || 'accrual'}
              className="flex h-10 w-full max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <option value="accrual">Faktureringsmetoden</option>
              <option value="cash">Kontantmetoden</option>
            </select>
            <p className="text-xs text-muted-foreground">
              {settings.entity_type === 'aktiebolag'
                ? 'Aktiebolag med omsättning över 3 MSEK måste använda faktureringsmetoden.'
                : 'Kontantmetoden är tillgänglig för enskild firma med omsättning under 3 MSEK.'}
            </p>
          </div>
        </section>

        {/* Default voucher series */}
        <div className="border-t border-border/8 pt-8">
          <section className="space-y-4">
            <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Standardserie för verifikationer
            </h2>
            <div className="space-y-2">
              <Label htmlFor="default_voucher_series">Serie</Label>
              <select
                id="default_voucher_series"
                name="default_voucher_series"
                defaultValue={settings.default_voucher_series || 'A'}
                className="flex h-10 w-16 rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {SERIES_OPTIONS.map((letter) => (
                  <option key={letter} value={letter}>{letter}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Vilken serie som förväljs vid manuell bokföring. Kan ändras per verifikation.
              </p>
            </div>
          </section>
        </div>

        {/* Period locking */}
        <div className="border-t border-border/8 pt-8">
          <PeriodLockingSettings settings={settings} />
        </div>

        {/* AI agent (beta) — gated on extension availability */}
        {aiAgentAvailable && (
          <div className="border-t border-border/8 pt-8">
            <section className="space-y-4">
              <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5" />
                AI-agent (beta)
              </h2>
              <div className="flex items-start gap-3">
                <Switch
                  id="ai_flow_enabled"
                  name="ai_flow_enabled"
                  defaultChecked={Boolean(settings.ai_flow_enabled)}
                />
                <div className="space-y-1">
                  <Label htmlFor="ai_flow_enabled">Aktivera agent-inkorgen</Label>
                  <p className="text-xs text-muted-foreground max-w-prose">
                    När aktiv: varje ny banktransaktion blir ett AI-förslag du granskar i
                    <Link href="/agent-inbox" className="underline ml-1">agent-inkorgen</Link>.
                    Den automatiska bokföringen (≥80% regelmatchning) stängs av — inget bokförs
                    utan din bekräftelse.
                  </p>
                </div>
              </div>
            </section>
          </div>
        )}
      </SettingsFormWrapper>

      {/* Voucher series — read-only display */}
      <div className="border-t border-border/8 pt-8">
        <VoucherSeriesManager defaultSeries={settings.default_voucher_series || 'A'} />
      </div>

      {/* Cross-links */}
      <div className="border-t border-border/8 pt-8 space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Relaterat
        </h2>
        <div className="flex flex-col gap-2">
          <Link
            href="/bookkeeping"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Räkenskapsår och ingående balanser
          </Link>
          <Link
            href="/bookkeeping"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Kontoplan (BAS)
          </Link>
        </div>
      </div>
    </div>
  )
}
