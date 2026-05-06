'use client'

import { useState, useEffect, useCallback, Fragment } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency } from '@/lib/utils'
import {
  ClipboardCheck,
  Loader2,
  ArrowLeftRight,
  Users,
  Receipt,
  CheckCircle2,
  XCircle,
  Bot,
} from 'lucide-react'
import type { PendingOperation, PendingOperationStatus } from '@/types'

const operationLabels: Record<string, { label: string; icon: typeof ArrowLeftRight; variant: 'default' | 'secondary' | 'outline' }> = {
  categorize_transaction: { label: 'Kategorisering', icon: ArrowLeftRight, variant: 'default' },
  create_customer: { label: 'Ny kund', icon: Users, variant: 'secondary' },
  create_invoice: { label: 'Ny faktura', icon: Receipt, variant: 'outline' },
  create_transaction: { label: 'Ny transaktion', icon: ArrowLeftRight, variant: 'secondary' },
  mark_invoice_paid: { label: 'Betald faktura', icon: Receipt, variant: 'default' },
  send_invoice: { label: 'Skicka faktura', icon: Receipt, variant: 'outline' },
  mark_invoice_sent: { label: 'Markera skickad', icon: Receipt, variant: 'outline' },
  match_transaction_invoice: { label: 'Fakturamatchning', icon: ArrowLeftRight, variant: 'secondary' },
}

function formatRelativeTime(dateStr: string): string {
  const now = new Date()
  const date = new Date(dateStr)
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)

  if (diffMin < 1) return 'just nu'
  if (diffMin < 60) return `${diffMin} min sedan`
  const diffHours = Math.floor(diffMin / 60)
  if (diffHours < 24) return `${diffHours} tim sedan`
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays} dagar sedan`
}

function CategorizePreview({ data }: { data: Record<string, unknown> }) {
  const vatLines = (data.vat_lines as Array<{ account_number: string; debit_amount: number; credit_amount: number; description: string }>) || []

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">Debetkonto</span>
        <span className="font-mono">{String(data.debit_account ?? '')}</span>
        <span className="text-muted-foreground">Kreditkonto</span>
        <span className="font-mono">{String(data.credit_account ?? '')}</span>
        <span className="text-muted-foreground">Belopp</span>
        <span className="font-mono tabular-nums">
          {formatCurrency(data.amount as number, (data.currency as string) || 'SEK')}
        </span>
      </div>
      {vatLines.length > 0 && (
        <div className="border-t pt-2">
          <p className="text-xs text-muted-foreground mb-1">Momsrader</p>
          {vatLines.map((line, i) => (
            <div key={i} className="flex justify-between font-mono text-xs">
              <span>{line.account_number} {line.description}</span>
              <span className="tabular-nums">
                {line.debit_amount > 0 ? `D ${formatCurrency(line.debit_amount)}` : `K ${formatCurrency(line.credit_amount)}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CustomerPreview({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      <span className="text-muted-foreground">Namn</span>
      <span>{String(data.name ?? '')}</span>
      <span className="text-muted-foreground">Typ</span>
      <span>{String(data.customer_type ?? '')}</span>
      {data.email ? (
        <>
          <span className="text-muted-foreground">E-post</span>
          <span>{String(data.email)}</span>
        </>
      ) : null}
      {data.org_number ? (
        <>
          <span className="text-muted-foreground">Org.nr</span>
          <span className="font-mono">{String(data.org_number)}</span>
        </>
      ) : null}
    </div>
  )
}

