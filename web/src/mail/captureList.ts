// Searching the captured-mail list in the browser: every word typed must
// appear in the subject, the sender's name or address, the mailbox name, the
// matched biller's name, or one of the email's tags. The list can also be
// narrowed to emails with a biller, or without one, and to one tag, or to
// emails with no tags.

import type { CaptureListItem } from "../../../src/shared/api";

export type BillerFilter = "all" | "matched" | "unmatched";
/** Every email, emails with no tags, or emails with the tag of this id. */
export type TagFilter = "all" | "none" | number;

function searchText(item: CaptureListItem): string {
  const from = item.from.map((a) => `${a.name} ${a.address}`).join(" ");
  const tags = item.tags.map((tag) => tag.name).join(" ");
  return `${item.subject ?? ""} ${from} ${item.mailbox} ${item.biller?.name ?? ""} ${tags}`.toLowerCase();
}

export function filterCaptures(
  items: readonly CaptureListItem[],
  query: string,
  billers: BillerFilter = "all",
  tag: TagFilter = "all",
): CaptureListItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (billers === "matched" && item.biller === null) return false;
    if (billers === "unmatched" && item.biller !== null) return false;
    if (tag === "none" && item.tags.length > 0) return false;
    if (typeof tag === "number" && !item.tags.some((t) => t.id === tag)) return false;
    if (words.length === 0) return true;
    const text = searchText(item);
    return words.every((word) => text.includes(word));
  });
}

/** The tag filter a page address asks for (`?tag=<id>` or `?tag=none`), or "all" when it names no tag of `tagIds`. */
export function tagFilterFrom(param: string | null, tagIds: readonly number[] | undefined): TagFilter {
  if (param === "none") return "none";
  if (param === null || !/^[1-9]\d*$/.test(param)) return "all";
  const id = Number(param);
  // Until the tags load the id is kept, so a link to a tag does not flash the whole list.
  return tagIds === undefined || tagIds.includes(id) ? id : "all";
}

/** The date a row shows and sorts by: the email's own date, else when it was captured. */
export function captureDate(item: Pick<CaptureListItem, "date" | "capturedAt">): string {
  return item.date ?? item.capturedAt;
}
