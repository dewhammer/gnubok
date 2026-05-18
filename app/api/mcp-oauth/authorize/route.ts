import crypto from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { createAuthCode } from '@/lib/auth/oauth-codes'
import { requireCompanyId } from '@/lib/company/context'
import { getBranding } from '@/lib/branding/service'
import { isAllowedRedirectUri } from '@/lib/auth/oauth-allowlist'
import { API_KEY_SCOPES, type ApiKeyScope } from '@/lib/auth/api-keys'

/**
 * OAuth 2.0 Authorization Endpoint.
 *
 * GET  → show consent page (or redirect to login)
 * POST → process consent, create auth code, redirect to callback
 *
 * The API key is NOT created here — it's created in the token endpoint
 * after PKCE verification, preventing orphaned keys on abandoned flows.
 */

type ScopeParseResult =
  | { kind: 'ok'; scopes: ApiKeyScope[] | undefined }
  | { kind: 'invalid_scope'; description: string }

/**
 * Parse the OAuth `scope` query param (RFC 6749 §3.3 — space-delimited list)
 * into the subset of API_KEY_SCOPES that the user actually granted.
 *
 * Returns:
 *   - { ok, scopes: undefined } when no scope param was supplied — the token
 *     endpoint will fall back to DEFAULT_OAUTH_SCOPES (read-only, GDPR
 *     Art.25(2) data-protection-by-default).
 *   - { ok, scopes: [...] } when at least one valid scope was requested.
 *   - { invalid_scope } when a scope param was supplied but every value was
 *     unknown — refusing the request is safer than silently widening the
 *     grant to ALL_SCOPES (V10.2.6).
 *
 * The bare `mcp` marker is treated as "no granular scopes" and accepted for
 * backwards compatibility with Claude's connector — it falls through to
 * `undefined` so the default-OAuth fallback applies.
 */
function parseRequestedScopes(scopeParam: string | null): ScopeParseResult {
  if (!scopeParam) return { kind: 'ok', scopes: undefined }
  const requested = scopeParam.split(/\s+/).filter(Boolean)
  if (requested.length === 0) return { kind: 'ok', scopes: undefined }
  // The coarse-grained `mcp` marker is treated as "no granular request" so
  // we can keep Claude's existing flow working unchanged.
  const onlyMcp = requested.length === 1 && requested[0] === 'mcp'
  if (onlyMcp) return { kind: 'ok', scopes: undefined }
  const valid = requested.filter((s): s is ApiKeyScope => s in API_KEY_SCOPES)
  if (valid.length === 0) {
    return {
      kind: 'invalid_scope',
      description: 'none of the requested scopes are recognised',
    }
  }
  return { kind: 'ok', scopes: valid }
}

/**
 * Sign the scope payload so a tampered POST cannot widen the grant
 * displayed at GET. The HMAC binds the originally requested scope param to
 * the consent page that the user actually saw (V10.3.1).
 *
 * Derived from SUPABASE_SERVICE_ROLE_KEY — same root secret the auth-code
 * AEAD uses, so deploying the OAuth surface doesn't require a separate
 * signing key. Missing env vars cause /authorize to fail closed.
 */
function getScopeSigningKey(): Buffer {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for OAuth scope binding')
  return crypto.createHash('sha256').update(`oauth-scope:${secret}`).digest()
}

function signScopeBinding(scopeParam: string): string {
  return crypto.createHmac('sha256', getScopeSigningKey()).update(scopeParam).digest('base64url')
}

function verifyScopeBinding(scopeParam: string, signature: string): boolean {
  if (typeof signature !== 'string' || signature.length === 0) return false
  const expected = signScopeBinding(scopeParam)
  const expectedBuf = Buffer.from(expected, 'base64url')
  let presentedBuf: Buffer
  try {
    presentedBuf = Buffer.from(signature, 'base64url')
  } catch {
    return false
  }
  if (expectedBuf.length !== presentedBuf.length) return false
  return crypto.timingSafeEqual(expectedBuf, presentedBuf)
}

