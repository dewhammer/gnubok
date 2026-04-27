'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { AIProposal, BookingProposalLine, BookingProposalPayload } from '@/types'

interface EditBookingDialogProps {
  proposal: AIProposal
  onClose: () => void
  onSubmit: (edits: BookingProposalPayload) => Promise<void>
}

/**
 * Minimal in-place editor for a booking proposal.
 *
 * v1 lets the user change account numbers + amounts per line; the full
 * AccountCombobox + VatTreatmentSelect UX comes in a polish pass. The
 * point of this dialog is proving the edit-accept-learning-prompt path
 * works end-to-end before we invest in the richer form.
 */
export default function EditBookingDialog({ proposal, onClose, onSubmit }: EditBookingDialogProps) {
  const original = proposal.proposal_json as BookingProposalPayload
  const [lines, setLines] = useState<BookingProposalLine[]>(original.lines)
  const [description, setDescription] = useState(original.description)
  const [submitting, setSubmitting] = useState(false)

  const totalDebit = lines.reduce((s, l) => s + (Number(l.debit_amount) || 0), 0)
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit_amount) || 0), 0)
  const balanced = Math.abs(totalDebit - totalCredit) < 0.005 && totalDebit > 0

  const updateLine = (index: number, patch: Partial<BookingProposalLine>) => {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))
  }

  const handleSubmit = async () => {
    if (!balanced) return
    setSubmitting(true)
    try {
      await onSubmit({
        ...original,
        lines,
        description,
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Redigera bokföringsförslag</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="description">Beskrivning</Label>
            <Input
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1"
            />
          </div>

          <div>
            <Label>Rader</Label>
            <div className="mt-1 border rounded">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground bg-muted/40">
                  <tr>
                    <th className="text-left p-2 font-normal">Konto</th>
                    <th className="text-left p-2 font-normal">Beskrivning</th>
                    <th className="text-right p-2 font-normal">Debet</th>
                    <th className="text-right p-2 font-normal">Kredit</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, i) => (
                    <tr key={i} className="border-t">
                      <td className="p-2">
                        <Input
                          value={line.account_number}
                          onChange={(e) => updateLine(i, { account_number: e.target.value })}
                          className="h-8 font-mono w-20"
                          maxLength={4}
                        />
                      </td>
                      <td className="p-2">
                        <Input
                          value={line.description}
                          onChange={(e) => updateLine(i, { description: e.target.value })}
                          className="h-8"
                        />
                      </td>
                      <td className="p-2">
                        <Input
                          type="number"
                          step="0.01"
                          value={line.debit_amount || ''}
                          onChange={(e) =>
                            updateLine(i, { debit_amount: parseFloat(e.target.value) || 0 })
                          }
                          className="h-8 text-right tabular-nums w-24 ml-auto"
                        />
                      </td>
                      <td className="p-2">
                        <Input
                          type="number"
                          step="0.01"
                          value={line.credit_amount || ''}
                          onChange={(e) =>
                            updateLine(i, { credit_amount: parseFloat(e.target.value) || 0 })
                          }
                          className="h-8 text-right tabular-nums w-24 ml-auto"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t text-xs">
                    <td colSpan={2} className="p-2 text-muted-foreground">
                      Summa
                    </td>
                    <td className="p-2 text-right tabular-nums">{totalDebit.toFixed(2)}</td>
                    <td className="p-2 text-right tabular-nums">{totalCredit.toFixed(2)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {!balanced && (
              <p className="text-xs text-destructive mt-1">
                Debet och kredit måste summera till samma belopp.
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={submitting}>
              Avbryt
            </Button>
            <Button onClick={handleSubmit} disabled={!balanced || submitting}>
              {submitting ? 'Bokför…' : 'Godkänn med ändringar'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
