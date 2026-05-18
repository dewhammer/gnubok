import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireWritePermission } from '@/lib/auth/require-write'
import { z } from 'zod'

/**
 * GET  /api/settings/oauth-clients — list the current user's registered
 *                                    redirect URIs.
 * POST /api/settings/oauth-clients — register a new redirect URI for use
 *                                    with the MCP OAuth flow.
 *
 * Built-in patterns (claude.ai, claude.com, localhost) bypass this table
 * entirely — registrations here are only for self-hosted custom apps.
 */

const RegistrationSchema = z.object({
  client_name: z.string().trim().min(1).max(100),
  // Require https for non-loopback URIs. We reject loopback here because
  // localhost is already on the built-in allowlist — there's no reason to
  // register it explicitly.
  redirect_uri: z
    .string()
    .url('redirect_uri must be a valid URL')
    .refine((u) => u.startsWith('https://'), 'redirect_uri must use https://')
    .refine(
      (u) => !/^https:\/\/(localhost|127\.0\.0\.1|::1)(:|\/|$)/i.test(u),
      'localhost is already allowed without registration'
    )
    .max(500),
})

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('oauth_client_registrations')
    .select('id, client_name, redirect_uri, created_at, revoked_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  let body: z.infer<typeof RegistrationSchema>
  try {
    const json = await request.json()
    body = RegistrationSchema.parse(json)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid request body' },
      { status: 400 }
    )
  }

  const { data, error } = await supabase
    .from('oauth_client_registrations')
    .insert({
      user_id: user.id,
      client_name: body.client_name,
      redirect_uri: body.redirect_uri,
    })
    .select('id, client_name, redirect_uri, created_at')
    .single()

  if (error) {
    // Unique-index violation on redirect_uri → 409
    if (error.code === '23505') {
      return NextResponse.json(
        { error: 'Den här redirect URI:n är redan registrerad.' },
        { status: 409 }
      )
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}
