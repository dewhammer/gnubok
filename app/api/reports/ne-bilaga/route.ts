import { NextResponse } from 'next/server'
import { generateNEDeclaration } from '@/lib/reports/ne-bilaga/ne-engine'
import {
  generateSRUFile,
  sruFileToString,
  getSRUFilename,
} from '@/lib/reports/ne-bilaga/sru-generator'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * GET /api/reports/ne-bilaga
 *
 * Query parameters:
 *   period_id: fiscal period id (required)
 *   format:    'json' (default) or 'sru' for SRU file download
 */
export const GET = withRouteContext(
  'report.ne_bilaga',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const periodId = searchParams.get('period_id')
    const format = searchParams.get('format') || 'json'

    if (!periodId) {
      return errorResponseFromCode('REPORT_PERIOD_REQUIRED', log, { requestId })
    }

    const opLog = log.child({ periodId, format })

    try {
      const declaration = await generateNEDeclaration(supabase, companyId!, periodId)

      if (format === 'sru') {
        const sruFile = generateSRUFile(declaration)
        const sruContent = sruFileToString(sruFile)
        const filename = getSRUFilename(declaration)

        return new NextResponse(sruContent, {
          status: 200,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'X-Request-Id': requestId,
          },
        })
      }

      return NextResponse.json({ data: declaration })
    } catch (err) {
      opLog.error('ne-bilaga declaration generation failed', err as Error)
      return errorResponseFromCode('TAX_DECL_GENERATION_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
  },
)
