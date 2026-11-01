// Review on the pages: the badge a row shows for a marked email, the line on
// an email's page saying who marked it and when, and the buttons there to mark
// it checked or not a bill, or back to review.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleSlash } from "lucide-react";
import { useState } from "react";
import type { CaptureDetailResponse, CaptureReview } from "../../../src/shared/api";
import type { ReviewState } from "../../../src/shared/review";
import { api } from "../api";
import { Button, Notice } from "../components/ui";
import { showReviews } from "../queries";
import { REVIEW_LABELS, reviewLine } from "./review";

const BADGE_CLASSES: Record<ReviewState, string> = {
  checked: "border-line bg-surface-muted text-ink",
  "not-bill": "border-line bg-surface text-muted",
};

function ReviewIcon({ state }: { state: ReviewState }) {
  return state === "checked" ? (
    <CircleCheck aria-hidden className="size-3.5 shrink-0 text-accent" />
  ) : (
    <CircleSlash aria-hidden className="size-3.5 shrink-0" />
  );
}

/** "Checked" or "Not a bill", for a row in the list. Nothing while the email is still to review. */
export function ReviewBadge({ review }: { review: CaptureReview | null }) {
  if (!review) return null;
  return (
    <span title={reviewLine(review)} className={`inline-flex items-center gap-1 rounded border px-1.5 text-xs font-medium ${BADGE_CLASSES[review.state]}`}>
      <ReviewIcon state={review.state} />
      {REVIEW_LABELS[review.state]}
    </span>
  );
}

/** An email's mark, read only: for its page when it is shown without the buttons. */
export function ReviewSummary({ review }: { review: CaptureReview | null }) {
  if (!review) return <span className="text-muted">Not reviewed yet</span>;
  return (
    <>
      <span className="flex items-center gap-1.5 font-medium">
        <ReviewIcon state={review.state} />
        {REVIEW_LABELS[review.state]}
      </span>
      <span className="block text-sm text-muted">
        {reviewLine(review)}.{review.state === "not-bill" ? " It will not be sent to OurHome." : ""}
      </span>
    </>
  );
}

const ACTION = "px-3 py-1";

/** On an email's page: its mark, and buttons to mark it checked or not a bill, or back to review. */
export function CaptureReviewEditor({ detail }: { detail: CaptureDetailResponse }) {
  const queryClient = useQueryClient();
  const [done, setDone] = useState("");
  const change = useMutation({
    mutationFn: (state: ReviewState | null) => api.reviewCaptures({ captureIds: [detail.id], state }),
    onSuccess: (result, state) => {
      showReviews(queryClient, result);
      setDone(state === null ? "Marked to review." : `Marked ${REVIEW_LABELS[state].toLowerCase()}.`);
    },
  });
  const state = detail.review?.state ?? null;

  function mark(next: ReviewState | null) {
    setDone("");
    change.mutate(next);
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div>
        <ReviewSummary review={detail.review} />
      </div>
      <div className="flex flex-wrap gap-2">
        {state !== "checked" ? (
          <Button variant="secondary" className={ACTION} disabled={change.isPending} onClick={() => mark("checked")}>
            <CircleCheck aria-hidden className="size-4" />
            Mark checked
          </Button>
        ) : null}
        {state !== "not-bill" ? (
          <Button variant="secondary" className={ACTION} disabled={change.isPending} onClick={() => mark("not-bill")}>
            <CircleSlash aria-hidden className="size-4" />
            Mark not a bill
          </Button>
        ) : null}
        {state !== null ? (
          <Button variant="quiet" className={ACTION} disabled={change.isPending} onClick={() => mark(null)}>
            Mark to review
          </Button>
        ) : null}
      </div>
      {change.isError ? (
        <Notice tone="error" live>
          Could not change the review: {change.error.message}
        </Notice>
      ) : null}
      {/* Always there, so a screen reader hears each change. */}
      <p role="status" className="sr-only">
        {change.isError ? "" : done}
      </p>
    </div>
  );
}
