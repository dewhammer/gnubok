import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync } from 'crypto'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

async function generateWithPrivateKey(value: string, sandbox = false): Promise<string> {
  vi.resetModules()
  vi.stubEnv('ENABLE_BANKING_APP_ID', 'app-test')
  vi.stubEnv('ENABLE_BANKING_PRIVATE_KEY', value)
  vi.stubEnv('ENABLE_BANKING_SANDBOX', sandbox ? 'true' : '')
  const { generateJWT } = await import('../jwt')
  return generateJWT()
}

function decodePayload(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1]
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
}

describe('generateJWT', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('signs with a raw PEM private key', async () => {
    await expect(generateWithPrivateKey(pem)).resolves.toMatch(/^ey/)
  })

  it('signs with an escaped-newline PEM private key from environment variables', async () => {
    await expect(generateWithPrivateKey(pem.replace(/\n/g, '\\n'))).resolves.toMatch(/^ey/)
  })

  it('signs with a base64-wrapped PEM private key', async () => {
    await expect(generateWithPrivateKey(Buffer.from(pem, 'utf8').toString('base64'))).resolves.toMatch(/^ey/)
  })

  it('uses the sandbox host as the JWT audience when sandbox mode is enabled', async () => {
    const jwt = await generateWithPrivateKey(pem, true)
    expect(decodePayload(jwt).aud).toBe('api.tilisy.com')
  })
})
