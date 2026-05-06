import { NextResponse } from 'next/server'
import { generateApiKey, DEFAULT_SCOPES, validateScopes } from '@/lib/auth/api-keys'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { ApiKeyScope } from '@/lib/auth/api-keys'

/** GET /api/settings/api-keys — list the company's API keys (key value never returned). */
export const GET = withRouteContext(
  'api_key.list',
  async (_request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { data, error } = await supabase
      .from('api_keys')
      .select('id, key_prefix, name, scopes, rate_limit_rpm, last_used_at, revoked_at, created_at')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })

    if (error) {
      log.error('api_keys list failed', error)
      return errorResponse(error, log, { requestId })
    }

    return NextResponse.json({ data })
  },
)

/**
 * POST /api/settings/api-keys — create a new API key.
 *
 * Returns the full key exactly once; after this the prefix is the only
 * stored representation.
 */
export const POST = withRouteContext(
  'api_key.create',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    let name = 'Unnamed key'
    let scopes: ApiKeyScope[] = DEFAULT_SCOPES
    try {
      const body = await request.json()
      if (body.name && typeof body.name === 'string') {
        name = body.name.slice(0, 100)
      }
      const parsed = validateScopes(body.scopes)
      if (parsed) {
        scopes = parsed
      } else if (body.scopes !== undefined) {
        return errorResponseFromCode('API_KEY_SCOPE_INVALID', log, {
          requestId,
          details: { received: body.scopes },
        })
      }
    } catch {
      // Empty body — use defaults.
    }

    const { count } = await supabase
      .from('api_keys')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .is('revoked_at', null)

    if (count !== null && count >= 10) {
      return errorResponseFromCode('API_KEY_QUOTA_EXCEEDED', log, {
        requestId,
        details: { activeCount: count, limit: 10 },
      })
    }

    const { key, hash, prefix } = generateApiKey()

    const { data, error } = await supabase
      .from('api_keys')
      .insert({
        user_id: user.id,
        company_id: companyId,
        key_hash: hash,
        key_prefix: prefix,
        name,
        scopes,
      })
      .select('id, key_prefix, name, scopes, created_at')
      .single()

    if (error) {
      log.error('api_key insert failed', error)
      return errorResponseFromCode('API_KEY_CREATE_FAILED', log, {
        requestId,
        details: { reason: error.message },
      })
    }

    return NextResponse.json({
      data: {
        ...data,
        key, // only time the full key is returned
      },
    })
  },
  { requireWrite: true },
)
