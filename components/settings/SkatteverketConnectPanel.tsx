'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { CheckCircle2, ExternalLink, ShieldOff, FlaskConical, ShieldAlert } from 'lucide-react'

type Environment = 'test' | 'prod'

type Status =
  | { connected: false; environment?: Environment; disabled?: boolean }
  | {
      connected: true
      expired: boolean
      canRefresh: boolean
      scope: string
      expiresAt: string
      environment?: Environment
      disabled?: boolean
    }

const SCOPE_LABELS: Record<string, string> = {
  momsdeklaration: 'Momsdeklaration',
  inkforetag: 'Företagsinformation',
  skahmst: 'Skattekonto – saldo & transaktioner',
  skattekonto: 'Skattekonto',
  agd: 'Arbetsgivardeklaration',
}

export function SkatteverketConnectPanel() {
  const { toast } = useToast()
  const [status, setStatus] = useState<Status | null>(null)
  const [loading, setLoading] = useState(true)
  const [disconnecting, setDisconnecting] = useState(false)

  async function loadStatus() {
    setLoading(true)
    try {
      const res = await fetch('/api/extensions/ext/skatteverket/status')
      if (res.status === 503) {
        setStatus({ connected: false })
        return
      }
      const data = (await res.json()) as Status
      setStatus(data)
    } catch {
      setStatus({ connected: false })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadStatus()
  }, [])

  function startConnect() {
    const returnTo = encodeURIComponent('/settings/skatteverket')
    window.location.href = `/api/extensions/ext/skatteverket/authorize?return_to=${returnTo}`
  }

  async function disconnect() {
    setDisconnecting(true)
    try {
      const res = await fetch('/api/extensions/ext/skatteverket/disconnect', {
        method: 'POST',
      })
      if (!res.ok) throw new Error('Frånkoppling misslyckades')
      toast({ title: 'Skatteverket frånkopplad' })
      await loadStatus()
    } catch (err) {
      toast({
        title: 'Kunde inte koppla från',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setDisconnecting(false)
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground">
          Hämtar status…
        </CardContent>
      </Card>
    )
  }

  if (!status?.connected) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Skatteverket</CardTitle>
            <EnvironmentBadge environment={status?.environment} disabled={status?.disabled} />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {status?.disabled && (
            <div className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
              <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
              <p>Skatteverket-integrationen är tillfälligt avstängd. Kontakta support.</p>
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            Anslut till Skatteverket med BankID för att skicka momsdeklaration,
            arbetsgivardeklaration och hämta saldot på skattekontot.
          </p>
          <Button onClick={startConnect} disabled={status?.disabled}>
            <ExternalLink className="mr-2 h-4 w-4" />
            Anslut med BankID
          </Button>
        </CardContent>
      </Card>
    )
  }

  const scopes = (status.scope || '').split(/\s+/).filter(Boolean)
  const expiresAtDate = new Date(status.expiresAt)
  const expiresInMinutes = Math.round(
    (expiresAtDate.getTime() - Date.now()) / 60_000,
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            Skatteverket
            {status.expired ? (
              <Badge variant="destructive">Utgången</Badge>
            ) : (
              <Badge variant="secondary">
                <CheckCircle2 className="mr-1 h-3 w-3" />
                Ansluten
              </Badge>
            )}
          </CardTitle>
          <EnvironmentBadge environment={status.environment} disabled={status.disabled} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Token utgår</dt>
            <dd className="font-medium tabular-nums">
              {expiresAtDate.toLocaleString('sv-SE')}
              {!status.expired && expiresInMinutes > 0 && (
                <span className="ml-2 text-muted-foreground">
                  (om {expiresInMinutes} min)
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Förnyelse</dt>
            <dd className="font-medium">
              {status.canRefresh ? 'Förnyas automatiskt' : 'Förnyelse uttömd — anslut igen'}
            </dd>
          </div>
        </dl>

        <div>
          <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
            Behörigheter
          </p>
          <div className="flex flex-wrap gap-2">
            {scopes.map(s => (
              <Badge key={s} variant="outline">
                {SCOPE_LABELS[s] ?? s}
              </Badge>
            ))}
          </div>
          {!scopes.includes('skahmst') && !scopes.includes('skattekonto') && (
            <p className="mt-3 text-sm text-foreground">
              Behörigheten för Skattekonto saknas — koppla från och anslut igen
              för att aktivera saldo- och transaktionsvyn.
            </p>
          )}
          {!scopes.includes('agd') && (
            <p className="mt-3 text-sm text-foreground">
              Behörigheten för Arbetsgivardeklaration (AGI) saknas — koppla
              från och anslut igen för att kunna skicka AGI direkt från {`gnubok`}.
              Tokens utfärdade innan AGI-stödet aktiverades saknar denna scope.
            </p>
          )}
        </div>

        {status.disabled && (
          <div className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
            <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
            <p>Skatteverket-integrationen är tillfälligt avstängd. Inlämningar är inaktiverade.</p>
          </div>
        )}

        <div className="flex gap-2 pt-2">
          {(status.expired || !status.canRefresh || !scopes.includes('skattekonto') || !scopes.includes('agd')) && (
            <Button onClick={startConnect} disabled={status.disabled}>
              <ExternalLink className="mr-2 h-4 w-4" />
              Anslut igen
            </Button>
          )}
          <Button
            variant="outline"
            onClick={disconnect}
            disabled={disconnecting}
          >
            <ShieldOff className="mr-2 h-4 w-4" />
            {disconnecting ? 'Kopplar från…' : 'Koppla från'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function EnvironmentBadge({ environment, disabled }: { environment?: Environment; disabled?: boolean }) {
  if (disabled) {
    return (
      <Badge variant="destructive">
        <ShieldAlert className="mr-1 h-3 w-3" />
        Avstängd
      </Badge>
    )
  }
  if (environment === 'test') {
    return (
      <Badge variant="outline" className="border-amber-400 text-amber-700 dark:border-amber-600 dark:text-amber-400">
        <FlaskConical className="mr-1 h-3 w-3" />
        Testmiljö
      </Badge>
    )
  }
  if (environment === 'prod') {
    return (
      <Badge variant="outline" className="border-emerald-400 text-emerald-700 dark:border-emerald-600 dark:text-emerald-400">
        Produktion
      </Badge>
    )
  }
  return null
}
