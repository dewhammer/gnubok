'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader } from '@/components/ui/page-header'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency, formatDate } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { invoiceNumberDisplay } from '@/lib/invoices/display'
import { getDisplayTotal } from '@/lib/invoices/rounding'
import { Plus, Search, Receipt, Lock } from 'lucide-react'
import { EmptyInvoices } from '@/components/ui/empty-state'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { Invoice, InvoiceStatus } from '@/types'

const statusConfig: Record<InvoiceStatus, { label: string; variant: 'default' | 'secondary' | 'success' | 'warning' | 'destructive'; borderColor: string }> = {
  draft: { label: 'Utkast', variant: 'secondary', borderColor: 'border-muted-foreground/30' },
  sent: { label: 'Skickad', variant: 'default', borderColor: 'border-warning/50' },
  paid: { label: 'Betald', variant: 'success', borderColor: 'border-success/50' },
  partially_paid: { label: 'Delbetalad', variant: 'warning', borderColor: 'border-warning/50' },
  overdue: { label: 'Förfallen', variant: 'destructive', borderColor: 'border-destructive/50' },
  cancelled: { label: 'Makulerad', variant: 'secondary', borderColor: 'border-muted-foreground/30' },
  credited: { label: 'Krediterad', variant: 'secondary', borderColor: 'border-muted-foreground/30' },
}

function getRelativeTimeLabel(dueDateStr: string, status: InvoiceStatus): { text: string; color: string } | null {
  if (status === 'paid' || status === 'cancelled' || status === 'credited' || status === 'draft') return null

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const dueDate = new Date(dueDateStr)
  dueDate.setHours(0, 0, 0, 0)
  const diffDays = Math.round((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))

  if (diffDays < 0) {
    return { text: `${Math.abs(diffDays)} dagar försenad`, color: 'text-destructive' }
  } else if (diffDays === 0) {
    return { text: 'Förfaller idag', color: 'text-warning-foreground' }
  } else if (diffDays <= 3) {
    return { text: `${diffDays} dagar kvar`, color: 'text-warning-foreground' }
  } else if (diffDays <= 7) {
    return { text: `${diffDays} dagar kvar`, color: 'text-muted-foreground' }
  }
  return null
}

