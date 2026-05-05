'use client'

import { useEffect } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { Loader2, ArrowRight, ArrowLeft, Info } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import type { MomsPeriod, EntityType } from '@/types'

const schema = z.object({
  vat_registered: z.boolean(),
  vat_number: z.string().optional(),
  moms_period: z.enum(['monthly', 'quarterly', 'yearly']).optional(),
  accounting_method: z.enum(['accrual', 'cash']),
}).superRefine((data, ctx) => {
  if (data.vat_registered && !data.moms_period) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Välj momsredovisningsperiod.',
      path: ['moms_period'],
    })
  }
})

type FormData = z.infer<typeof schema>

interface Step4Output {
  vat_registered: boolean
  vat_number?: string
  moms_period?: MomsPeriod
  accounting_method: 'accrual' | 'cash'
}

interface Step4Props {
  initialData: Partial<Step4Output>
  entityType?: EntityType
  orgNumber?: string
  onNext: (data: Step4Output) => void
  onBack: () => void
  isSaving: boolean
}

export default function Step4VatAccounting({
  initialData,
  entityType,
  orgNumber,
  onNext,
  onBack,
  isSaving,
}: Step4Props) {
  const { toast } = useToast()

  const {
    register,
    handleSubmit,
    watch,
    control,
    setValue,
    formState: {},
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    defaultValues: {
      vat_registered: initialData.vat_registered ?? false,
      vat_number: initialData.vat_number || '',
      moms_period: initialData.moms_period,
      accounting_method: initialData.accounting_method ?? 'accrual',
    },
  })

  const vatRegistered = watch('vat_registered')
  const vatNumber = watch('vat_number')
  const accountingMethod = watch('accounting_method')

  // Auto-fill VAT number when vat_registered toggles on
  useEffect(() => {
    if (vatRegistered && !vatNumber && orgNumber) {
      const cleaned = orgNumber.replace(/[-\s]/g, '')
      if (cleaned.length >= 10) {
        setValue('vat_number', `SE${cleaned}01`)
      }
    }
  }, [vatRegistered, vatNumber, orgNumber, setValue])

  const onSubmit = (data: FormData) => {
    const output: Step4Output = {
      vat_registered: data.vat_registered,
      vat_number: data.vat_registered ? data.vat_number : undefined,
      moms_period: data.vat_registered ? data.moms_period : undefined,
      accounting_method: data.accounting_method,
    }

    onNext(output)
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Moms och bokföringsmetod</CardTitle>
          <CardDescription>
            Ange din momsregistrering och välj bokföringsmetod.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit, (errs) => {
            const fields = Object.keys(errs).join(', ')
            console.error('[onboarding] step 4 validation failed:', fields, errs)
            fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'step 4 validation failed', extra: { fields } }) }).catch(() => {})
            const firstError = Object.values(errs)[0]
            const message = firstError?.message || 'Kontrollera att alla fält är korrekt ifyllda.'
            toast({ title: 'Saknade uppgifter', description: String(message), variant: 'destructive' })
          })} className="space-y-6">
            {/* VAT section */}
            <div className="space-y-4">
              <h3 className="font-medium flex items-center gap-2">
                <InfoTooltip
                  content={
                    <div className="space-y-2">
                      <p className="font-medium">Behöver jag momsregistrera mig?</p>
                      <p>Ja, om din omsättning överstiger 120 000 kr per år. Med moms lägger du på 25% extra på dina fakturor, men får också dra av moms på dina inköp.</p>
                      <p className="text-xs text-muted-foreground">Om din omsättning överstiger 120 000 kr per år behöver du momsregistrera dig.</p>
                    </div>
                  }
                  side="right"
                >
                  <span>Momsregistrering</span>
                </InfoTooltip>
              </h3>

              <div className="flex items-start space-x-3">
                <Controller
                  name="vat_registered"
                  control={control}
                  render={({ field }) => (
                    <Checkbox
                      id="vat_registered"
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  )}
                />
                <div className="space-y-1">
                  <Label htmlFor="vat_registered" className="cursor-pointer">
                    Jag är momsregistrerad
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Obligatoriskt om din omsättning överstiger 120 000 kr per år.
                  </p>
                </div>
              </div>

              {vatRegistered && (
                <div className="space-y-4 pl-0 sm:pl-7">
                  <div className="space-y-2">
                    <Label htmlFor="vat_number">Momsregistreringsnummer</Label>
                    <Input
                      id="vat_number"
                      placeholder="SE123456789001"
                      {...register('vat_number')}
                    />
                    <p className="text-xs text-muted-foreground">
                      Format: SE + organisationsnummer + 01
                    </p>
                  </div>

                  <div className="space-y-2">
                    <InfoTooltip
                      content={
                        <div className="space-y-2">
                          <p className="font-medium">Hur ofta rapporterar du moms?</p>
                          <p>Välj den period som anges på Verksamt eller i ditt beslut från Skatteverket.</p>
                          <ul className="text-xs text-muted-foreground space-y-1">
                            <li>Under 1 miljon/år = Kan välja årsredovisning</li>
                            <li>1-40 miljoner = Kvartal</li>
                            <li>Över 40 miljoner = Månad</li>
                          </ul>
                        </div>
                      }
                      side="right"
                    >
                      <Label>Momsredovisningsperiod</Label>
                    </InfoTooltip>
                    <Controller
                      name="moms_period"
                      control={control}
                      render={({ field }) => (
                        <Select
                          value={field.value}
                          onValueChange={(v) => { if (v) field.onChange(v) }}
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
                      )}
                    />
                    <p className="text-xs text-muted-foreground">
                      Välj den period som anges i ditt beslut från Skatteverket. Vanligtvis kvartal eller år.
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Accounting method */}
            <div className="pt-4 border-t space-y-4">
              <div className="space-y-2">
                <InfoTooltip
                  content="Faktureringsmetoden bokför intäkter och kostnader när fakturan skickas/mottas. Kontantmetoden bokför vid betalning."
                  side="right"
                >
                  <Label>Bokföringsmetod</Label>
                </InfoTooltip>
                <Controller
                  name="accounting_method"
                  control={control}
                  render={({ field }) => (
                    <div className="space-y-3">
                      <div className="flex items-start space-x-3">
                        <Checkbox
                          id="method_accrual"
                          checked={field.value === 'accrual'}
                          onCheckedChange={(checked) => { if (checked) field.onChange('accrual') }}
                        />
                        <Label htmlFor="method_accrual" className="cursor-pointer">
                          Faktureringsmetoden
                        </Label>
                      </div>
                      <div className="flex items-start space-x-3">
                        <Checkbox
                          id="method_cash"
                          checked={field.value === 'cash'}
                          onCheckedChange={(checked) => { if (checked) field.onChange('cash') }}
                        />
                        <Label htmlFor="method_cash" className="cursor-pointer">
                          Kontantmetoden
                        </Label>
                      </div>
                    </div>
                  )}
                />
                <div className="rounded-lg border bg-muted/50 p-4 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Info className="h-4 w-4 text-muted-foreground" />
                    {accountingMethod === 'accrual' ? 'Faktureringsmetoden' : 'Kontantmetoden'}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {accountingMethod === 'accrual'
                      ? 'Intäkter och kostnader bokförs när fakturan skickas eller tas emot, oavsett när betalningen sker. Detta ger en mer rättvisande bild av verksamhetens ekonomi.'
                      : 'Intäkter och kostnader bokförs först när betalningen faktiskt sker. Enklare att hantera men ger en mindre exakt bild av verksamhetens ekonomi vid varje given tidpunkt.'}
                  </p>
                  <p className="text-xs text-amber-800 dark:text-amber-200 bg-warning/10 rounded px-2 py-1">
                    Kontantmetoden får användas om årlig nettoomsättning normalt är högst
                    3 MSEK (BFL 5 kap. 2 §).
                  </p>
                </div>
              </div>
            </div>

            <div className="flex justify-between pt-4">
              <Button
                type="button"
                variant="ghost"
                onClick={onBack}
                disabled={isSaving}
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Tillbaka
              </Button>
              <Button type="submit" disabled={isSaving}>
                {isSaving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Sparar...
                  </>
                ) : (
                  <>
                    Fortsätt
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </>
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
