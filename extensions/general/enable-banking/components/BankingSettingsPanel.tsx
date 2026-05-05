'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { Loader2, Upload } from 'lucide-react'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import { BankSelector, type Bank } from './BankSelector'
import { BankConnectionStatus } from './BankConnectionStatus'
import type { BankConnection } from '@/types'

/**
 * Self-contained banking settings panel for the enable-banking extension.
 * Loaded dynamically by the settings panel registry.
 */
export default function BankingSettingsPanel() {
  const { toast } = useToast()
  const supabase = createClient()

  const { dialogProps, confirm } = useDestructiveConfirm()
  const { company } = useCompany()

  const [bankConnections, setBankConnections] = useState<BankConnection[]>([])
  const [syncingConnectionId, setSyncingConnectionId] = useState<string | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const [connectingBankName, setConnectingBankName] = useState<string | null>(null)
  const connectingRef = useRef(false)
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [showCsvFallback, setShowCsvFallback] = useState(false)
  const [psuType, setPsuType] = useState<'personal' | 'business'>('business')

  // Must match STALE_THRESHOLD_MS in extensions/general/enable-banking/index.ts
  const PENDING_LOCK_MS = 30 * 1000

  useEffect(() => {
    fetchConnections()
    return () => {
      if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current)
    }
  }, [])

  function releaseConnectingLock() {
    connectingRef.current = false
    setIsConnecting(false)
    setConnectingBankName(null)
  }

  async function fetchConnections() {
    setIsLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    if (!company) return

    const { data: connections } = await supabase
      .from('bank_connections')
      .select('*')
      .eq('company_id', company.id)
      .order('created_at', { ascending: false })

    setBankConnections(connections || [])

    // If a pending connection exists from a recent attempt (e.g. user bounced back from
    // the bank's auth page), keep the connect button disabled until the server-side lock expires.
    const freshPending = (connections || []).find((c) => c.status === 'pending')
    if (freshPending) {
      const age = Date.now() - new Date(freshPending.created_at).getTime()
      const remaining = PENDING_LOCK_MS - age
      if (remaining > 0) {
        connectingRef.current = true
        setIsConnecting(true)
        setConnectingBankName(freshPending.bank_name)
        if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current)
        releaseTimerRef.current = setTimeout(releaseConnectingLock, remaining)
      }
    }

    setIsLoading(false)
  }

  async function handleConnectBank(bank: Bank, psuTypeOverride?: 'personal' | 'business') {
    if (connectingRef.current) return
    connectingRef.current = true
    setIsConnecting(true)
    setConnectingBankName(bank.name)

    try {
      console.log('[enable-banking] Initiating bank connection', {
        bankName: bank.name,
        bankCountry: bank.country,
        psuTypeOverride,
      })

      const body: Record<string, string> = { aspsp_name: bank.name, aspsp_country: bank.country }
      if (psuTypeOverride) body.psu_type = psuTypeOverride

      const response = await fetch('/api/extensions/ext/enable-banking/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      const data = await response.json()

      if (!response.ok) {
        console.error('[enable-banking] Connect request failed', {
          status: response.status,
          statusText: response.statusText,
          error: data.error,
          bankName: bank.name,
        })
        throw new Error(data.error)
      }

      console.log('[enable-banking] Redirecting to bank authorization', {
        connectionId: data.connection_id,
        hasAuthUrl: !!data.authorization_url,
      })
      window.location.href = data.authorization_url
    } catch (error) {
      console.error('[enable-banking] Connect flow failed', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        bankName: bank.name,
      })
      toast({
        title: 'Fel',
        description: error instanceof Error ? error.message : 'Kunde inte ansluta bank',
        variant: 'destructive',
      })
      connectingRef.current = false
      setIsConnecting(false)
      setConnectingBankName(null)
      setShowCsvFallback(true)
    }
  }

  async function handleSyncTransactions(connectionId: string) {
    setSyncingConnectionId(connectionId)

    try {
      console.log('[enable-banking] Starting sync', { connectionId })

      const response = await fetch('/api/extensions/ext/enable-banking/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: connectionId }),
      })

      const data = await response.json()

      if (!response.ok) {
        console.error('[enable-banking] Sync request failed', {
          status: response.status,
          statusText: response.statusText,
          error: data.error,
          connectionId,
        })
        throw new Error(data.error)
      }

      console.log('[enable-banking] Sync completed', {
        connectionId,
        imported: data.imported,
        duplicates: data.duplicates,
      })

      toast({
        title: 'Synkronisering klar',
        description: `${data.imported} nya transaktioner importerade`,
      })

      setShowCsvFallback(false)
      fetchConnections()
    } catch (error) {
      console.error('[enable-banking] Sync flow failed', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        connectionId,
      })
      toast({
        title: 'Fel',
        description: error instanceof Error ? error.message : 'Synkronisering misslyckades',
        variant: 'destructive',
      })
      setShowCsvFallback(true)
    }

    setSyncingConnectionId(null)
  }

  async function handleDisconnectBank(connectionId: string) {
    const ok = await confirm({
      title: 'Koppla bort bank?',
      description: 'PSD2-samtycket kommer återkallas. Befintliga transaktioner påverkas inte.',
      confirmLabel: 'Koppla bort',
      variant: 'warning',
    })
    if (!ok) return

    try {
      console.log('[enable-banking] Disconnecting bank', { connectionId })

      const response = await fetch('/api/extensions/ext/enable-banking/disconnect', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: connectionId }),
      })

      if (!response.ok) {
        const data = await response.json()
        console.error('[enable-banking] Disconnect request failed', {
          status: response.status,
          statusText: response.statusText,
          error: data.error,
          connectionId,
        })
        throw new Error(data.error || 'Disconnect failed')
      }

      console.log('[enable-banking] Bank disconnected', { connectionId })
      toast({
        title: 'Bank bortkopplad',
        description: 'Bankanslutningen och PSD2-samtycket har återkallats',
      })
      fetchConnections()
    } catch (error) {
      console.error('[enable-banking] Disconnect flow failed', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        connectionId,
      })
      toast({
        title: 'Fel',
        description: error instanceof Error ? error.message : 'Kunde inte koppla bort bank',
        variant: 'destructive',
      })
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const activeConnections = bankConnections.filter((c) => c.status === 'active')
  const actionRequiredConnections = bankConnections.filter((c) => ['expired', 'error'].includes(c.status))

  return (
    <div className="space-y-6">
      <DestructiveConfirmDialog {...dialogProps} />

      {/* Persistent CSV fallback after connection/sync failure */}
      {showCsvFallback && (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/50 p-4">
          <Upload className="h-5 w-5 shrink-0 text-muted-foreground" />
          <p className="flex-1 text-sm text-muted-foreground">
            Har du problem med bankanslutningen? Du kan importera transaktioner manuellt via bankfil.
          </p>
          <Button variant="outline" size="sm" asChild>
            <Link href="/import?mode=bank">Importera bankfil</Link>
          </Button>
        </div>
      )}

      {/* Action required — expired/error connections */}
      {actionRequiredConnections.length > 0 && (
        <Card className="border-warning/30">
          <CardHeader>
            <CardTitle>Åtgärd krävs</CardTitle>
            <CardDescription>
              Dessa anslutningar behöver uppmärksamhet.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {actionRequiredConnections.map((connection) => (
              <BankConnectionStatus
                key={connection.id}
                connection={connection}
                onSync={handleSyncTransactions}
                onDisconnect={handleDisconnectBank}
                onReconnect={handleConnectBank}
                isSyncing={syncingConnectionId === connection.id}
              />
            ))}
          </CardContent>
        </Card>
      )}

      {/* Connected banks */}
      {activeConnections.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Anslutna banker</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {activeConnections.map((connection) => (
              <BankConnectionStatus
                key={connection.id}
                connection={connection}
                onSync={handleSyncTransactions}
                onDisconnect={handleDisconnectBank}
                isSyncing={syncingConnectionId === connection.id}
              />
            ))}
          </CardContent>
        </Card>
      )}

      {/* Connect new bank */}
      <Card>
        <CardHeader>
          <CardTitle>Anslut ny bank</CardTitle>
          <CardDescription>
            Välj din bank nedan för att koppla ditt konto via PSD2.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Account type selector */}
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">Kontotyp:</span>
            <div className="inline-flex rounded-lg border border-border p-0.5">
              <button
                type="button"
                onClick={() => setPsuType('business')}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  psuType === 'business'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                Företagskonto
              </button>
              <button
                type="button"
                onClick={() => setPsuType('personal')}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  psuType === 'personal'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                Privatkonto
              </button>
            </div>
          </div>
          {psuType === 'personal' && (
            <p className="text-xs text-muted-foreground">
              Välj Privatkonto om du använder ditt personliga bankkonto för din verksamhet (vanligt för enskild firma).
            </p>
          )}
          <BankSelector
            onConnect={(bank) => handleConnectBank(bank, psuType)}
            onPsuTypeDetected={setPsuType}
            isConnecting={isConnecting}
            connectingBankName={connectingBankName}
          />
        </CardContent>
      </Card>

      {/* Info about PSD2 */}
      <Card>
        <CardHeader>
          <CardTitle>Om bankintegration (PSD2)</CardTitle>
          <CardDescription>
            Automatisk import av transaktioner via PSD2 open banking.
            Samtycket gäller i 90 dagar och behöver sedan förnyas.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Vi använder säker bankintegration (PSD2). Vi kan endast läsa transaktioner,
            aldrig flytta pengar. Du kan också importera transaktioner manuellt via
            bankfiler på importsidan.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
