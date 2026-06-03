export function resolveEnableBankingApiUrl(
  env: Record<string, string | undefined> = process.env
): string {
  return (
    env.ENABLE_BANKING_API_URL_PRODUCTION ||
    env.ENABLE_BANKING_API_URL ||
    (env.ENABLE_BANKING_SANDBOX === 'true' ? 'https://api.tilisy.com' : undefined) ||
    'https://api.enablebanking.com'
  )
}

export function resolveEnableBankingJwtAudience(
  env: Record<string, string | undefined> = process.env
): string {
  return new URL(resolveEnableBankingApiUrl(env)).host
}
