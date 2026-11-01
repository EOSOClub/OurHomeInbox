// Searching the captured-mail list in the browser: every word typed must
// appear in the subject, the sender's name or address, the mailbox name, the
// matched biller's name, or one of the email's tags. The list can also be
// narrowed to emails with a biller, or without one; to one tag, or to emails
// with no tags; to one kind of email; to a range of days; and to the emails
// that need a check, say they are past due, or come from a sender the mail
// provider did not verify. All of it lives in the page address, so Back from
// an email, or a link, opens the list the same way.

import type { CaptureListItem } from "../../../src/shared/api";
import { EMAIL_KINDS, type EmailKind } from "../../../src/shared/extraction";

export type BillerFilter = "all" | "matched" | "unmatched";
/** Every email, emails with no tags, or emails with the tag of this id. */
export type TagFilter = "all" | "none" | number;
export type KindFilter = "all" | EmailKind;

export interface CaptureFilters {
  query: string;
  billers: BillerFilter;
  tag: TagFilter;
  kind: KindFilter;
  /** The first and last day shown (the row's date, in this browser's time zone), "YYYY-MM-DD"; "" for no limit. */
  from: string;
  to: string;
  /** Only emails with a value that has more than one candidate. */
  needsCheck: boolean;
  /** Only emails that say the account is past due (due now). */
  pastDue: boolean;
  /** Only emails whose sender the mail provider did not verify. */
  unverified: boolean;
}

export const NO_FILTERS: CaptureFilters = {
  query: "",
  billers: "all",
  tag: "all",
  kind: "all",
  from: "",
  to: "",
  needsCheck: false,
  pastDue: false,
  unverified: false,
};

function searchText(item: CaptureListItem): string {
  const from = item.from.map((a) => `${a.name} ${a.address}`).join(" ");
  const tags = item.tags.map((tag) => tag.name).join(" ");
  return `${item.subject ?? ""} ${from} ${item.mailbox} ${item.biller?.name ?? ""} ${tags}`.toLowerCase();
}

export function filterCaptures(items: readonly CaptureListItem[], filters: Partial<CaptureFilters> = {}): CaptureListItem[] {
  const f = { ...NO_FILTERS, ...filters };
  const words = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (f.billers === "matched" && item.biller === null) return false;
    if (f.billers === "unmatched" && item.biller !== null) return false;
    if (f.tag === "none" && item.tags.length > 0) return false;
    if (typeof f.tag === "number" && !item.tags.some((t) => t.id === f.tag)) return false;
    if (f.kind !== "all" && item.picked.kind !== f.kind) return false;
    if (f.needsCheck && !item.picked.needsCheck) return false;
    if (f.pastDue && !item.picked.dueNow) return false;
    if (f.unverified && item.senderVerified) return false;
    if (f.from || f.to) {
      const day = localDay(captureDate(item));
      if (day === "" || (f.from && day < f.from) || (f.to && day > f.to)) return false;
    }
    if (words.length === 0) return true;
    const text = searchText(item);
    return words.every((word) => text.includes(word));
  });
}

/** How many of the filters behind the Filters button are on (the two dates count as one). */
export function moreFiltersOn(f: CaptureFilters): number {
  return [f.kind !== "all", f.from !== "" || f.to !== "", f.needsCheck, f.pastDue, f.unverified].filter(Boolean).length;
}

/** True when the search or any filter narrows the list. */
export function isNarrowed(f: CaptureFilters): boolean {
  return f.query.trim() !== "" || f.billers !== "all" || f.tag !== "all" || moreFiltersOn(f) > 0;
}

/** The tag filter a page address asks for (`?tag=<id>` or `?tag=none`), or "all" when it names no tag of `tagIds`. */
export function tagFilterFrom(param: string | null, tagIds: readonly number[] | undefined): TagFilter {
  if (param === "none") return "none";
  if (param === null || !/^[1-9]\d*$/.test(param)) return "all";
  const id = Number(param);
  // Until the tags load the id is kept, so a link to a tag does not flash the whole list.
  return tagIds === undefined || tagIds.includes(id) ? id : "all";
}

/** The page address's names for each filter. */
const PARAM = {
  query: "q",
  billers: "biller",
  tag: "tag",
  kind: "kind",
  from: "from",
  to: "to",
  needsCheck: "check",
  pastDue: "pastdue",
  unverified: "unverified",
} as const satisfies Record<keyof CaptureFilters, string>;

/** A real calendar day written "YYYY-MM-DD", else "". */
function dayFrom(param: string | null): string {
  const m = param === null ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(param);
  if (!m) return "";
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? param! : "";
}

/** The filters a page address asks for; anything it gets wrong counts as no filter. */
export function filtersFrom(params: URLSearchParams, tagIds: readonly number[] | undefined): CaptureFilters {
  const billers = params.get(PARAM.billers);
  const kind = params.get(PARAM.kind);
  return {
    query: params.get(PARAM.query) ?? "",
    billers: billers === "matched" || billers === "unmatched" ? billers : "all",
    tag: tagFilterFrom(params.get(PARAM.tag), tagIds),
    kind: kind !== null && (EMAIL_KINDS as readonly string[]).includes(kind) ? (kind as EmailKind) : "all",
    from: dayFrom(params.get(PARAM.from)),
    to: dayFrom(params.get(PARAM.to)),
    needsCheck: params.get(PARAM.needsCheck) === "1",
    pastDue: params.get(PARAM.pastDue) === "1",
    unverified: params.get(PARAM.unverified) === "1",
  };
}

/** The page address with `changes` made; a filter set back to "no filter" leaves the address. Other parts are kept. */
export function withFilters(params: URLSearchParams, changes: Partial<CaptureFilters>): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of Object.keys(changes) as Array<keyof CaptureFilters>) {
    const value = changes[key];
    if (value === undefined) continue;
    const text = value === true ? "1" : value === false || value === "all" ? "" : String(value);
    if (text === "") next.delete(PARAM[key]);
    else next.set(PARAM[key], text);
  }
  return next;
}

/** The page address with every filter and the search taken off. */
export function withoutFilters(params: URLSearchParams): URLSearchParams {
  return withFilters(params, NO_FILTERS);
}

/** What an email's page is told when it is opened from the list: the list's page address (search and filters). */
export interface FromList {
  listSearch: string;
}

/** Where "Back to captured mail" goes: the list as it was left, else the whole list. */
export function listPathFrom(state: unknown): string {
  const search = (state as Partial<FromList> | null)?.listSearch;
  return typeof search === "string" && search.startsWith("?") ? `/${search}` : "/";
}

/** The day an ISO time falls on in this browser's time zone, "YYYY-MM-DD"; "" when it is not a time. */
export function localDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The date a row shows and sorts by: the email's own date, else when it was captured. */
export function captureDate(item: Pick<CaptureListItem, "date" | "capturedAt">): string {
  return item.date ?? item.capturedAt;
}
