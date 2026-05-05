import type { Skill } from './types'
import { monthEndCloseSkill } from './month-end-close'
import { quarterlyVatReviewSkill } from './quarterly-vat-review'
import { yearEndCloseSkill } from './year-end-close'
import { invoicingRulesSkill } from './invoicing-rules'
import { payrollMonthlySkill } from './payroll-monthly'

export const skills: Skill[] = [
  monthEndCloseSkill,
  quarterlyVatReviewSkill,
  yearEndCloseSkill,
  invoicingRulesSkill,
  payrollMonthlySkill,
]

export function findSkill(slug: string): Skill | null {
  return skills.find((s) => s.slug === slug) ?? null
}

export type { Skill } from './types'
export { SKILL_MIME_TYPE, SKILL_URI_PREFIX, skillUri, skillSlugFromUri } from './types'
