// Previous and Next on an email's page: they open the emails either side of
// it in the list it was opened from (with the same search and filters, or the
// whole list when opened some other way), so a person can go through the
// list without going back to it. Each step replaces the page in the browser's
// history, so Back still returns to the list in one step.

import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import type { CaptureListItem } from "../../../src/shared/api";
import { capturePagePath } from "../api";
import { buttonClasses } from "../components/ui";
import { senderDisplay, subjectDisplay } from "../format";
import { useCaptures, useTags } from "../queries";
import { filterCaptures, filtersFrom, listPathFrom, placeInList, type FromList } from "./captureList";

const STEP = "px-2.5 py-1";

function Step({ item, label, state, children }: { item: CaptureListItem | null; label: string; state: FromList; children: ReactNode }) {
  if (!item) {
    return (
      <span aria-disabled="true" className={buttonClasses("secondary", `${STEP} cursor-not-allowed opacity-50 hover:bg-surface`)}>
        {children}
      </span>
    );
  }
  return (
    <Link
      to={capturePagePath(item.id)}
      state={state}
      replace
      aria-label={`${label}: ${subjectDisplay(item.subject)}, from ${senderDisplay(item.from)}`}
      className={buttonClasses("secondary", STEP)}
    >
      {children}
    </Link>
  );
}

/** Previous, where this email is in the list ("3 of 42"), and Next. Nothing until the list has loaded, or when the list does not have this email. */
export function EmailPager({ captureId }: { captureId: string }) {
  const all = useCaptures().data?.captures;
  const tagIds = useTags().data?.tags.map((tag) => tag.id);
  const location = useLocation();
  const listPath = listPathFrom(location.state);
  if (!all) return null;
  const listSearch = listPath.slice(1);
  const shown = filterCaptures(all, filtersFrom(new URLSearchParams(listSearch), tagIds));
  const place = placeInList(all, shown, captureId);
  if (!place) return null;
  const state: FromList = { listSearch };
  return (
    <nav aria-label="Other emails in the list" className="flex items-center gap-2">
      <Step item={place.previous} label="Previous email" state={state}>
        <ChevronLeft aria-hidden className="size-4" />
        Previous
      </Step>
      <span className="text-sm whitespace-nowrap text-muted">
        {place.position === null ? "No longer in this list" : `${place.position} of ${place.total}`}
      </span>
      <Step item={place.next} label="Next email" state={state}>
        Next
        <ChevronRight aria-hidden className="size-4" />
      </Step>
    </nav>
  );
}