function InvoicePreview({ data }: { data: Record<string, unknown> }) {
  const items = (data.items as Array<{ description: string; quantity: number; unit: string; unit_price: number; line_total: number; vat_rate: number }>) || []

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">Kund</span>
        <span>{String(data.customer_name ?? '')}</span>
        <span className="text-muted-foreground">Datum</span>
        <span>{String(data.invoice_date ?? '')}</span>
        <span className="text-muted-foreground">Förfallodatum</span>
        <span>{String(data.due_date ?? '')}</span>
      </div>
      {items.length > 0 && (
        <div className="border-t pt-2 space-y-1">
          {items.map((item, i) => (
            <div key={i} className="flex justify-between text-xs">
              <span className="truncate mr-4">{item.description} ({item.quantity} {item.unit})</span>
              <span className="font-mono tabular-nums whitespace-nowrap">
                {formatCurrency(item.line_total, (data.currency as string) || 'SEK')}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="border-t pt-2 grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">Netto</span>
        <span className="font-mono tabular-nums text-right">{formatCurrency(data.subtotal as number, (data.currency as string) || 'SEK')}</span>
        <span className="text-muted-foreground">Moms</span>
        <span className="font-mono tabular-nums text-right">{formatCurrency(data.vat_amount as number, (data.currency as string) || 'SEK')}</span>
        <span className="font-medium">Totalt</span>
        <span className="font-mono tabular-nums font-medium text-right">{formatCurrency(data.total as number, (data.currency as string) || 'SEK')}</span>
      </div>
    </div>
  )
}

function CreateTransactionPreview({ data }: { data: Record<string, unknown> }) {
  const amount = data.amount as number
  const currency = (data.currency as string) || 'SEK'

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      <span className="text-muted-foreground">Datum</span>
      <span className="font-mono">{String(data.date ?? '')}</span>
      <span className="text-muted-foreground">Beskrivning</span>
      <span className="truncate">{String(data.description ?? '')}</span>
      <span className="text-muted-foreground">Belopp</span>
      <span className="font-mono tabular-nums">
        {formatCurrency(amount, currency)}
      </span>
      {data.external_id ? (
        <>
          <span className="text-muted-foreground">Extern referens</span>
          <span className="font-mono text-xs truncate">{String(data.external_id)}</span>
        </>
      ) : null}
    </div>
  )
}

function GenericPreview({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, v]) => v != null && v !== '')
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      {entries.map(([key, value]) => (
        <Fragment key={key}>
          <span className="text-muted-foreground">{key.replace(/_/g, ' ')}</span>
          <span className={typeof value === 'number' ? 'font-mono tabular-nums' : ''}>
            {String(value)}
          </span>
        </Fragment>
      ))}
    </div>
  )
}

function OperationPreview({ op }: { op: PendingOperation }) {
  switch (op.operation_type) {
    case 'categorize_transaction':
      return <CategorizePreview data={op.preview_data} />
    case 'create_customer':
      return <CustomerPreview data={op.preview_data} />
    case 'create_invoice':
      return <InvoicePreview data={op.preview_data} />
    case 'create_transaction':
      return <CreateTransactionPreview data={op.preview_data} />
    default:
      return <GenericPreview data={op.preview_data} />
  }
}

type SourceFilter = 'all' | 'agent' | 'high_risk'

