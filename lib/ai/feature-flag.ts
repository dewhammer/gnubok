/**
 * Agent-inkorg feature flag.
 *
 * The AI bookkeeping agent isn't ready for general availability in production.
 * This helper gates the whole feature — sidebar link, page, API routes, and
 * orchestrator event handlers — behind either:
 *
 *   1. NODE_ENV === 'development'        (local dev: always on)
 *   2. NEXT_PUBLIC_AGENT_INBOX_ENABLED=true (opt-in for staging/prod QA)
 *
 * The escape hatch lets us flip the feature on for a specific Vercel
 * deployment (staging) without a code change, and keeps prod deployments
 * safely dark until we explicitly enable it.
 *
 * Mirrors the pattern used for Salary in components/dashboard/DashboardNav.tsx.
 */

import { NextResponse } from 'next/server'

export function isAgentInboxEnabled(): boolean {
  if (process.env.NODE_ENV === 'development') return true
  return process.env.NEXT_PUBLIC_AGENT_INBOX_ENABLED === 'true'
}

/**
 * 404 early-return for API routes. Returns the response when disabled, null
 * when enabled. Usage:
 *
 *   const gate = gateAgentInbox()
 *   if (gate) return gate
 */
export function gateAgentInbox(): NextResponse | null {
  if (isAgentInboxEnabled()) return null
  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}