function buildLoginRedirect(request: Request): Response {
  const url = new URL(request.url)
  const next = `${url.pathname}${url.search}`
  return NextResponse.redirect(
    new URL(`/login?next=${encodeURIComponent(next)}`, url.origin)
  )
}

function errorRedirect(redirectUri: string, state: string | null, error: string, desc: string): Response {
  const url = new URL(redirectUri)
  url.searchParams.set('error', error)
  url.searchParams.set('error_description', desc)
  if (state) url.searchParams.set('state', state)
  return NextResponse.redirect(url.toString(), 303)
}

/**
 * GET /api/mcp-oauth/authorize — show consent page
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const redirectUri = url.searchParams.get('redirect_uri')
  // state and code_challenge are carried through to the POST handler via
  // the form action's url.search, so we don't read them here — they're only
  // validated on POST.
  const codeChallengeMethod = url.searchParams.get('code_challenge_method') || 'S256'
  const responseType = url.searchParams.get('response_type')
  const scopeParam = url.searchParams.get('scope')

  if (responseType !== 'code') {
    return NextResponse.json(
      { error: 'unsupported_response_type' },
      { status: 400 }
    )
  }

  if (!redirectUri) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'redirect_uri is required' },
      { status: 400 }
    )
  }

  if (codeChallengeMethod !== 'S256') {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'Only S256 code_challenge_method is supported' },
      { status: 400 }
    )
  }

  // Parse the requested scopes up front so the consent display reflects the
  // exact grant. Reject early if the client sent only unknown scopes (V10.2.6).
  const parsed = parseRequestedScopes(scopeParam)
  if (parsed.kind === 'invalid_scope') {
    return NextResponse.json(
      { error: 'invalid_scope', error_description: parsed.description },
      { status: 400 }
    )
  }

  // Check if user is logged in
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return buildLoginRedirect(request)
  }

  // Validate redirect_uri against allowlist (prevents open redirect). Passing
  // the authenticated client makes the trust boundary explicit (SOC 2 CC6.1).
  if (!(await isAllowedRedirectUri(redirectUri, supabase))) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'redirect_uri is not allowed' },
      { status: 400 }
    )
  }

  const companyId = await requireCompanyId(supabase, user.id)

  // Get company name for the consent page
  const { data: settings } = await supabase
    .from('company_settings')
    .select('company_name')
    .eq('company_id', companyId)
    .single()

  const companyName = settings?.company_name || user.email

  const appNameLower = escapeHtml(getBranding().appName.toLowerCase())

  // Bind the requested scope to the consent display. The HMAC signature is
  // verified on POST so a tampered form submission cannot widen the grant
  // beyond what the user actually saw (V10.3.1).
  const scopeBindingValue = scopeParam ?? ''
  const scopeBindingSignature = signScopeBinding(scopeBindingValue)

  // Render consent page
  const html = `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="translate" content="no">
  <title>Anslut MCP-klient — ${appNameLower}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #fafafa; color: #111; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 1rem; }
    .card { background: white; border-radius: 12px; border: 1px solid #e5e5e5; padding: 2rem; max-width: 400px; width: 100%; }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; }
    p { font-size: 0.875rem; color: #666; line-height: 1.5; margin-bottom: 1rem; }
    .account { font-size: 0.875rem; color: #111; font-weight: 500; background: #f5f5f5; padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1.5rem; }
    .permissions { font-size: 0.8125rem; color: #444; margin-bottom: 1.5rem; }
    .permissions li { margin-bottom: 0.25rem; }
    .actions { display: flex; gap: 0.75rem; }
    button { flex: 1; padding: 0.625rem 1rem; border-radius: 8px; font-size: 0.875rem; font-weight: 500; cursor: pointer; border: 1px solid #e5e5e5; }
    .allow { background: #111; color: white; border-color: #111; }
    .allow:hover { background: #333; }
    .deny { background: white; color: #111; }
    .deny:hover { background: #f5f5f5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Anslut MCP-klient</h1>
    <p>En extern applikation vill ansluta till ditt ${appNameLower}-konto.</p>
    <div class="account">${escapeHtml(companyName)}</div>
    <ul class="permissions">
      <li>Visa och kategorisera transaktioner</li>
      <li>Skapa och visa fakturor</li>
      <li>Visa kunder och rapporter</li>
      <li>Skapa verifikationer</li>
    </ul>
    <div class="actions">
      <form method="POST" action="${url.pathname}${url.search}" style="flex:1;display:flex;">
        <input type="hidden" name="consent" value="deny">
        <input type="hidden" name="scope_binding" value="${escapeHtml(scopeBindingValue)}">
        <input type="hidden" name="scope_binding_sig" value="${escapeHtml(scopeBindingSignature)}">
        <button type="submit" class="deny" style="width:100%;">Neka</button>
      </form>
      <form method="POST" action="${url.pathname}${url.search}" style="flex:1;display:flex;">
        <input type="hidden" name="consent" value="allow">
        <input type="hidden" name="scope_binding" value="${escapeHtml(scopeBindingValue)}">
        <input type="hidden" name="scope_binding_sig" value="${escapeHtml(scopeBindingSignature)}">
        <button type="submit" class="allow" style="width:100%;">Tillåt</button>
      </form>
    </div>
  </div>
</body>
</html>`

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

/**
 * POST /api/mcp-oauth/authorize — process consent, issue auth code
 */
