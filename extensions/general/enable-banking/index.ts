import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { NextResponse } from 'next/server'
import {
  startAuthorization,
  getASPSPs,
  deleteSession,
  isSandboxMode,
  type ASPSP,
} from './lib/api-client'
import { syncAccountTransactions } from './lib/sync'
import { runReconciliation } from '@/lib/reconciliation/bank-reconciliation'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import type { StoredAccount } from './types'
import type { Transaction } from '@/types'

// Per-user limits keep one tenant from spamming any single bank handler.
// Sliding 60s windows — generous enough for legitimate retry, tight enough
// to prevent UUID probing or status-machine abuse.
const RATE_LIMIT_ACCOUNTS = { maxRequests: 20, windowMs: 60_000 }
const RATE_LIMIT_SYNC = { maxRequests: 10, windowMs: 60_000 }
const RATE_LIMIT_DISCONNECT = { maxRequests: 10, windowMs: 60_000 }

const MAX_ENABLED_UIDS = 50

/**
 * Enable Banking (PSD2) extension
 *
 * Provides automatic bank transaction sync via PSD2 open banking.
 * This is an opt-in extension — uncomment the import in loader.ts to activate.
 *
 * Required environment variables:
 * - ENABLE_BANKING_APP_ID
 * - ENABLE_BANKING_PRIVATE_KEY (base64-encoded PEM)
 * - ENABLE_BANKING_SANDBOX (optional, for sandbox mode)
 */
