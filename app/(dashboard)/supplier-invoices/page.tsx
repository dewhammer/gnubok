'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Plus, FileInput, Lock } from 'lucide-react'
import Link from 'next/link'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { SupplierInvoice } from '@/types'

function formatAmount(amount: number): string {
  return amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const statusVariants: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive'> = {
  registered: 'secondary',
  approved: 'default',
  paid: 'success',
  partially_paid: 'warning',
  overdue: 'destructive',
  disputed: 'warning',
  credited: 'secondary',
  reversed: 'secondary',
}

const statusLabels: Record<string, string> = {
  registered: 'Registrerad',
  approved: 'Godkänd',
  paid: 'Betald',
  partially_paid: 'Delbetald',
  overdue: 'Förfallen',
  disputed: 'Tvist',
  credited: 'Krediterad',
  reversed: 'Makulerad',
}

export default function SupplierInvoicesPage() {
  const { canWrite } = useCanWrite()
  const [invoices, setInvoices] = useState<(SupplierInvoice & { supplier?: { id: string; name: string } })[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('all')

  async function fetchInvoices() {
    setIsLoading(true)
    const res = await fetch('/api/supplier-invoices?status=all')
    const { data } = await res.json()
    setInvoices(data || [])
    setIsLoading(false)
  }

  useEffect(() => {
    fetchInvoices()
  }, [])

  const filteredInvoices = invoices.filter((inv) => {
    switch (activeTab) {
      case 'registered': return inv.status === 'registered'
      case 'approved': return inv.status === 'approved'
      case 'to_pay': return inv.status === 'approved' || inv.status === 'overdue'
      case 'paid': return inv.status === 'paid'
      default: return true
    }
  })

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">Leverantörsfakturor</h1>
          <p className="text-muted-foreground">
            Registrera och hantera inkommande fakturor
          </p>
        </div>
        {canWrite ? (
          <Link href="/supplier-invoices/new">
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Registrera faktura
            </Button>
          </Link>
        ) : (
          <Button
            disabled
            title="Du har endast läsbehörighet i detta företag"
          >
            <Lock className="mr-2 h-4 w-4" />
            Registrera faktura
          </Button>
        )}
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="all">Alla</TabsTrigger>
          <TabsTrigger value="registered">Registrerade</TabsTrigger>
          <TabsTrigger value="approved">Godkända</TabsTrigger>
          <TabsTrigger value="to_pay">Att betala</TabsTrigger>
          <TabsTrigger value="paid">Betalda</TabsTrigger>
        </TabsList>

        <TabsContent value={activeTab}>
          {isLoading ? (
            <Card>
              <CardContent className="p-0">
                <div className="p-3 border-b">
                  <div className="h-4 bg-muted rounded w-full animate-pulse" />
                </div>
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="flex items-center gap-4 p-3 border-b last:border-0">
                    <div className="h-4 bg-muted rounded w-12 animate-pulse" />
                    <div className="h-4 bg-muted rounded w-28 animate-pulse" />
                    <div className="h-4 bg-muted rounded w-20 animate-pulse" />
                    <div className="h-4 bg-muted rounded w-20 animate-pulse" />
                    <div className="h-4 bg-muted rounded w-20 animate-pulse" />
                    <div className="h-4 bg-muted rounded w-20 animate-pulse ml-auto" />
                    <div className="h-5 bg-muted rounded w-16 animate-pulse" />
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : filteredInvoices.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12">
                <FileInput className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">Inga fakturor</h3>
                <p className="text-muted-foreground text-center mt-1">
                  {activeTab === 'all'
                    ? 'Registrera din första leverantörsfaktura'
                    : 'Inga fakturor i denna kategori'}
                </p>
                {activeTab === 'all' && canWrite && (
                  <Link href="/supplier-invoices/new">
                    <Button className="mt-4">
                      <Plus className="mr-2 h-4 w-4" />
                      Registrera faktura
                    </Button>
                  </Link>
                )}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="p-3">Ankomst</th>
                      <th className="p-3">Leverantör</th>
                      <th className="p-3">Fakturanr</th>
                      <th className="p-3">Fakturadatum</th>
                      <th className="p-3">Förfaller</th>
                      <th className="p-3 text-right">Belopp</th>
                      <th className="p-3 text-right">Kvar att betala</th>
                      <th className="p-3">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredInvoices.map((inv) => (
                      <tr key={inv.id} className="border-b last:border-0 hover:bg-muted/50">
                        <td className="p-3 font-mono">{inv.arrival_number}</td>
                        <td className="p-3">
                          <Link href={`/suppliers/${inv.supplier_id}`} className="hover:underline">
                            {inv.supplier?.name || '-'}
                          </Link>
                        </td>
                        <td className="p-3">
                          <Link href={`/supplier-invoices/${inv.id}`} className="text-primary hover:underline">
                            {inv.supplier_invoice_number}
                          </Link>
                        </td>
                        <td className="p-3">{inv.invoice_date}</td>
                        <td className="p-3">{inv.due_date}</td>
                        <td className="p-3 text-right font-mono">{formatAmount(inv.total)}</td>
                        <td className="p-3 text-right font-mono">{formatAmount(inv.remaining_amount)}</td>
                        <td className="p-3">
                          <Badge variant={statusVariants[inv.status] || 'secondary'}>
                            {statusLabels[inv.status] || inv.status}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
