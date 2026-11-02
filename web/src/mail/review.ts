// Review as the pages word it: what each mark is called, the line saying who
// marked an email and when, and whether an email still needs a check (a
// reviewed email does not: a person has looked at it).

import type { CaptureListItem, CaptureReview } from "../../../src/shared/api";
import type { ReviewState } from "../../../src/shared/review";
import { formatDateTime } from "../format";
import { needsBill } from "../payments/paymentText";

export const REVIEW_LABELS: Record<ReviewState, string> = {
  checked: "Checked",
  "not-bill": "Not a bill",
};

/** "Checked by Sam Smith, Oct 29, 2026, 7:00 AM", or without the name when that account is gone. */
export function reviewLine(review: CaptureReview): string {
  return `${REVIEW_LABELS[review.state]}${review.by ? ` by ${review.by}` : ""}, ${formatDateTime(review.at)}`;
}

/**
 * True when the email is in the Review list: nobody has marked it yet, or it
 * is a payment that needs a bill (marking it Checked does not choose its bill).
 */
export function isToReview(item: Pick<CaptureListItem, "review" | "payment">): boolean {
  return item.review === null || needsBill(item);
}

/** True when the reader found more than one candidate for a value and no person has reviewed the email yet. */
export function needsCheckNow(item: Pick<CaptureListItem, "picked" | "review">): boolean {
  return item.picked.needsCheck && item.review === null;
}
