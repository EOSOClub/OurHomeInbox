// Review as the pages word it: what each mark is called, the line saying who
// marked an email and when, and whether an email still needs a check (a
// reviewed email does not: a person has looked at it).

import type { CaptureListItem, CaptureReview } from "../../../src/shared/api";
import type { ReviewState } from "../../../src/shared/review";
import { formatDateTime } from "../format";

export const REVIEW_LABELS: Record<ReviewState, string> = {
  checked: "Checked",
  "not-bill": "Not a bill",
};

/** "Checked by Sam Smith, Oct 29, 2026, 7:00 AM", or without the name when that account is gone. */
export function reviewLine(review: CaptureReview): string {
  return `${REVIEW_LABELS[review.state]}${review.by ? ` by ${review.by}` : ""}, ${formatDateTime(review.at)}`;
}

/** True when the reader found more than one candidate for a value and no person has reviewed the email yet. */
export function needsCheckNow(item: Pick<CaptureListItem, "picked" | "review">): boolean {
  return item.picked.needsCheck && item.review === null;
}
