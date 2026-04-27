'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { AlertCircle } from 'lucide-react'
import Link from 'next/link'
import type { AgentInboxItemView } from '@/app/(dashboard)/agent-inbox/page'
import type { AIRequestType } from '@/types'

interface RequestCardProps {
  item: AgentInboxItemView
  onDismiss: () => void
}

const REQUEST_LABEL: Record<AIRequestType, string> = {
  reupload_document: 'Oläslig bild',
  pick_transaction: 'Saknar matchning',
  specify_vat: 'Momssats',
  clarify_business_private: 'Privat eller business?',
  needs_manual: 'Hantera manuellt',
}

export default function RequestCard({ item, onDismiss }: RequestCardProps) {
  const req = item.request!
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)

  const handleResolve = async () => {
    setBusy(true)
    try {
      const res = await fetch(`/api/ai/requests/${req.id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) {
        const body = await res.json()
        toast({ title: 'Fel', description: body.error, variant: 'destructive' })
        return
      }
      toast({ title: 'Markerad som hanterad' })
      onDismiss()
    } finally {
      setBusy(false)
    }
  }

  // Guidance varies by request type.
  let action: React.ReactNode = null
  if (req.request_type === 'reupload_document') {
    action = (
      <Button size="sm" variant="outline" asChild>
        <Link href="/e/general/invoice-inbox">Ladda upp ny bild</Link>
      </Button>
    )
  } else if (req.request_type === 'pick_transaction' || req.request_type === 'needs_manual') {
    action = (
      <Button size="sm" variant="outline" asChild>
        <Link href="/transactions">Gå till transaktioner</Link>
      </Button>
    )
  }

  return (
    <Card className="border-warning/50">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-warning mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant="outline">{REQUEST_LABEL[req.request_type]}</Badge>
              {item.inbox_item.document && (
                <span className="text-xs text-muted-foreground truncate">
                  {item.inbox_item.document.file_name}
                </span>
              )}
            </div>
            <p className="text-sm">{req.message}</p>
            <div className="flex gap-2 mt-3 flex-wrap">
              {action}
              <Button size="sm" variant="ghost" onClick={handleResolve} disabled={busy}>
                Markera som hanterad
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
