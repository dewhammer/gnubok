import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { generateSIEExport } from '@/lib/reports/sie-export'
import { requireCompanyId } from '@/lib/company/context'

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')

  if (!periodId) {
    return NextResponse.json({ error: 'period_id is required' }, { status: 400 })
  }

  // Get company settings for SIE metadata
  const { data: company } = await supabase
    .from('company_settings')
    .select('company_name, org_number')
    .eq('company_id', companyId)
    .single()

  if (!company) {
    return NextResponse.json({ error: 'Company settings not found' }, { status: 404 })
  }

  try {
    const sieContent = await generateSIEExport(supabase, companyId, {
      fiscal_period_id: periodId,
      company_name: company.company_name || 'Unknown',
      org_number: company.org_number,
    })

    // Return as downloadable file
    return new NextResponse(sieContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="export_${periodId}.se"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to generate SIE export' },
      { status: 500 }
    )
  }
}
