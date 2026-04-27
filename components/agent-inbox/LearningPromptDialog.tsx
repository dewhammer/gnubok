'use client'

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface LearningPromptDialogProps {
  counterpartyName: string
  debitAccount: string
  creditAccount: string
  onYes: () => void
  onNo: () => void
}

export default function LearningPromptDialog({
  counterpartyName,
  debitAccount,
  creditAccount,
  onYes,
  onNo,
}: LearningPromptDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onNo()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Kom ihåg denna bokföring?</DialogTitle>
        </DialogHeader>
        <p className="text-sm">
          Vill du att AI:n använder samma kontering nästa gång ett kvitto från{' '}
          <strong>{counterpartyName}</strong> dyker upp?
        </p>
        <p className="text-xs text-muted-foreground font-mono">
          Debet {debitAccount} · Kredit {creditAccount}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onNo}>
            Bara den här gången
          </Button>
          <Button onClick={onYes}>Ja, kom ihåg</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
