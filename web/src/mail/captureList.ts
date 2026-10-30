// Searching the captured-mail list in the browser: every word typed must
// appear in the subject, the sender's name or address, the mailbox name, or
// the matched biller's name. The list can also be narrowed to emails with a
// biller, or without one.

import type { CaptureListItem } from "../../../src/shared/api";

export type BillerFilter = "all" | "matched" | "unmatched";

function searchText(item: CaptureListItem): string {
  const from = item.from.map((a) => `${a.name} ${a.address}`).join(" ");
  return `${item.subject ?? ""} ${from} ${item.mailbox} ${item.biller?.name ?? ""}`.toLowerCase();
}

export function filterCaptures(items: readonly CaptureListItem[], query: string, billers: BillerFilter = "all"): CaptureListItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (billers === "matched" && item.biller === null) return false;
    if (billers === "unmatched" && item.biller !== null) return false;
    if (words.length === 0) return true;
    const text = searchText(item);
    return words.every((word) => text.includes(word));
  });
}

/** The date a row shows and sorts by: the email's own date, else when it was captured. */
export function captureDate(item: Pick<CaptureListItem, "date" | "capturedAt">): string {
  return item.date ?? item.capturedAt;
}
