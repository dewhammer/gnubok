'use client'

import { useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { CompanySettings } from '@/types'

interface InvoicePreviewCardProps {
  settings: CompanySettings
}

/**
 * Live invoice PDF preview for the invoicing settings page.
 *
 * Re-fetches the preview PDF whenever the persisted `settings` change
 * (debounced 500ms so rapid toggles don't hammer the endpoint). Reads
 * the first customer in the company as a dummy recipient — the preview
 * endpoint requires a real `customer_id` and `items` payload.
 */
export function InvoicePreviewCard({ settings }: InvoicePreviewCardProps) {
  const t = useTranslations('settings_invoicing_preview')
  const locale = useLocale() as ErrorLocale
  const { company } = useCompany()
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [noCustomers, setNoCustomers] = useState(false)
  const currentUrlRef = useRef<string | null>(null)

  // Resolve translated sample-line description once per render so the
  // effect dependency stays referentially stable across renders.
  const sampleItemDescription = t('sample_item_description')

  // Debounced refresh whenever `settings` (identity) changes.
  useEffect(() => {
    if (!company?.id) return

    let cancelled = false
    const controller = new AbortController()

    const timer = setTimeout(async () => {
      setIsLoading(true)
      setError(null)
      setNoCustomers(false)

      try {
        // Pick any customer for the company — preview endpoint requires one.
        const supabase = createClient()
        const { data: customer, error: customerError } = await supabase
          .from('customers')
          .select('id')
          .eq('company_id', company.id)
          .limit(1)
          .maybeSingle()

        if (customerError) throw customerError
        if (cancelled) return

        if (!customer) {
          setNoCustomers(true)
          setIsLoading(false)
          return
        }

        const response = await fetch('/api/invoices/preview-pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            customer_id: customer.id,
            currency: 'SEK',
            document_type: 'invoice',
            items: [
              {
                description: sampleItemDescription,
                quantity: 1,
                unit: 'st',
                unit_price: 1000,
                vat_rate: 25,
              },
            ],
          }),
        })

        if (!response.ok) {
          const body = await response.json().catch(() => null)
          throw new Error(body?.error || `HTTP ${response.status}`)
        }

        const blob = await response.blob()
        if (cancelled) return

        const url = URL.createObjectURL(blob)

        // Revoke the previous blob before swapping in the new one so we
        // never leak object URLs.
        if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current)
        currentUrlRef.current = url
        setBlobUrl(url)
        setIsLoading(false)
      } catch (err) {
        if (cancelled) return
        if (err instanceof Error && err.name === 'AbortError') return
        setError(getErrorMessage(err, { locale, context: 'invoice' }))
        setIsLoading(false)
      }
    }, 500)

    return () => {
      cancelled = true
      controller.abort()
      clearTimeout(timer)
    }
  }, [settings, company?.id, sampleItemDescription, locale])

  // Final cleanup: revoke the in-flight blob URL when the component unmounts.
  useEffect(() => {
    return () => {
      if (currentUrlRef.current) {
        URL.revokeObjectURL(currentUrlRef.current)
        currentUrlRef.current = null
      }
    }
  }, [])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="space-y-2" aria-live="polite" aria-busy="true">
            <Skeleton className="h-[600px] w-full rounded-lg" />
            <p className="text-xs text-muted-foreground">{t('loading')}</p>
          </div>
        )}

        {!isLoading && noCustomers && (
          <div className="flex h-[600px] w-full items-center justify-center rounded-lg border border-border bg-muted/30 px-6 text-center">
            <p className="text-sm text-muted-foreground">{t('no_customers')}</p>
          </div>
        )}

        {!isLoading && error && (
          <div className="flex h-[600px] w-full items-center justify-center rounded-lg border border-border bg-muted/30 px-6 text-center">
            <p className="text-sm text-destructive">{t('error')}: {error}</p>
          </div>
        )}

        {!isLoading && !error && !noCustomers && blobUrl && (
          <iframe
            src={blobUrl}
            title={t('iframe_title')}
            className="w-full h-[600px] rounded-lg border border-border"
          />
        )}
      </CardContent>
    </Card>
  )
}