export default function PendingOperationsPage() {
  const [operations, setOperations] = useState<PendingOperation[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<PendingOperationStatus>('pending')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [selectedOp, setSelectedOp] = useState<PendingOperation | null>(null)
  const [showCommitDialog, setShowCommitDialog] = useState(false)
  const [isCommitting, setIsCommitting] = useState(false)
  const { toast } = useToast()
  const { dialogProps, confirm } = useDestructiveConfirm()

  const fetchOperations = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await fetch(`/api/pending-operations?status=${activeTab}`)
      const json = await res.json()
      setOperations(json.data ?? [])
    } catch {
      toast({ title: 'Kunde inte ladda operationer', variant: 'destructive' })
    }
    setIsLoading(false)
  }, [activeTab, toast])

  useEffect(() => {
    fetchOperations()
  }, [fetchOperations])

  async function handleCommit() {
    if (!selectedOp) return
    setIsCommitting(true)
    try {
      const res = await fetch(`/api/pending-operations/${selectedOp.id}/commit`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Misslyckades')
      toast({ title: 'Godkänd', description: selectedOp.title })
      setShowCommitDialog(false)
      setSelectedOp(null)
      fetchOperations()
    } catch (err) {
      toast({
        title: 'Misslyckades',
        description: err instanceof Error ? err.message : 'Okänt fel',
        variant: 'destructive',
      })
    }
    setIsCommitting(false)
  }

  async function handleReject(op: PendingOperation) {
    const ok = await confirm({
      title: 'Avvisa operation?',
      description: `"${op.title}" kommer att avvisas.`,
      confirmLabel: 'Avvisa',
      variant: 'destructive',
    })
    if (!ok) return

    try {
      const res = await fetch(`/api/pending-operations/${op.id}/reject`, { method: 'POST' })
      if (!res.ok) throw new Error('Misslyckades')
      toast({ title: 'Avvisad', description: op.title })
      fetchOperations()
    } catch {
      toast({ title: 'Kunde inte avvisa', variant: 'destructive' })
    }
  }

  const warningForType: Record<string, string> = {
    categorize_transaction: '',
    create_customer: '',
    create_invoice: '',
  }

  const filteredOperations = operations.filter((op) => {
    switch (sourceFilter) {
      case 'agent':
        return op.actor_type === 'api_key' || op.actor_type === 'mcp_oauth' || op.actor_type === 'cron'
      case 'high_risk':
        return op.risk_level === 'high'
      case 'all':
      default:
        return true
    }
  })

  return (
    <div className="space-y-6">
      <PageHeader
        title="Granskning"
        description="Operationer som väntar på godkännande"
      />

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as PendingOperationStatus)}>
        <TabsList>
          <TabsTrigger value="pending">Väntande</TabsTrigger>
          <TabsTrigger value="committed">Godkända</TabsTrigger>
          <TabsTrigger value="rejected">Avvisade</TabsTrigger>
        </TabsList>
      </Tabs>

      <Tabs value={sourceFilter} onValueChange={(v) => setSourceFilter(v as SourceFilter)}>
        <TabsList>
          <TabsTrigger value="all">Alla</TabsTrigger>
          <TabsTrigger value="agent">Från agent</TabsTrigger>
          <TabsTrigger value="high_risk">Hög risk</TabsTrigger>
        </TabsList>
      </Tabs>

      {isLoading ? (
        <Card>
          <CardContent className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      ) : filteredOperations.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-4">
              <ClipboardCheck className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="font-medium">
              {activeTab === 'pending'
                ? 'Inga väntande operationer'
                : activeTab === 'committed'
                  ? 'Inga godkända operationer'
                  : 'Inga avvisade operationer'}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              {activeTab === 'pending'
                ? 'När en operation kräver godkännande visas den här för granskning.'
                : 'Operationer du har godkänt eller avvisat visas här.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filteredOperations.map((op) => {
            const config = operationLabels[op.operation_type] || { label: op.operation_type, icon: ClipboardCheck, variant: 'default' as const }
            const isExpanded = expandedId === op.id

            return (
              <Card
                key={op.id}
                className="transition-colors hover:border-primary/30"
              >
                <CardContent className="py-4">
                  <div
                    className="flex items-start justify-between gap-4 cursor-pointer"
                    onClick={() => setExpandedId(isExpanded ? null : op.id)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <Badge variant={config.variant}>{config.label}</Badge>
                        {op.risk_level === 'high' && (
                          <Badge variant="outline" className="border-terracotta/40 text-terracotta">
                            Hög risk
                          </Badge>
                        )}
                        {op.actor_type && op.actor_type !== 'user' && (
                          <Badge variant="outline" className="text-xs">
                            <Bot className="h-3 w-3 mr-1" />
                            {op.actor_label || op.actor_type}
                          </Badge>
                        )}
                        {op.status === 'committed' && (
                          <Badge variant="default" className="bg-emerald-500/10 text-emerald-600 border-emerald-200">
                            <CheckCircle2 className="h-3 w-3 mr-1" />
                            Godkänd
                          </Badge>
                        )}
                        {op.status === 'rejected' && (
                          <Badge variant="destructive" className="bg-destructive/10">
                            <XCircle className="h-3 w-3 mr-1" />
                            Avvisad
                          </Badge>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {formatRelativeTime(op.created_at)}
                        </span>
                      </div>
                      <p className="text-sm font-medium truncate">{op.title}</p>
                    </div>

                    {op.status === 'pending' && (
                      <div className="flex gap-2 flex-shrink-0">
                        <Button
                          size="sm"
                          className="h-8 px-3 text-xs"
                          onClick={(e) => {
                            e.stopPropagation()
                            setSelectedOp(op)
                            setShowCommitDialog(true)
                          }}
                        >
                          Godkänn
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 px-3 text-xs"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleReject(op)
                          }}
                        >
                          Avvisa
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* Expandable preview */}
                  <div className={`grid transition-all duration-200 ${isExpanded ? 'grid-rows-[1fr] mt-3' : 'grid-rows-[0fr]'}`}>
                    <div className="overflow-hidden">
                      <div className="border-t pt-3">
                        <OperationPreview op={op} />
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* Commit confirmation dialog */}
      <ConfirmationDialog
        open={showCommitDialog}
        onOpenChange={setShowCommitDialog}
        title={selectedOp?.title || 'Godkänn operation'}
        warningText={selectedOp ? warningForType[selectedOp.operation_type] : ''}
        confirmLabel="Godkänn"
        isSubmitting={isCommitting}
        onConfirm={handleCommit}
      >
        {selectedOp && <OperationPreview op={selectedOp} />}
      </ConfirmationDialog>

      {/* Reject confirmation dialog */}
      <DestructiveConfirmDialog {...dialogProps} />
    </div>
  )
}