export async function POST(request: Request) {
  const url = new URL(request.url)
  const redirectUri = url.searchParams.get('redirect_uri')
  const state = url.searchParams.get('state')
  const codeChallenge = url.searchParams.get('code_challenge') || ''
  const querystringScopeParam = url.searchParams.get('scope')

  if (!redirectUri) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }

  // Check auth
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return buildLoginRedirect(request)
  }

  // Pass the authenticated client so the lookup is bound to the same session
  // that the consent display ran under (SOC 2 CC6.1).
  if (!(await isAllowedRedirectUri(redirectUri, supabase))) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'redirect_uri is not allowed' },
      { status: 400 }
    )
  }

  await requireCompanyId(supabase, user.id)

  // Parse form body
  const formData = await request.formData()
  const consent = formData.get('consent')

  if (consent !== 'allow') {
    return errorRedirect(redirectUri, state, 'access_denied', 'User denied the request')
  }

  // Verify the scope binding signed at consent display matches what was
  // submitted with the form. This prevents a tampered POST from widening the
  // grant beyond what the user actually saw (V10.3.1).
  const presentedScopeBinding = formData.get('scope_binding')
  const presentedScopeBindingSig = formData.get('scope_binding_sig')
  const presentedScopeStr = typeof presentedScopeBinding === 'string' ? presentedScopeBinding : ''
  const presentedSigStr = typeof presentedScopeBindingSig === 'string' ? presentedScopeBindingSig : ''
  const expectedScopeStr = querystringScopeParam ?? ''
  if (
    presentedScopeStr !== expectedScopeStr ||
    !verifyScopeBinding(presentedScopeStr, presentedSigStr)
  ) {
    return errorRedirect(
      redirectUri,
      state,
      'invalid_request',
      'Scope binding mismatch — consent token is invalid or has been tampered with'
    )
  }

  // Parse the bound scope rather than re-reading the querystring at POST time
  // so the auth code always reflects the consent the user gave. parseRequestedScopes
  // already rejects requests where every scope is unknown (V10.2.6).
  const parsed = parseRequestedScopes(querystringScopeParam)
  if (parsed.kind === 'invalid_scope') {
    return errorRedirect(redirectUri, state, 'invalid_scope', parsed.description)
  }
  const requestedScopes = parsed.scopes

  // Create auth code with userId (NO API key — that's created at /token after PKCE)
  const code = createAuthCode({
    userId: user.id,
    codeChallenge,
    redirectUri,
    ...(requestedScopes ? { scopes: requestedScopes } : {}),
  })

  // Redirect to callback with the code
  const callbackUrl = new URL(redirectUri)
  callbackUrl.searchParams.set('code', code)
  if (state) callbackUrl.searchParams.set('state', state)

  // 303 See Other: forces browser to GET the callback URL, even though this
  // handler was reached via POST. NextResponse.redirect() defaults to 307,
  // which preserves POST and causes Claude's callback to return 405.
  return NextResponse.redirect(callbackUrl.toString(), 303)
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
