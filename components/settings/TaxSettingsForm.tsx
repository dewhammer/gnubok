'use client'

import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import type { CompanySettings } from '@/types'

interface TaxSettingsFormProps {
  settings: CompanySettings
}

export function TaxSettingsForm({ settings }: TaxSettingsFormProps) {
  const [vatRegistered, setVatRegistered] = useState(settings.vat_registered ?? false)
  const [fSkatt, setFSkatt] = useState(settings.f_skatt ?? true)
  const [paysSalaries, setPaysSalaries] = useState(settings.pays_salaries ?? false)

  const isEnskildFirma = settings.entity_type === 'enskild_firma'

  return (
    <div className="space-y-8">
      {/* Entity type — read-only */}
      <section className="space-y-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Företagsform
        </h2>
        <div className="flex items-center gap-3">
          <Badge variant="secondary" className="text-sm">
            {settings.entity_type === 'aktiebolag' ? 'Aktiebolag' : 'Enskild firma'}
          </Badge>
          <p className="text-xs text-muted-foreground">
            Företagsform kan inte ändras. Kontakta support vid behov.
          </p>
        </div>
      </section>

      {/* F-skatt */}
      <section className="border-t border-border/8 pt-8 space-y-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Skatt & moms
        </h2>

        <div className="space-y-4">
          <div className="flex items-start space-x-3">
            <Checkbox
              id="f_skatt"
              checked={fSkatt}
              onCheckedChange={(v) => setFSkatt(v === true)}
            />
            <input type="hidden" name="f_skatt" value={fSkatt ? 'true' : 'false'} />
            <div className="space-y-1">
              <Label htmlFor="f_skatt" className="cursor-pointer">F-skattsedel</Label>
              <p className="text-xs text-muted-foreground">
                Godkänd för F-skatt (självständig näringsverksamhet).
              </p>
            </div>
          </div>

          <div className="flex items-start space-x-3">
            <Checkbox
              id="vat_registered"
              checked={vatRegistered}
              onCheckedChange={(v) => setVatRegistered(v === true)}
            />
            <input type="hidden" name="vat_registered" value={vatRegistered ? 'true' : 'false'} />
            <div className="space-y-1">
              <Label htmlFor="vat_registered" className="cursor-pointer">Momsregistrerad</Label>
              <p className="text-xs text-muted-foreground">
                Obligatoriskt om omsättningen överstiger 120 000 kr per år.
              </p>
            </div>
          </div>

          {vatRegistered && (
            <div className="space-y-4 pl-7">
              <div className="max-w-xs space-y-2">
                <Label htmlFor="vat_number">Momsregistreringsnummer</Label>
                <Input
                  id="vat_number"
                  name="vat_number"
                  placeholder="SE123456789001"
                  defaultValue={settings.vat_number || ''}
                />
                <p className="text-xs text-muted-foreground">
                  Format: SE + organisationsnummer + 01
                </p>
              </div>

              <div className="max-w-xs space-y-2">
                <Label>Momsredovisningsperiod</Label>
                <Select
                  name="moms_period"
                  defaultValue={settings.moms_period || undefined}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Välj period" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">Månad</SelectItem>
                    <SelectItem value="quarterly">Kvartal</SelectItem>
                    <SelectItem value="yearly">År</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Enligt beslut från Skatteverket.
                </p>
              </div>

              <div className="max-w-xs space-y-2">
                <Label>Period för periodisk sammanställning</Label>
                <Select
                  name="periodisk_sammanstallning_period"
                  defaultValue={settings.periodisk_sammanstallning_period || 'monthly'}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Välj period" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">Månad</SelectItem>
                    <SelectItem value="quarterly">Kvartal</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Varuförsäljning till EU ska normalt rapporteras månadsvis (35 kap. 2 § SFL).
                  Kvartal kräver tillstånd från Skatteverket och gäller endast tjänsteförsäljning.
                </p>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Tax contact — required for SKV-filings */}
      <section className="border-t border-border/8 pt-8 space-y-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Kontaktperson för skatteärenden
        </h2>
        <p className="text-xs text-muted-foreground -mt-2">
          Används som avsändare på filer till Skatteverket (periodisk sammanställning m.m.).
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl">
          <div className="space-y-2">
            <Label htmlFor="tax_contact_name">Namn</Label>
            <Input
              id="tax_contact_name"
              name="tax_contact_name"
              defaultValue={settings.tax_contact_name || ''}
              placeholder="Anna Andersson"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tax_contact_phone">Telefon</Label>
            <Input
              id="tax_contact_phone"
              name="tax_contact_phone"
              defaultValue={settings.tax_contact_phone || ''}
              placeholder="08-123 45 67"
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="tax_contact_email">E-post</Label>
            <Input
              id="tax_contact_email"
              name="tax_contact_email"
              type="email"
              defaultValue={settings.tax_contact_email || ''}
              placeholder="anna@foretaget.se"
            />
          </div>
        </div>
      </section>

      {/* Fiscal year & salaries */}
      <section className="border-t border-border/8 pt-8 space-y-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Räkenskapsår & löner
        </h2>

        <div className="max-w-xs space-y-2">
          <Label>Räkenskapsårets startmånad</Label>
          {isEnskildFirma ? (
            <>
              <Input value="Januari" disabled />
              <input type="hidden" name="fiscal_year_start_month" value="1" />
              <p className="text-xs text-muted-foreground">
                Enskild firma måste använda kalenderår (BFL 3 kap.).
              </p>
            </>
          ) : (
            <>
              <Select
                name="fiscal_year_start_month"
                defaultValue={String(settings.fiscal_year_start_month || 1)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[
                    'Januari', 'Februari', 'Mars', 'April', 'Maj', 'Juni',
                    'Juli', 'Augusti', 'September', 'Oktober', 'November', 'December',
                  ].map((month, i) => (
                    <SelectItem key={i + 1} value={String(i + 1)}>{month}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Ändring påverkar framtida räkenskapsår.
              </p>
            </>
          )}
        </div>

        <div className="flex items-start space-x-3">
          <Checkbox
            id="pays_salaries"
            checked={paysSalaries}
            onCheckedChange={(v) => setPaysSalaries(v === true)}
          />
          <input type="hidden" name="pays_salaries" value={paysSalaries ? 'true' : 'false'} />
          <div className="space-y-1">
            <Label htmlFor="pays_salaries" className="cursor-pointer">Betalar löner</Label>
            <p className="text-xs text-muted-foreground">
              Påverkar vilka skattedeadlines som visas (arbetsgivardeklaration m.m.).
            </p>
          </div>
        </div>
      </section>

      {/* Preliminary tax */}
      <section className="border-t border-border/8 pt-8 space-y-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Preliminärskatt
        </h2>

        <div className="max-w-xs space-y-2">
          <Label htmlFor="preliminary_tax_monthly">
            Månatlig preliminärskatt (F-skatt)
          </Label>
          <Input
            id="preliminary_tax_monthly"
            name="preliminary_tax_monthly"
            type="number"
            defaultValue={settings.preliminary_tax_monthly || ''}
          />
          <p className="text-xs text-muted-foreground">
            Belopp i SEK som betalas varje månad.
          </p>
        </div>
      </section>
    </div>
  )
}
