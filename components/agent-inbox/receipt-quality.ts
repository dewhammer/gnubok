import type { AgentInboxItemView } from '@/app/(dashboard)/agent-inbox/page'

export type ReceiptQualityIssue =
  | 'missing_merchant'
  | 'missing_total'
  | 'missing_date'
  | 'low_confidence'

export interface ReceiptQualityAssessment {
  ok: boolean
  issues: ReceiptQualityIssue[]
  message: string | null
}

const ISSUE_LABELS: Record<ReceiptQualityIssue, string> = {
  missing_merchant: 'handlare saknas',
  missing_total: 'belopp saknas',
  missing_date: 'datum saknas',
  low_confidence: 'låg extraktionssäkerhet',
}

// Heuristic quality check on a classified receipt. Until the classification
// prompt returns an explicit quality_score, we infer it from which critical
// fields came back and the LLM's self-reported confidence (stored on
// invoice_inbox_items.confidence after classification). 0.6 is the cutoff
// where accepted vs. edited rates diverge noticeably in practice.
export function assessReceiptQuality(
  inbox: AgentInboxItemView['inbox_item']
): ReceiptQualityAssessment {
  const data = inbox.extracted_data as {
    merchant?: { name?: string | null } | null
    receipt?: { date?: string | null } | null
    totals?: { total?: number | null } | null
  } | null

  const issues: ReceiptQualityIssue[] = []

  if (!data?.merchant?.name) issues.push('missing_merchant')
  if (data?.totals?.total == null) issues.push('missing_total')
  if (!data?.receipt?.date) issues.push('missing_date')

  const confidence = inbox.confidence == null ? null : Number(inbox.confidence)
  if (confidence != null && confidence < 0.6) issues.push('low_confidence')

  if (issues.length === 0) {
    return { ok: true, issues, message: null }
  }

  const labels = issues.map((i) => ISSUE_LABELS[i])
  return {
    ok: false,
    issues,
    message: `Kvittot verkar otydligt — ${labels.join(', ')}.`,
  }
}
