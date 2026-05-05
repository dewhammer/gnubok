/**
 * Tests for skills over MCP — registry, discovery tools, and resource exposure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tools } from '../server'
import { skills, findSkill, SKILL_URI_PREFIX, skillUri } from '../skills'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      companyId: 'company-1',
      // Minimal scopes — skills tools should be available regardless.
      scopes: [],
    }),
    createServiceClientNoCookies: vi.fn(),
  }
})

import { handleMcpRequest } from '../server'

function mcpRequest(method: string, params?: Record<string, unknown>, id: number | string = 1): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
}

async function parseResult(response: Response) {
  const json = await response.json()
  return json.result
}

describe('Skills registry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('exports a non-empty skills array', () => {
    expect(skills.length).toBeGreaterThanOrEqual(5)
  })

  it('every skill has unique slug', () => {
    const slugs = skills.map((s) => s.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('every skill body is non-trivial and contains a Tools section', () => {
    for (const s of skills) {
      expect(s.body.length, `skill ${s.slug} body length`).toBeGreaterThan(500)
      expect(s.body, `skill ${s.slug} should have a ## Tools section`).toMatch(/## Tools/i)
    }
  })

  it('every skill has the expected metadata shape', () => {
    for (const s of skills) {
      expect(s.slug).toMatch(/^[a-z0-9-]+$/)
      expect(s.name).toBeTruthy()
      expect(s.summary.length).toBeGreaterThan(20)
      expect(s.summary.length).toBeLessThan(200)
      expect(Array.isArray(s.tags)).toBe(true)
      expect(s.tags.length).toBeGreaterThan(0)
    }
  })

  it('findSkill returns the skill or null', () => {
    expect(findSkill('month-end-close')).toBeTruthy()
    expect(findSkill('does-not-exist')).toBeNull()
  })

  it('skillUri uses the gnubok://skill/ prefix', () => {
    expect(skillUri('foo')).toBe('gnubok://skill/foo')
    expect(SKILL_URI_PREFIX).toBe('gnubok://skill/')
  })
})

describe('gnubok_list_skills tool', () => {
  it('is registered with correct annotations and no scope requirement', () => {
    const tool = tools.find((t) => t.name === 'gnubok_list_skills')
    expect(tool).toBeDefined()
    expect(tool?.annotations.readOnlyHint).toBe(true)
    expect(tool?.annotations.idempotentHint).toBe(true)
  })

  it('returns all skills when called with no args', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_list_skills')!
    const result = (await tool.execute({}, 'company-1', 'user-1', {} as never, { type: 'api_key' })) as {
      skills: Array<{ slug: string; name: string; summary: string; tags: string[] }>
      count: number
    }
    expect(result.count).toBe(skills.length)
    expect(result.skills.every((s) => s.slug && s.name && s.summary)).toBe(true)
    // Body should NOT be returned by list (token saving).
    expect((result.skills[0] as Record<string, unknown>).body).toBeUndefined()
  })

  it('filters by tag', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_list_skills')!
    const result = (await tool.execute({ tag: 'vat' }, 'company-1', 'user-1', {} as never, { type: 'api_key' })) as {
      skills: Array<{ slug: string; tags: string[] }>
      count: number
    }
    expect(result.count).toBeGreaterThan(0)
    for (const s of result.skills) {
      expect(s.tags.map((t) => t.toLowerCase())).toContain('vat')
    }
  })
})

describe('gnubok_load_skill tool', () => {
  it('is registered', () => {
    const tool = tools.find((t) => t.name === 'gnubok_load_skill')
    expect(tool).toBeDefined()
  })

  it('returns full body for a valid slug', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_load_skill')!
    const result = (await tool.execute({ slug: 'month-end-close' }, 'company-1', 'user-1', {} as never, { type: 'api_key' })) as {
      slug: string
      name: string
      body: string
    }
    expect(result.slug).toBe('month-end-close')
    expect(result.body).toContain('# Month-End Close')
    expect(result.body).toContain('## Tools')
  })

  it('throws structured error for unknown slug', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_load_skill')!
    await expect(
      tool.execute({ slug: 'nonexistent-skill' }, 'company-1', 'user-1', {} as never, { type: 'api_key' })
    ).rejects.toThrow(/Skill not found.*Available skills/)
  })

  it('throws when slug is missing or empty', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_load_skill')!
    await expect(
      tool.execute({ slug: '' }, 'company-1', 'user-1', {} as never, { type: 'api_key' })
    ).rejects.toThrow(/slug is required/)
  })
})

describe('Skills via MCP protocol', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resources/list includes one entry per skill at gnubok://skill/<slug>', async () => {
    const res = await handleMcpRequest(mcpRequest('resources/list'))
    const result = await parseResult(res)
    const uris = result.resources.map((r: { uri: string }) => r.uri)
    for (const skill of skills) {
      expect(uris).toContain(skillUri(skill.slug))
    }
  })

  it('skill resources have the text/markdown mimeType', async () => {
    const res = await handleMcpRequest(mcpRequest('resources/list'))
    const result = await parseResult(res)
    const skillResources = result.resources.filter((r: { uri: string }) =>
      r.uri.startsWith(SKILL_URI_PREFIX)
    )
    expect(skillResources.length).toBe(skills.length)
    for (const r of skillResources) {
      expect(r.mimeType).toBe('text/markdown')
    }
  })

  it('resources/read returns the Markdown body for a skill URI', async () => {
    const res = await handleMcpRequest(
      mcpRequest('resources/read', { uri: 'gnubok://skill/quarterly-vat-review' })
    )
    const result = await parseResult(res)
    expect(result.contents).toHaveLength(1)
    expect(result.contents[0].uri).toBe('gnubok://skill/quarterly-vat-review')
    expect(result.contents[0].mimeType).toBe('text/markdown')
    expect(result.contents[0].text).toContain('# Quarterly VAT Review')
  })

  it('resources/read returns Resource not found for unknown skill slug', async () => {
    const res = await handleMcpRequest(
      mcpRequest('resources/read', { uri: 'gnubok://skill/does-not-exist' })
    )
    const json = await res.json()
    expect(json.error).toBeDefined()
    expect(json.error.message).toContain('Resource not found')
  })

  it('tools/list includes both skill tools', async () => {
    const res = await handleMcpRequest(mcpRequest('tools/list'))
    const result = await parseResult(res)
    const names = result.tools.map((t: { name: string }) => t.name)
    expect(names).toContain('gnubok_list_skills')
    expect(names).toContain('gnubok_load_skill')
  })
})
