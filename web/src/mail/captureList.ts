// Searching the captured-mail list in the browser: every word typed must
// appear in the subject, the sender's name or address, or the mailbox name.

import type { CaptureListItem } from "../../../src/shared/api";

function searchText(item: CaptureListItem): string {
  const from = item.from.map((a) => `${a.name} ${a.address}`).join(" ");
  return `${item.subject ?? ""} ${from} ${item.mailbox}`.toLowerCase();
}

export function filterCaptures(items: readonly CaptureListItem[], query: string): CaptureListItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...items];
  return items.filter((item) => {
    const text = searchText(item);
    return words.every((word) => text.includes(word));
  });
}

/** The date a row shows and sorts by: the email's own date, else when it was captured. */
export function captureDate(item: Pick<CaptureListItem, "date" | "capturedAt">): string {
  return item.date ?? item.capturedAt;
}
