'use client'

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Progress } from '@/components/ui/progress'
import { Sparkles, PlayCircle, XCircle, Loader2 } from 'lucide-react'
import ProposalCard from './ProposalCard'
import RequestCard from './RequestCard'
import EditBookingDialog from './EditBookingDialog'
import LearningPromptDialog from './LearningPromptDialog'
import ChangeTransactionDialog from './ChangeTransactionDialog'
import type { AgentInboxItemView } from '@/app/(dashboard)/agent-inbox/page'
import type { AIProposal, BookingProposalPayload } from '@/types'

type FilterKey = 'all' | 'match' | 'booking'

// The match step encompasses two UI states: actual match proposals waiting
// for approval AND ai_requests where Claude couldn't find a candidate and
// asked the user to pick manually. Both belong under the "Matchning" tab.
function filterKeyFor(item: AgentInboxItemView): Exclude<FilterKey, 'all'> {
  if (item.proposal?.step_type === 'booking') return 'booking'
  return 'match'
}

interface AgentInboxProps {
  initialItems: AgentInboxItemView[]
}

interface LearningPromptState {
  proposalId: string
  counterparty_name: string
  debit_account: string
  credit_account: string
  vat_treatment: string | null
}

export default function AgentInbox({ initialItems }: AgentInboxProps) {
  const [items, setItems] = useState(initialItems)

  // After router.refresh() the server re-runs and passes a new initialItems
  // prop. useState only reads its arg on mount, so sync explicitly — otherwise
  // newly-chained booking proposals stay invisible after a match accept.
  useEffect(() => {
    setItems(initialItems)
  }, [initialItems])

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null)
  const [editProposal, setEditProposal] = useState<AIProposal | null>(null)
  const [changeMatchItem, setChangeMatchItem] = useState<AgentInboxItemView | null>(null)
  const [learningPrompt, setLearningPrompt] = useState<LearningPromptState | null>(null)
  const [backfillRunning, setBackfillRunning] = useState(false)
  const [batchRunning, setBatchRunning] = useState(false)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [backfillProgress, setBackfillProgress] = useState<{
    target: number
    startPending: number
    currentPending: number
  } | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stableTicksRef = useRef(0)
  const { toast } = useToast()
  const router = useRouter()

  // Cleanup any running poller on unmount.
  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current)
  }, [])

  // Counts per filter bucket, used on the tab triggers.
  const counts = useMemo(() => {
    let match = 0, booking = 0
    for (const i of items) {
      if (filterKeyFor(i) === 'booking') booking++
      else match++
    }
    return { all: items.length, match, booking }
  }, [items])

  const filteredItems = useMemo(() => {
    if (filter === 'all') return items
    return items.filter((i) => filterKeyFor(i) === filter)
  }, [items, filter])

  const selectableProposalIds = useMemo(
    () =>
      filteredItems
        .filter((i) => i.proposal && i.proposal.status === 'pending')
        .map((i) => i.proposal!.id),
    [filteredItems]
  )

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(selectableProposalIds))
  }, [selectableProposalIds])

  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])

  const removeItem = useCallback((proposalId: string | null, requestId: string | null) => {
    setItems((prev) =>
      prev.filter((i) => {
        if (proposalId && i.proposal?.id === proposalId) return false
        if (requestId && i.request?.id === requestId) return false
        return true
      })
    )
    if (proposalId) {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        next.delete(proposalId)
        return next
      })
    }
  }, [])

  // ── Accept ─────────────────────────────────────────────────────────
  const handleAccept = async (
    proposal: AIProposal,
    edits?: BookingProposalPayload | { matched_transaction_id: string }
  ) => {
    setBusyProposalId(proposal.id)
    try {
      const res = await fetch(`/api/ai/proposals/${proposal.id}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: proposal.version, edits }),
      })
      const body = await res.json()
      if (!res.ok) {
        toast({ title: 'Kunde inte godkänna', description: body.error, variant: 'destructive' })
        return
      }
      toast({ title: proposal.step_type === 'match' ? 'Matchning godkänd' : 'Bokförd' })

      if (body.data?.learning_prompt) {
        setLearningPrompt({
          proposalId: proposal.id,
          counterparty_name: body.data.learning_prompt.counterparty_name,
          debit_account: body.data.learning_prompt.debit_account,
          credit_account: body.data.learning_prompt.credit_account,
          vat_treatment: body.data.learning_prompt.vat_treatment,
        })
      }

      removeItem(proposal.id, null)
      // Accepting a match proposal chains to a new booking proposal (generated
      // synchronously inside the event handler during accept). Accepting a
      // booking proposal produces the terminal state. Refresh the server
      // component either way so the new state lands on screen.
      router.refresh()
    } catch (err) {
      toast({
        title: 'Fel',
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      })
    } finally {
      setBusyProposalId(null)
    }
  }

  // ── Reject ─────────────────────────────────────────────────────────
  const handleReject = async (proposal: AIProposal) => {
    setBusyProposalId(proposal.id)
    try {
      const res = await fetch(`/api/ai/proposals/${proposal.id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: proposal.version }),
      })
      const body = await res.json()
      if (!res.ok) {
        toast({ title: 'Kunde inte avvisa', description: body.error, variant: 'destructive' })
        return
      }
      toast({ title: 'Avvisad' })
      removeItem(proposal.id, null)
      router.refresh()
    } finally {
      setBusyProposalId(null)
    }
  }

  // ── Batch accept ───────────────────────────────────────────────────
  const handleBatchAccept = async () => {
    if (selectedIds.size === 0) return
    setBatchRunning(true)
    try {
      const res = await fetch('/api/ai/proposals/batch-accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposal_ids: [...selectedIds] }),
      })
      const body = await res.json()
      if (!res.ok) {
        toast({ title: 'Batch-godkännande misslyckades', description: body.error, variant: 'destructive' })
        return
      }
      const { accepted, failed, outcomes } = body.data
      toast({
        title: `${accepted} godkända${failed > 0 ? `, ${failed} misslyckades` : ''}`,
      })
      // Remove only the ones that succeeded.
      const successIds = new Set<string>(
        (outcomes as Array<{ proposal_id: string; ok: boolean }>)
          .filter((o) => o.ok)
          .map((o) => o.proposal_id)
      )
      setItems((prev) => prev.filter((i) => !(i.proposal && successIds.has(i.proposal.id))))
      clearSelection()
      router.refresh()
    } finally {
      setBatchRunning(false)
    }
  }

  // ── Backfill ───────────────────────────────────────────────────────
  //
  // The server runs a fire-and-forget loop that drafts proposals one at a
  // time. Without feedback the user clicks the button and sees nothing. So
  // here we poll the proposal count every 2s and show a progress card: the
  // target is "pending proposals count at start + queued_match + queued_booking",
  // the delta against that is progress. Poller stops when: (a) target hit,
  // (b) count hasn't moved for 3 consecutive polls (drafted everything it
  // could), or (c) user clicks cancel.
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    stableTicksRef.current = 0
  }, [])

  const fetchPendingCount = useCallback(async (): Promise<number | null> => {
    try {
      const res = await fetch('/api/ai/proposals?status=pending&limit=1')
      if (!res.ok) return null
      const body = await res.json()
      return typeof body.count === 'number' ? body.count : null
    } catch { return null }
  }, [])

  const handleBackfill = async () => {
    setBackfillRunning(true)
    try {
      // Snapshot current pending count before kicking off. The target is
      // this + the queued counts the server reports back.
      const startPending = (await fetchPendingCount()) ?? 0

      const res = await fetch('/api/ai/backfill/receipts', { method: 'POST' })
      const body = await res.json()
      if (!res.ok) {
        toast({ title: 'Kunde inte starta backfill', description: body.error, variant: 'destructive' })
        setBackfillRunning(false)
        return
      }

      const queuedTotal = (body.data.queued_match || 0) + (body.data.queued_booking || 0)
      if (queuedTotal === 0) {
        toast({ title: 'Inget att bearbeta', description: 'Alla kvitton har redan förslag.' })
        setBackfillRunning(false)
        return
      }

      setBackfillProgress({
        target: queuedTotal,
        startPending,
        currentPending: startPending,
      })
      toast({
        title: 'Bearbetar befintliga',
        description: `${queuedTotal} kvitton i kö. Det tar ca ${Math.ceil(queuedTotal * 5 / 60)} min.`,
      })

      // Start polling. First tick fires after 2s so the initial state
      // matches what the server saw on the snapshot.
      stableTicksRef.current = 0
      pollRef.current = setInterval(async () => {
        const current = await fetchPendingCount()
        if (current == null) return

        setBackfillProgress((prev) => {
          if (!prev) return prev
          const newState = { ...prev, currentPending: current }
          const done = current - prev.startPending
          if (done >= prev.target) {
            // Hit the expected target — wrap up.
            stopPolling()
            setBackfillRunning(false)
            toast({ title: 'Klart', description: `${done} förslag skapade.` })
            router.refresh()
            return null
          }
          if (current === prev.currentPending) {
            stableTicksRef.current += 1
          } else {
            stableTicksRef.current = 0
          }
          // Stability threshold: 6 ticks * 2s = 12s no change → assume loop
          // ran out of eligible items (some failed, skipped, etc).
          if (stableTicksRef.current >= 6) {
            stopPolling()
            setBackfillRunning(false)
            const short = prev.target - done
            toast({
              title: 'Backfill klar',
              description: short > 0
                ? `${done} av ${prev.target} lyckades. ${short} kunde inte bearbetas (kontrollera kvittobilderna).`
                : `${done} förslag skapade.`,
            })
            router.refresh()
            return null
          }
          // Refresh every poll so new cards appear as they're drafted.
          router.refresh()
          return newState
        })
      }, 2000)
    } catch (err) {
      toast({ title: 'Fel', description: String(err), variant: 'destructive' })
      setBackfillRunning(false)
    }
  }

  const handleCancelBackfill = async () => {
    await fetch('/api/ai/backfill/cancel', { method: 'POST' })
    stopPolling()
    setBackfillProgress(null)
    setBackfillRunning(false)
    toast({ title: 'Backfill stoppades' })
    router.refresh()
  }

  // ── Learning prompt ────────────────────────────────────────────────
  const handleRememberYes = async () => {
    if (!learningPrompt) return
    await fetch('/api/ai/learning/remember', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposal_id: learningPrompt.proposalId,
        counterparty_name: learningPrompt.counterparty_name,
        debit_account: learningPrompt.debit_account,
        credit_account: learningPrompt.credit_account,
        vat_treatment: learningPrompt.vat_treatment,
        category: null,
      }),
    })
    toast({ title: 'Sparad som mall' })
    setLearningPrompt(null)
  }

  return (
    <div className="container mx-auto p-4 sm:p-8 max-w-5xl">
      <PageHeader
        title="Agent-inkorg"
        description="AI föreslår bokföring — du godkänner varje steg."
        action={
          <div className="flex gap-2">
            {!backfillRunning ? (
              <Button variant="outline" onClick={handleBackfill} disabled={backfillRunning}>
                <PlayCircle className="mr-2 h-4 w-4" />
                Bearbeta befintliga
              </Button>
            ) : (
              <Button variant="outline" onClick={handleCancelBackfill}>
                <XCircle className="mr-2 h-4 w-4" />
                Stoppa backfill
              </Button>
            )}
          </div>
        }
      />

      {backfillProgress && (
        <BackfillProgressCard progress={backfillProgress} onCancel={handleCancelBackfill} />
      )}

      {items.length > 0 && (
        <Tabs value={filter} onValueChange={(v) => setFilter(v as FilterKey)} className="mb-4">
          <TabsList>
            <TabsTrigger value="all">Allt ({counts.all})</TabsTrigger>
            <TabsTrigger value="match">Matchning ({counts.match})</TabsTrigger>
            <TabsTrigger value="booking">Bokföring ({counts.booking})</TabsTrigger>
          </TabsList>
        </Tabs>
      )}

      {items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="p-5 rounded-full bg-muted mb-6">
              <Sparkles className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium mb-2">Inga väntande förslag</h3>
            <p className="text-sm text-muted-foreground text-center max-w-sm">
              När nya kvitton klassas i inkorgen kommer AI-förslagen att visas här.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {selectableProposalIds.length > 1 && (
            <div className="flex items-center justify-between mb-4">
              <Button variant="ghost" size="sm" onClick={selectAll}>
                Markera alla ({selectableProposalIds.length})
              </Button>
              {selectedIds.size > 0 && (
                <Button variant="ghost" size="sm" onClick={clearSelection}>
                  Avmarkera ({selectedIds.size})
                </Button>
              )}
            </div>
          )}

          <div className="flex flex-col gap-3">
            {filteredItems.length === 0 && (
              <Card>
                <CardContent className="py-10 text-center text-sm text-muted-foreground">
                  Inga kort i denna vy.
                </CardContent>
              </Card>
            )}
            {filteredItems.map((item) => {
              if (item.proposal) {
                return (
                  <ProposalCard
                    key={`p-${item.proposal.id}`}
                    item={item}
                    isSelected={selectedIds.has(item.proposal.id)}
                    isBusy={busyProposalId === item.proposal.id}
                    onToggleSelect={() => toggleSelect(item.proposal!.id)}
                    onAccept={() => handleAccept(item.proposal!)}
                    onReject={() => handleReject(item.proposal!)}
                    onEdit={() => setEditProposal(item.proposal!)}
                    onChangeMatch={() => setChangeMatchItem(item)}
                  />
                )
              }
              if (item.request) {
                return (
                  <RequestCard
                    key={`r-${item.request.id}`}
                    item={item}
                    onDismiss={() => removeItem(null, item.request!.id)}
                  />
                )
              }
              return null
            })}
          </div>

          {selectedIds.size > 0 && (
            <div className="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 bg-background border shadow-lg rounded-full px-4 py-3 flex items-center gap-3 z-40">
              <span className="text-sm font-medium">{selectedIds.size} valda</span>
              <Button size="sm" onClick={handleBatchAccept} disabled={batchRunning}>
                {batchRunning ? 'Godkänner…' : `Godkänn ${selectedIds.size} st`}
              </Button>
            </div>
          )}
        </>
      )}

      {editProposal && (
        <EditBookingDialog
          proposal={editProposal}
          onClose={() => setEditProposal(null)}
          onSubmit={async (edits) => {
            const proposal = editProposal
            setEditProposal(null)
            await handleAccept(proposal, edits)
          }}
        />
      )}

      {changeMatchItem?.proposal && (
        <ChangeTransactionDialog
          open={true}
          onOpenChange={(open) => { if (!open) setChangeMatchItem(null) }}
          proposal={changeMatchItem.proposal}
          receiptTotal={
            (changeMatchItem.inbox_item.extracted_data as { totals?: { total?: number | null } } | null)
              ?.totals?.total ?? null
          }
          receiptDate={
            (changeMatchItem.inbox_item.extracted_data as { receipt?: { date?: string | null } } | null)
              ?.receipt?.date ?? null
          }
          onChanged={() => {
            setChangeMatchItem(null)
            router.refresh()
          }}
        />
      )}

      {learningPrompt && (
        <LearningPromptDialog
          counterpartyName={learningPrompt.counterparty_name}
          debitAccount={learningPrompt.debit_account}
          creditAccount={learningPrompt.credit_account}
          onYes={handleRememberYes}
          onNo={() => setLearningPrompt(null)}
        />
      )}
    </div>
  )
}

