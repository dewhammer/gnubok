import { redirect } from 'next/navigation'

type SearchParams = Record<string, string | string[] | undefined>

export default async function NewExpenseRedirectPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue
    if (Array.isArray(value)) {
      for (const v of value) qs.append(key, v)
    } else {
      qs.set(key, value)
    }
  }
  const suffix = qs.toString()
  redirect(`/supplier-invoices/new${suffix ? `?${suffix}` : ''}`)
}
