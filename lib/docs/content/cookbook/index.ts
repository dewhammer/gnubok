/**
 * Cookbook recipe registry. Two recipes ship in PR-2 (Phase 6 docs):
 *   - quickstart: send your first invoice (high-leverage onboarding path)
 *   - webhooks: end-to-end webhook setup with sig verification + retry handling
 *
 * The remaining 4 recipes from the docs nav (ingest-bank-transactions,
 * file-vat-declaration, run-payroll-and-agi, year-end-closing) ship as
 * placeholder pages pointing at the relevant API reference. They're
 * scheduled for the docs polish follow-up after PR-3 hardening lands —
 * Stripe-grade narrative quality benefits from its own focused pass.
 */

import { QUICKSTART_MD } from './quickstart'
import { COOKBOOK_WEBHOOKS_MD } from './webhooks'

interface CookbookEntry {
  slug: string
  title: string
  /** Full markdown content, OR null if the recipe is a placeholder. */
  markdown: string | null
  /** Where the placeholder points the reader if markdown is null. */
  referenceLink?: { href: string; label: string }
  description: string
}

export const COOKBOOK: CookbookEntry[] = [
  {
    slug: 'quickstart',
    title: 'Quickstart — send your first invoice',
    markdown: QUICKSTART_MD,
    description: 'Five minutes from a fresh sandbox to an emailed invoice.',
  },
  {
    slug: 'send-first-invoice',
    title: 'Send your first invoice',
    markdown: QUICKSTART_MD, // alias of quickstart for now
    description: 'Create a customer, draft an invoice, send it, mark it paid.',
  },
  {
    slug: 'webhooks',
    title: 'Set up webhooks and verify signatures',
    markdown: COOKBOOK_WEBHOOKS_MD,
    description: 'Subscribe to events, verify HMAC, handle retries idempotently.',
  },
  {
    slug: 'set-up-webhooks-and-verify-signatures',
    title: 'Set up webhooks and verify signatures',
    markdown: COOKBOOK_WEBHOOKS_MD, // alias matching docs nav
    description: 'Subscribe to events, verify HMAC, handle retries idempotently.',
  },
  {
    slug: 'ingest-bank-transactions',
    title: 'Ingest and categorise bank transactions',
    markdown: null,
    referenceLink: { href: '/docs/api/reference/transactions', label: 'Transactions reference' },
    description: 'Push CSV/CAMT into the engine, get AI suggestions, commit.',
  },
  {
    slug: 'file-vat-declaration',
    title: 'Compute and review a VAT declaration',
    markdown: null,
    referenceLink: { href: '/docs/api/reference/reports#get-reports-vat-declaration', label: 'VAT declaration report' },
    description: 'Compute momsdeklaration rutor 05–62 and reconcile against the GL before manual submission to Skatteverket.',
  },
  {
    slug: 'run-payroll-and-agi',
    title: 'Run payroll and generate the AGI XML',
    markdown: null,
    referenceLink: { href: '/docs/api/reference/salary-runs', label: 'Salary runs reference' },
    description: 'Calculate, approve, mark paid, book, generate the AGI XML for manual submission to Skatteverket Mina Sidor.',
  },
  {
    slug: 'year-end-closing',
    title: 'Year-end closing',
    markdown: null,
    referenceLink: { href: '/docs/api/reference/fiscal-periods', label: 'Fiscal periods reference' },
    description: 'Lock periods, run year-end, set opening balances.',
  },
]

export function findRecipe(slug: string): CookbookEntry | undefined {
  return COOKBOOK.find((c) => c.slug === slug)
}

export const COOKBOOK_SLUGS = COOKBOOK.map((c) => c.slug)

export function buildPlaceholderMd(entry: CookbookEntry): string {
  const link = entry.referenceLink
  return [
    `# ${entry.title}`,
    '',
    `> ${entry.description}`,
    '',
    '## Coming soon',
    '',
    `This narrative cookbook recipe is in the queue alongside the Phase 6 PR-3 hardening work. The endpoints are live and documented — start from the [reference page](${link?.href ?? '/docs/api/reference'}) below and the [quickstart](/docs/api/cookbook/quickstart) for the auth + idempotency + dry-run patterns; the recipe will be a guided narrative on top.`,
    '',
    link
      ? `**Reference:** [${link.label}](${link.href})`
      : '**Reference:** [API reference](/docs/api/reference)',
    '',
    '**Related cookbooks already shipped:**',
    '',
    '- [Quickstart — send your first invoice](/docs/api/cookbook/quickstart)',
    '- [Set up webhooks and verify signatures](/docs/api/cookbook/webhooks)',
  ].join('\n')
}
