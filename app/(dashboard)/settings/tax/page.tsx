'use client'

import { TaxSettingsForm } from '@/components/settings/TaxSettingsForm'
import { SettingsFormWrapper } from '@/components/settings/SettingsFormWrapper'
import { SettingsLoadingSkeleton } from '@/components/settings/SettingsLoadingSkeleton'
import { useSettings } from '@/components/settings/useSettings'
import type { CompanySettings } from '@/types'

export default function TaxSettingsPage() {
  const { settings, isLoading, updateSettings } = useSettings()

  if (isLoading || !settings) return <SettingsLoadingSkeleton />

  function handleSave(formData: FormData) {
    const vatRegistered = formData.get('vat_registered') === 'true'

    const updates: Record<string, unknown> = {
      f_skatt: formData.get('f_skatt') === 'true',
      vat_registered: vatRegistered,
      vat_number: vatRegistered ? ((formData.get('vat_number') as string) || null) : null,
      moms_period: vatRegistered ? ((formData.get('moms_period') as string) || null) : null,
      periodisk_sammanstallning_period:
        (formData.get('periodisk_sammanstallning_period') as string) || 'monthly',
      tax_contact_name: (formData.get('tax_contact_name') as string) || null,
      tax_contact_phone: (formData.get('tax_contact_phone') as string) || null,
      tax_contact_email: (formData.get('tax_contact_email') as string) || null,
      fiscal_year_start_month: parseInt(formData.get('fiscal_year_start_month') as string) || 1,
      pays_salaries: formData.get('pays_salaries') === 'true',
      preliminary_tax_monthly: parseFloat(formData.get('preliminary_tax_monthly') as string) || null,
    }
    return {
      updates,
      onSuccess: (data: Record<string, unknown>) => {
        updateSettings(data as Partial<CompanySettings>)
      },
    }
  }

  return (
    <SettingsFormWrapper onSave={handleSave} className="space-y-0">
      <TaxSettingsForm settings={settings} />
    </SettingsFormWrapper>
  )
}
