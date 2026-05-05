/**
 * Skills over MCP — domain-knowledge bodies the server ships alongside tools.
 *
 * A skill is a versioned Markdown document that documents *how* to compose
 * gnubok tools to accomplish a real-world workflow (month-end close, VAT
 * review, year-end, invoicing, payroll). Agents call gnubok_load_skill(slug)
 * to load only the skills they need for the current task — keeping context
 * lean while shipping deep domain knowledge alongside the protocol.
 *
 * Forward-compatible: when MCP adds a native `skills/list` primitive, the
 * Skill interface and bodies migrate without changes.
 */
export interface Skill {
  /** URL-safe id, used in tool args and resource URIs (e.g. "month-end-close"). */
  slug: string
  /** Display name (e.g. "Month-End Close"). */
  name: string
  /** One-line summary used by gnubok_list_skills. */
  summary: string
  /** Tags for filtering (e.g. ['monthly', 'vat', 'reconciliation']). */
  tags: string[]
  /** Full skill body as Markdown. */
  body: string
}

export const SKILL_MIME_TYPE = 'text/markdown' as const

/** Resource URI prefix for skills exposed via resources/read. */
export const SKILL_URI_PREFIX = 'gnubok://skill/' as const

export function skillUri(slug: string): string {
  return `${SKILL_URI_PREFIX}${slug}`
}

export function skillSlugFromUri(uri: string): string | null {
  if (!uri.startsWith(SKILL_URI_PREFIX)) return null
  return uri.slice(SKILL_URI_PREFIX.length) || null
}
