'use client'

import { useState } from 'react'
import { Paperclip, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/use-toast'

interface Props {
  documentId: string | null | undefined
  className?: string
}

/**
 * Compact "this transaction has an attached document" indicator.
 * Clicking fetches a signed download URL and opens the document in a new tab —
 * lets the user verify the attached receipt without first having to book the
 * transaction (which is when the doc gets linked to a journal entry).
 */
export function TransactionAttachmentIndicator({ documentId, className }: Props) {
  const { toast } = useToast()
  const [isLoading, setIsLoading] = useState(false)

  if (!documentId) return null

  const handleOpen = async (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    if (isLoading) return
    setIsLoading(true)
    try {
      const res = await fetch(`/api/documents/${documentId}`)
      if (!res.ok) {
        toast({ title: 'Kunde inte hämta underlaget', variant: 'destructive' })
        return
      }
      const { data } = await res.json()
      if (data?.download_url) {
        window.open(data.download_url, '_blank', 'noopener,noreferrer')
      }
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <button
      type="button"
      onClick={handleOpen}
      title="Underlag bifogat — klicka för att öppna"
      aria-label="Öppna bifogat underlag"
      className={cn(
        'inline-flex items-center justify-center h-5 w-5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0',
        className
      )}
    >
      {isLoading ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Paperclip className="h-3 w-3" />
      )}
    </button>
  )
}
