import type { Metadata } from 'next'
import { DocsLayout } from '@/components/docs/DocsLayout'
import { DocsMarkdown } from '@/lib/docs/markdown'
import { CHANGELOG_MD } from '@/lib/docs/content/changelog'

export const metadata: Metadata = {
  title: 'Changelog · gnubok API',
  description: 'Reverse-chronological release notes for the gnubok REST API.',
}

export default function DocsApiChangelogPage() {
  return (
    <DocsLayout currentPath="/docs/api/changelog">
      <DocsMarkdown source={CHANGELOG_MD} />
    </DocsLayout>
  )
}
