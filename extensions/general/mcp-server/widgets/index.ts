import type { UiWidget } from './types'
import { receiptMatcherWidget } from './receipt-matcher'
import { vatReviewWidget } from './vat-review'

export const uiWidgets: UiWidget[] = [
  receiptMatcherWidget,
  vatReviewWidget,
]

export function findUiWidget(uri: string): UiWidget | null {
  return uiWidgets.find((w) => w.uri === uri) ?? null
}

export type { UiWidget } from './types'
export { WIDGET_MIME_TYPE } from './types'