// Progress indicator shown while "Bearbeta befintliga" runs. Target is the
// number of proposals queued at start; `done` is the delta against the
// initial pending count. Caps visible done at target to avoid flicker above
// 100% when other proposals happen to land during the run.
function BackfillProgressCard({
  progress,
  onCancel,
}: {
  progress: { target: number; startPending: number; currentPending: number }
  onCancel: () => void
}) {
  const done = Math.max(0, progress.currentPending - progress.startPending)
  const capped = Math.min(done, progress.target)
  const pct = progress.target > 0 ? Math.round((capped / progress.target) * 100) : 0
  return (
    <Card className="mb-4 border-primary/30 bg-primary/[0.02]">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span className="text-sm font-medium">Bearbetar befintliga kvitton</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm tabular-nums text-muted-foreground">
              {capped} av {progress.target}
            </span>
            <Button size="sm" variant="ghost" onClick={onCancel}>
              <XCircle className="mr-1.5 h-3.5 w-3.5" />
              Stoppa
            </Button>
          </div>
        </div>
        <Progress value={pct} />
        <p className="text-xs text-muted-foreground">
          AI-agenten skapar förslag ett kvitto i taget. Nya kort dyker upp här automatiskt.
        </p>
      </CardContent>
    </Card>
  )
}