export default function InvoicesPage() {
  const { company } = useCompany()
  const { canWrite } = useCanWrite()
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [oreRounding, setOreRounding] = useState<boolean>(true)
  const [isLoading, setIsLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [activeTab, setActiveTab] = useState('all')
  const { toast } = useToast()
  const supabase = createClient()

  async function fetchInvoices() {
    if (!company) return
    setIsLoading(true)
    const [invoicesResult, settingsResult] = await Promise.all([
      supabase
        .from('invoices')
        .select('*, customer:customers(name)')
        .eq('company_id', company.id)
        .order('invoice_date', { ascending: false }),
      supabase
        .from('company_settings')
        .select('ore_rounding')
        .eq('company_id', company.id)
        .maybeSingle(),
    ])

    if (invoicesResult.error) {
      toast({
        title: 'Kunde inte ladda fakturor',
        description: 'Kontrollera din anslutning och försök igen.',
        variant: 'destructive',
      })
    } else {
      setInvoices(invoicesResult.data || [])
    }
    setOreRounding(settingsResult.data?.ore_rounding ?? true)
    setIsLoading(false)
  }

  useEffect(() => {
    fetchInvoices()
  }, [])

  const filteredInvoices = invoices.filter((invoice) => {
    const matchesSearch =
      (invoice.invoice_number ?? '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (invoice.customer as { name: string })?.name?.toLowerCase().includes(searchTerm.toLowerCase())

    const isCreditNote = !!invoice.credited_invoice_id
    const docType = (invoice as Invoice & { document_type?: string }).document_type || 'invoice'
    // Cancelled invoices are kept in the table for compliance but hidden from
    // the default 'Alla' view; they only show up when the user explicitly picks
    // the 'Makulerade' tab.
    const matchesTab =
      (activeTab === 'all' && invoice.status !== 'cancelled') ||
      (activeTab === 'unpaid' && ['sent', 'overdue'].includes(invoice.status) && !isCreditNote && docType === 'invoice') ||
      (activeTab === 'credit' && isCreditNote) ||
      (activeTab === 'proforma' && docType === 'proforma' && invoice.status !== 'cancelled') ||
      (activeTab === 'delivery_note' && docType === 'delivery_note' && invoice.status !== 'cancelled') ||
      (activeTab === 'cancelled' && invoice.status === 'cancelled') ||
      (activeTab !== 'all' && activeTab !== 'proforma' && activeTab !== 'delivery_note' && activeTab !== 'cancelled' && invoice.status === activeTab)

    return matchesSearch && matchesTab
  })

  const isOutstandingReceivable = (i: Invoice) =>
    ['sent', 'overdue'].includes(i.status) && !i.credited_invoice_id
  const stats = {
    unpaid: invoices.filter(isOutstandingReceivable).length,
    unpaidAmount: invoices
      .filter(isOutstandingReceivable)
      .reduce((sum, i) => {
        if (i.currency === 'SEK') {
          return sum + getDisplayTotal({ total: Number(i.total), currency: 'SEK' }, { ore_rounding: oreRounding }).displayed
        }
        return sum + Number(i.total_sek || i.total)
      }, 0),
    overdue: invoices.filter((i) => i.status === 'overdue' && !i.credited_invoice_id).length,
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Fakturor"
        description="Skicka fakturor, följ betalningar och skapa kreditnotor"
        action={
          canWrite ? (
            <Link href="/invoices/new">
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Ny faktura
              </Button>
            </Link>
          ) : (
            <Button
              disabled
              title="Du har endast läsbehörighet i detta företag"
            >
              <Lock className="mr-2 h-4 w-4" />
              Ny faktura
            </Button>
          )
        }
      />

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        {isLoading ? (
          <>
            {[1, 2, 3].map((i) => (
              <Card key={i}>
                <CardContent className="pt-6">
                  <div className="space-y-2">
                    <div className="h-3.5 bg-muted rounded w-20 animate-pulse" />
                    <div className="h-7 bg-muted rounded w-16 animate-pulse" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </>
        ) : (
          <>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Totalt antal</p>
                <p className="font-display text-2xl font-medium tabular-nums">{invoices.length}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Obetalda</p>
                <div className="flex items-center gap-2">
                  <p className="font-display text-2xl font-medium tabular-nums">{stats.unpaid}</p>
                  {stats.overdue > 0 && (
                    <Badge variant="destructive" className="text-xs">
                      {stats.overdue} förfallna
                    </Badge>
                  )}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Att få in</p>
                <p className="font-display text-2xl font-medium tabular-nums">{formatCurrency(stats.unpaidAmount)}</p>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Search and tabs */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Sök på fakturanummer eller kund..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
          />
        </div>
        {/* Mobile: dropdown select */}
        <Select value={activeTab} onValueChange={setActiveTab}>
          <SelectTrigger className="sm:hidden w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alla</SelectItem>
            <SelectItem value="unpaid">Obetalda</SelectItem>
            <SelectItem value="paid">Betalda</SelectItem>
            <SelectItem value="draft">Utkast</SelectItem>
            <SelectItem value="proforma">Proforma</SelectItem>
            <SelectItem value="delivery_note">Följesedel</SelectItem>
            <SelectItem value="credit">Kredit</SelectItem>
            <SelectItem value="cancelled">Makulerade</SelectItem>
          </SelectContent>
        </Select>
        {/* Desktop: tab bar */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="hidden sm:block">
          <TabsList>
            <TabsTrigger value="all">Alla</TabsTrigger>
            <TabsTrigger value="unpaid">Obetalda</TabsTrigger>
            <TabsTrigger value="paid">Betalda</TabsTrigger>
            <TabsTrigger value="draft">Utkast</TabsTrigger>
            <TabsTrigger value="proforma">Proforma</TabsTrigger>
            <TabsTrigger value="delivery_note">Följesedel</TabsTrigger>
            <TabsTrigger value="credit">Kredit</TabsTrigger>
            <TabsTrigger value="cancelled">Makulerade</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Invoice list */}
      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-2">
                    <div className="h-5 bg-muted rounded w-32" />
                    <div className="h-4 bg-muted rounded w-48" />
                  </div>
                  <div className="h-8 bg-muted rounded w-24" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : filteredInvoices.length === 0 ? (
        <Card>
          <CardContent>
            {searchTerm ? (
              <div className="flex flex-col items-center justify-center py-12">
                <Receipt className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">Inga träffar</h3>
                <p className="text-muted-foreground text-center mt-1">
                  Inga fakturor matchar &quot;{searchTerm}&quot;
                </p>
              </div>
            ) : invoices.length === 0 ? (
              <EmptyInvoices />
            ) : (
              <div className="flex flex-col items-center justify-center py-12">
                <Receipt className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">Inga fakturor i denna kategori</h3>
                <p className="text-muted-foreground text-center mt-1">
                  Prova att byta flik för att se fler fakturor
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filteredInvoices.map((invoice) => {
            const status = statusConfig[invoice.status]
            const isCreditNote = !!invoice.credited_invoice_id
            const docType = (invoice as Invoice & { document_type?: string }).document_type || 'invoice'
            const isProforma = docType === 'proforma'
            const isDeliveryNote = docType === 'delivery_note'
            const relativeTime = invoice.due_date ? getRelativeTimeLabel(invoice.due_date, invoice.status) : null
            return (
              <Link key={invoice.id} href={`/invoices/${invoice.id}`}>
                <Card className={cn(
                  'cursor-pointer transition-all duration-150 hover:border-primary/50 hover:bg-accent/50 hover:shadow-sm active:scale-[0.99] active:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  isCreditNote ? 'border-destructive/30' : isProforma ? 'border-primary/30' : isDeliveryNote ? 'border-success/30' : status.borderColor,
                  invoice.status === 'overdue' && 'ring-1 ring-destructive/20'
                )}>
                  <CardContent className="py-4">
                    <div className="min-w-0">
                        <div className="flex items-start sm:items-center justify-between gap-2">
                          <p className={cn('font-medium truncate', !invoice.invoice_number && 'italic text-muted-foreground')}>{invoiceNumberDisplay(invoice.invoice_number)}</p>
                          <p className={`font-medium tabular-nums shrink-0 ${isCreditNote ? 'text-destructive' : ''}`}>
                            {formatCurrency(
                              getDisplayTotal({ total: Number(invoice.total), currency: invoice.currency }, { ore_rounding: oreRounding }).displayed,
                              invoice.currency,
                            )}
                          </p>
                        </div>
                        <p className="text-sm text-muted-foreground truncate">
                          {(invoice.customer as { name: string })?.name} · {formatDate(invoice.invoice_date)}
                        </p>
                        <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                          {isCreditNote && (
                            <Badge variant="destructive" className="text-xs">
                              Kredit
                            </Badge>
                          )}
                          {isProforma && (
                            <Badge variant="secondary" className="text-xs bg-primary/10 text-primary">
                              Proforma
                            </Badge>
                          )}
                          {isDeliveryNote && (
                            <Badge variant="secondary" className="text-xs bg-success/10 text-success">
                              Följesedel
                            </Badge>
                          )}
                          <Badge variant={status.variant as 'default' | 'secondary' | 'destructive'}>
                            {status.label}
                          </Badge>
                          {relativeTime && (
                            <span className={`text-xs font-medium ${relativeTime.color}`}>
                              {relativeTime.text}
                            </span>
                          )}
                        </div>
                        {invoice.currency !== 'SEK' && invoice.total_sek && (
                          <p className={`text-xs tabular-nums mt-0.5 ${isCreditNote ? 'text-destructive/70' : 'text-muted-foreground'}`}>
                            {formatCurrency(Number(invoice.total_sek))}
                          </p>
                        )}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