export const enableBankingExtension: Extension = {
  id: 'enable-banking',
  name: 'Enable Banking (PSD2)',
  version: '1.0.0',

  settingsPanel: {
    label: 'Bankintegration (PSD2)',
    path: '/settings/banking',
  },

  apiRoutes: [
    {
      method: 'GET',
      path: '/banks',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        const log = ctx?.log ?? console
        try {
          // Detect PSU type from company entity_type
          let psuType: 'personal' | 'business' = 'business'
          if (ctx?.companyId && ctx?.supabase) {
            const { data: company } = await ctx.supabase
              .from('companies')
              .select('entity_type')
              .eq('id', ctx.companyId)
              .single()
            if (company?.entity_type === 'enskild_firma') {
              psuType = 'personal'
            }
          }

          const aspsps = await getASPSPs('SE', psuType)
          const banks = aspsps.map((aspsp: ASPSP) => ({
            name: aspsp.name,
            country: aspsp.country,
            logo: aspsp.logo,
            bic: aspsp.bic,
          }))
          return NextResponse.json({ banks, psu_type: psuType, sandbox: isSandboxMode() })
        } catch (error) {
          log.error('Error fetching banks:', error)
          return NextResponse.json({
            banks: [
              { name: 'Nordea', country: 'SE', bic: 'NDEASESS' },
              { name: 'SEB', country: 'SE', bic: 'ESSESESS' },
              { name: 'Swedbank', country: 'SE', bic: 'SWEDSESS' },
              { name: 'Handelsbanken', country: 'SE', bic: 'HANDSESS' },
            ],
            sandbox: isSandboxMode(),
          })
        }
      },
    },
    {
      method: 'POST',
      path: '/connect',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        const log = ctx?.log ?? console
        const supabase = ctx?.supabase ?? await (await import('@/lib/supabase/server')).createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        if (!ctx?.companyId) {
          return NextResponse.json({ error: 'Company context required' }, { status: 400 })
        }
        const companyId = ctx.companyId

        const { aspsp_name, aspsp_country, psu_type: explicitPsuType } = await request.json()

        if (!aspsp_name || !aspsp_country) {
          return NextResponse.json(
            { error: 'aspsp_name and aspsp_country are required' },
            { status: 400 }
          )
        }

        try {
          // Detect PSU type: explicit override > company entity_type > default 'business'
          let psuType: 'personal' | 'business' = 'business'
          if (explicitPsuType === 'personal' || explicitPsuType === 'business') {
            psuType = explicitPsuType
          } else {
            const { data: company } = await supabase
              .from('companies')
              .select('entity_type')
              .eq('id', companyId)
              .single()
            if (company?.entity_type === 'enskild_firma') {
              psuType = 'personal'
            }
          }

          log.info('[enable-banking] Starting bank connection', {
            user_id: user.id,
            bank: aspsp_name,
            country: aspsp_country,
            psu_type: psuType,
          })

          // Reject if there's already a recent pending connection for this user+bank
          // to prevent double-click race conditions that confuse the bank's consent flow
          const { data: recentPending } = await supabase
            .from('bank_connections')
            .select('id, created_at')
            .eq('company_id', companyId)
            .eq('bank_name', aspsp_name)
            .eq('status', 'pending')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()

          if (recentPending) {
            const pendingAge = Date.now() - new Date(recentPending.created_at).getTime()
            const STALE_THRESHOLD_MS = 30 * 1000 // 30 seconds — long enough to cover the redirect handoff, short enough that an abandoned attempt doesn't block the user

            if (pendingAge < STALE_THRESHOLD_MS) {
              log.info('[enable-banking] Rejecting duplicate connect — recent pending exists', {
                existing_id: recentPending.id,
                age_ms: pendingAge,
              })
              return NextResponse.json(
                { error: 'En anslutning pågår redan. Vänta och försök igen.' },
                { status: 409 }
              )
            }

            // Clean up stale pending connections (older than threshold)
            log.info('[enable-banking] Cleaning up stale pending connections', {
              stale_id: recentPending.id,
              age_ms: pendingAge,
            })
            await supabase
              .from('bank_connections')
              .update({ status: 'error', error_message: 'Superseded by new connection attempt', oauth_state: null })
              .eq('company_id', companyId)
              .eq('bank_name', aspsp_name)
              .eq('status', 'pending')
          }

          const redirectUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/extensions/enable-banking/callback`

          // Generate cryptographic state token for CSRF protection
          const oauthState = crypto.randomUUID()

          const { url, authorization_id } = await startAuthorization(
            aspsp_name,
            aspsp_country,
            redirectUrl,
            oauthState,
            psuType
          )

          const { data: connection, error } = await supabase
            .from('bank_connections')
            .insert({
              company_id: companyId,
              user_id: user.id,
              provider: `${aspsp_name.toLowerCase().replace(/\s+/g, '-')}-${aspsp_country.toLowerCase()}`,
              bank_name: aspsp_name,
              authorization_id,
              oauth_state: oauthState,
              status: 'pending',
            })
            .select()
            .single()

          if (error) {
            log.error('[enable-banking] Database error storing connection', {
              errorMessage: error.message,
              errorCode: error.code,
              errorDetails: error.details,
              user_id: user.id,
              bank: aspsp_name,
            })
            throw new Error(`Failed to store connection: ${error.message}`)
          }

          return NextResponse.json({
            connection_id: connection.id,
            authorization_url: url,
          })
        } catch (error) {
          log.error('[enable-banking] Connect handler error', {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            name: error instanceof Error ? error.name : undefined,
            user_id: user.id,
            aspsp_name,
            aspsp_country,
          })
          return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Connection failed' },
            { status: 500 }
          )
        }
      },
    },
    {
      method: 'POST',
      path: '/sync',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        const log = ctx?.log ?? console
        const supabase = ctx?.supabase ?? await (await import('@/lib/supabase/server')).createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        if (!ctx?.companyId) {
          return NextResponse.json({ error: 'Company context required' }, { status: 400 })
        }
        const companyId = ctx.companyId

        const rl = await checkRateLimit({
          prefix: 'enable-banking:sync',
          identifier: user.id,
          ...RATE_LIMIT_SYNC,
        })
        if (!rl.ok) return rl.response!

        const { connection_id, days_back: rawDaysBack = 30 } = await request.json()
        const days_back = Math.min(Math.max(1, rawDaysBack), 365)

        const { data: connection, error: connectionError } = await supabase
          .from('bank_connections')
          .select('*')
          .eq('id', connection_id)
          .eq('company_id', companyId)
          .single()

        if (connectionError || !connection) {
          return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
        }

        if (connection.status !== 'active') {
          return NextResponse.json({ error: 'Connection is not active' }, { status: 400 })
        }

        try {
          // Keep the full list for write-back; sync only the enabled subset.
          // undefined enabled === true for back-compat with rows that predate
          // the per-account toggle.
          const allAccounts = (connection.accounts_data as StoredAccount[] || []).map(a => ({ ...a }))
          const accounts = allAccounts.filter(a => a.enabled !== false)

          if (accounts.length === 0) {
            return NextResponse.json(
              { error: 'Inga konton är valda för synkning. Öppna "Hantera konton" för att aktivera minst ett.' },
              { status: 400 }
            )
          }

          const toDate = new Date().toISOString().split('T')[0]
          const fromDate = new Date(Date.now() - days_back * 24 * 60 * 60 * 1000)
            .toISOString()
            .split('T')[0]
          const syncStartedAt = new Date().toISOString()

          // Use ctx.services.ingestTransactions when available
          const ingestFn = ctx?.services.ingestTransactions

          // Detect SIE overlap — skip auto-categorization if the sync range
          // overlaps with a completed SIE import to prevent double-booking.
          // Reconciliation still links bank transactions to existing GL lines.
          const { data: sieOverlap } = await supabase
            .from('sie_imports')
            .select('id')
            .eq('company_id', companyId)
            .eq('status', 'completed')
            .gte('fiscal_year_end', fromDate)
            .limit(1)
            .maybeSingle()

          // Check if user is a viewer — viewers get rawInsertOnly (no categorization)
          const { data: membership } = await supabase
            .from('company_members')
            .select('role')
            .eq('company_id', companyId)
            .eq('user_id', user.id)
            .maybeSingle()
          const isViewer = membership?.role === 'viewer'

          // Use strategy=longest when the caller asks for >= 30 days of history
          // (initial sync, manual backfill). Short windows get the implicit
          // default since there's no older data to surface.
          const syncOptions = {
            ...(sieOverlap ? { skipAutoCategorization: true } : {}),
            ...(isViewer ? { rawInsertOnly: true } : {}),
            ...(days_back >= 30 ? { strategy: 'longest' as const } : {}),
          }

          if (sieOverlap) {
            log.info('SIE import overlap detected — suppressing auto-categorization', {
              sieImportId: sieOverlap.id,
              fromDate,
              toDate,
            })
          }
          const results = await Promise.all(
            accounts.map(account => syncAccountTransactions(
              supabase,
              companyId,
              user.id,
              connection.id,
              account,
              fromDate,
              toDate,
              ingestFn,
              syncOptions
            ))
          )

          const totalImported = results.reduce((sum, r) => sum + r.imported, 0)
          const totalDuplicates = results.reduce((sum, r) => sum + r.duplicates, 0)

          // When SIE overlap is detected, run a batch reconciliation sweep.
          // The greedy algorithm considers all candidates globally (highest-
          // confidence first) and catches matches the inline per-transaction
          // pass may have missed due to processing order.
          // Skip for viewers — reconciliation updates transactions which viewers cannot do.
          if (sieOverlap && totalImported > 0 && !isViewer) {
            try {
              const reconResult = await runReconciliation(supabase, companyId, user.id, {
                dateFrom: fromDate,
                dateTo: toDate,
              })
              if (reconResult.applied > 0) {
                log.info('Post-sync batch reconciliation matched additional transactions', {
                  applied: reconResult.applied,
                  total: reconResult.matches.length,
                })
              }
            } catch {
              // Non-critical — transactions remain uncategorized for manual review
            }
          }

          const syncedAt = new Date().toISOString()
          await supabase
            .from('bank_connections')
            .update({
              accounts_data: allAccounts,
              last_synced_at: syncedAt,
            })
            .eq('id', connection.id)

          if (totalImported > 0) {
            const { data: syncedTransactions } = await supabase
              .from('transactions')
              .select('*')
              .eq('company_id', companyId)
              .eq('bank_connection_id', connection.id)
              .gte('created_at', syncStartedAt)
              .order('created_at', { ascending: false })
              .limit(totalImported)

            if (syncedTransactions && syncedTransactions.length > 0) {
              const emit = ctx?.emit ?? (await import('@/lib/events/bus')).eventBus.emit.bind((await import('@/lib/events/bus')).eventBus)
              await emit({
                type: 'transaction.synced',
                payload: { transactions: syncedTransactions as Transaction[], userId: user.id, companyId },
              })
            }
          }

          return NextResponse.json({
            imported: totalImported,
            duplicates: totalDuplicates,
            last_synced_at: syncedAt,
          })
        } catch (error) {
          log.error('[enable-banking] Sync handler error', {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            name: error instanceof Error ? error.name : undefined,
            user_id: user.id,
            connection_id,
            connectionStatus: connection.status,
            bankName: connection.bank_name,
          })
          return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Sync failed' },
            { status: 500 }
          )
        }
      },
    },
    {
      method: 'PATCH',
      path: '/accounts',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        const log = ctx?.log ?? console
        const supabase = ctx?.supabase ?? await (await import('@/lib/supabase/server')).createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // company_id must come from the verified extension context, never fall
        // back to user.id (which is a different identifier dimension and would
        // silently mis-scope queries in multi-tenant deployments).
        if (!ctx?.companyId) {
          return NextResponse.json({ error: 'Company context required' }, { status: 400 })
        }
        const companyId = ctx.companyId

        const rl = await checkRateLimit({
          prefix: 'enable-banking:accounts',
          identifier: user.id,
          ...RATE_LIMIT_ACCOUNTS,
        })
        if (!rl.ok) return rl.response!

        const body = await request.json().catch(() => null)
        const connection_id = body?.connection_id
        const enabled_uids = body?.enabled_uids

        if (typeof connection_id !== 'string' || !connection_id) {
          return NextResponse.json({ error: 'connection_id krävs' }, { status: 400 })
        }
        if (!Array.isArray(enabled_uids) || !enabled_uids.every(u => typeof u === 'string')) {
          return NextResponse.json({ error: 'enabled_uids måste vara en lista av strängar' }, { status: 400 })
        }
        if (enabled_uids.length === 0) {
          return NextResponse.json(
            { error: 'Välj minst ett konto, eller koppla bort banken om inga konton ska synkas.' },
            { status: 400 }
          )
        }
        if (enabled_uids.length > MAX_ENABLED_UIDS) {
          return NextResponse.json(
            { error: `Max ${MAX_ENABLED_UIDS} konton per anslutning.` },
            { status: 400 }
          )
        }

        const { data: connection, error: connectionError } = await supabase
          .from('bank_connections')
          .select('id, status, accounts_data, bank_name')
          .eq('id', connection_id)
          .eq('company_id', companyId)
          .single()

        if (connectionError || !connection) {
          return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
        }

        if (connection.status !== 'pending_selection' && connection.status !== 'active') {
          return NextResponse.json(
            { error: 'Anslutningen kan inte konfigureras i nuvarande status.' },
            { status: 400 }
          )
        }

        const existing = (connection.accounts_data as StoredAccount[] || []).map(a => ({ ...a }))
        const knownUids = new Set(existing.map(a => a.uid))
        const unknownUids = enabled_uids.filter(uid => !knownUids.has(uid))
        if (unknownUids.length > 0) {
          return NextResponse.json(
            { error: 'Ett eller flera konton kunde inte hittas.', unknown_uids: unknownUids },
            { status: 400 }
          )
        }

        const enabledSet = new Set(enabled_uids)
        const updatedAccounts: StoredAccount[] = existing.map(a => ({
          ...a,
          enabled: enabledSet.has(a.uid),
        }))

        // State machine: only transition pending_selection → active. Once
        // active, the status field is omitted from the update so the same
        // endpoint can be reused to change account selection without
        // re-asserting a transition that has already happened.
        const updatePayload: { accounts_data: StoredAccount[]; status?: 'active' } = {
          accounts_data: updatedAccounts,
        }
        if (connection.status === 'pending_selection') {
          updatePayload.status = 'active'
        }

        const { error: updateError } = await supabase
          .from('bank_connections')
          .update(updatePayload)
          .eq('id', connection.id)

        if (updateError) {
          log.error('[enable-banking] Failed to update account selection', {
            errorMessage: updateError.message,
            connectionId: connection.id,
            userId: user.id,
            companyId,
          })
          return NextResponse.json({ error: 'Kunde inte spara kontoval' }, { status: 500 })
        }

        const newStatus = updatePayload.status ?? connection.status
        log.info('[enable-banking] Account selection saved', {
          connectionId: connection.id,
          enabledCount: enabled_uids.length,
          totalCount: existing.length,
          previousStatus: connection.status,
          newStatus,
          userId: user.id,
          companyId,
        })

        try {
          const emit = ctx?.emit ?? (await import('@/lib/events/bus')).eventBus.emit.bind((await import('@/lib/events/bus')).eventBus)
          await emit({
            type: 'bank_connection.account_selection_changed',
            payload: {
              connectionId: connection.id,
              bankName: (connection as { bank_name?: string | null }).bank_name ?? null,
              previousStatus: connection.status,
              newStatus,
              enabledCount: enabled_uids.length,
              totalCount: existing.length,
              userId: user.id,
              companyId,
            },
          })
        } catch (emitError) {
          log.error('[enable-banking] Failed to emit account selection event', {
            errorMessage: emitError instanceof Error ? emitError.message : String(emitError),
            connectionId: connection.id,
            userId: user.id,
            companyId,
          })
        }

        return NextResponse.json({
          success: true,
          enabled_count: enabled_uids.length,
          total_count: existing.length,
        })
      },
    },
    {
      method: 'DELETE',
      path: '/disconnect',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        const log = ctx?.log ?? console
        const supabase = ctx?.supabase ?? await (await import('@/lib/supabase/server')).createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        if (!ctx?.companyId) {
          return NextResponse.json({ error: 'Company context required' }, { status: 400 })
        }
        const companyId = ctx.companyId

        const rl = await checkRateLimit({
          prefix: 'enable-banking:disconnect',
          identifier: user.id,
          ...RATE_LIMIT_DISCONNECT,
        })
        if (!rl.ok) return rl.response!

        const { connection_id } = await request.json()

        if (!connection_id) {
          return NextResponse.json({ error: 'connection_id is required' }, { status: 400 })
        }

        const { data: connection, error: findError } = await supabase
          .from('bank_connections')
          .select('id, session_id, status, bank_name')
          .eq('id', connection_id)
          .eq('company_id', companyId)
          .single()

        if (findError || !connection) {
          return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
        }

        // Revoke PSD2 consent if session exists
        if (connection.session_id) {
          try {
            await deleteSession(connection.session_id)
          } catch (error) {
            log.error('[enable-banking] Failed to revoke PSD2 session (may be expired)', {
              message: error instanceof Error ? error.message : String(error),
              sessionId: connection.session_id,
              connectionId: connection_id,
              connectionStatus: connection.status,
              userId: user.id,
              companyId,
            })
          }
        }

        const { error: updateError } = await supabase
          .from('bank_connections')
          .update({ status: 'revoked', session_id: null })
          .eq('id', connection.id)

        if (updateError) {
          log.error('[enable-banking] Failed to mark connection revoked', {
            errorMessage: updateError.message,
            connectionId: connection.id,
            userId: user.id,
            companyId,
          })
          return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 })
        }

        try {
          const emit = ctx?.emit ?? (await import('@/lib/events/bus')).eventBus.emit.bind((await import('@/lib/events/bus')).eventBus)
          await emit({
            type: 'bank_connection.revoked',
            payload: {
              connectionId: connection.id,
              bankName: (connection as { bank_name?: string | null }).bank_name ?? null,
              userId: user.id,
              companyId,
            },
          })
        } catch (emitError) {
          log.error('[enable-banking] Failed to emit revoke event', {
            errorMessage: emitError instanceof Error ? emitError.message : String(emitError),
            connectionId: connection.id,
            userId: user.id,
            companyId,
          })
        }

        return NextResponse.json({ success: true })
      },
    },
  ],

  eventHandlers: [],
}
