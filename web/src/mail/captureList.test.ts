// Tests for searching and filtering the captured-mail list.

import { describe, expect, it } from "vitest";
import type { BillerMatch, CaptureListItem, TagRef } from "../../../src/shared/api";
import {
  captureDate,
  filterCaptures,
  filtersFrom,
  isNarrowed,
  listPathFrom,
  listPathWith,
  localDay,
  moreFiltersOn,
  NO_FILTERS,
  tagFilterFrom,
  withFilters,
  withoutFilters,
} from "./captureList";

function item(
  id: string,
  subject: string | null,
  name: string,
  address: string,
  mailbox = "Proton bills",
  biller: BillerMatch | null = null,
  tags: TagRef[] = [],
  more: Partial<CaptureListItem> = {},
): CaptureListItem {
  return {
    id,
    mailbox,
    mailboxSlug: "proton-bills",
    folder: "Folders/Bills",
    uidValidity: "1",
    uid: 1,
    subject,
    from: [{ name, address }],
    date: null,
    capturedAt: "2026-10-29T12:00:00Z",
    attachmentCount: 0,
    linkCount: 0,
    hasText: true,
    hasHtml: false,
    biller,
    senderVerified: true,
    picked: { kind: "statement", amount: null, dueDate: null, paidDate: null, dueNow: false, needsCheck: false, values: {} },
    tags,
    review: null,
    ...more,
  };
}

const ACME: BillerMatch = { id: 7, name: "Acme Utilities", kind: "bill", matchedOn: "power.example" };
const TAXES: TagRef = { id: 1, name: "Taxes 2026" };
const PAID: TagRef = { id: 2, name: "Paid" };

const items = [
  item("a", "Your water bill", "City Water", "bills@water.example", undefined, null, [PAID, TAXES]),
  item("b", "Statement ready", "Power Co", "noreply@power.example", "Gmail bills", ACME, [PAID]),
  item("c", null, "", "someone@else.example"),
];

const picked = (more: Partial<CaptureListItem["picked"]>): CaptureListItem["picked"] => ({
  kind: "bill",
  amount: "10.00",
  dueDate: null,
  paidDate: null,
  dueNow: false,
  needsCheck: false,
  values: { amount: ["10.00"] },
  ...more,
});

// Times without a zone are this computer's local time, so the days hold in any time zone.
const varied = [
  item("bill", "Bill", "A", "a@x.example", undefined, null, [], { date: "2026-10-05T09:00:00", picked: picked({}) }),
  item("late", "Past due", "B", "b@x.example", undefined, null, [], { date: "2026-10-10T23:30:00", picked: picked({ dueNow: true }) }),
  item("check", "Two amounts", "C", "c@x.example", undefined, null, [], { date: "2026-10-20T00:15:00", picked: picked({ kind: "reminder", needsCheck: true }) }),
  item("stranger", "Receipt", "D", "d@x.example", undefined, null, [], {
    date: null,
    capturedAt: "2026-10-31T12:00:00",
    senderVerified: false,
    picked: picked({ kind: "receipt" }),
  }),
];
const ids = (list: CaptureListItem[]) => list.map((i) => i.id);

describe("filterCaptures", () => {
  it("returns everything for an empty search", () => {
    expect(filterCaptures(items, { query: "  " })).toHaveLength(3);
    expect(filterCaptures(items)).toHaveLength(3);
  });

  it("matches subject, sender name, sender address and mailbox, ignoring case", () => {
    expect(ids(filterCaptures(items, { query: "WATER" }))).toEqual(["a"]);
    expect(ids(filterCaptures(items, { query: "power co" }))).toEqual(["b"]);
    expect(ids(filterCaptures(items, { query: "else.example" }))).toEqual(["c"]);
    expect(ids(filterCaptures(items, { query: "gmail" }))).toEqual(["b"]);
  });

  it("matches the biller's name", () => {
    expect(ids(filterCaptures(items, { query: "acme" }))).toEqual(["b"]);
  });

  it("needs every word to match", () => {
    expect(ids(filterCaptures(items, { query: "bill water" }))).toEqual(["a"]);
    expect(filterCaptures(items, { query: "water power" })).toEqual([]);
  });

  it("narrows to emails with a biller, or without one", () => {
    expect(ids(filterCaptures(items, { billers: "matched" }))).toEqual(["b"]);
    expect(ids(filterCaptures(items, { billers: "unmatched" }))).toEqual(["a", "c"]);
    expect(filterCaptures(items, { query: "water", billers: "matched" })).toEqual([]);
  });

  it("matches a tag's name", () => {
    expect(ids(filterCaptures(items, { query: "taxes" }))).toEqual(["a"]);
    expect(ids(filterCaptures(items, { query: "paid" }))).toEqual(["a", "b"]);
  });

  it("narrows to one tag, or to emails with no tags, alongside the other filters", () => {
    expect(ids(filterCaptures(items, { tag: PAID.id }))).toEqual(["a", "b"]);
    expect(ids(filterCaptures(items, { tag: TAXES.id }))).toEqual(["a"]);
    expect(ids(filterCaptures(items, { tag: "none" }))).toEqual(["c"]);
    expect(ids(filterCaptures(items, { billers: "matched", tag: PAID.id }))).toEqual(["b"]);
    expect(ids(filterCaptures(items, { query: "water", tag: PAID.id }))).toEqual(["a"]);
    expect(filterCaptures(items, { tag: 99 })).toEqual([]);
  });

  it("narrows to one kind of email", () => {
    expect(ids(filterCaptures(varied, { kind: "bill" }))).toEqual(["bill", "late"]);
    expect(ids(filterCaptures(varied, { kind: "reminder" }))).toEqual(["check"]);
    expect(filterCaptures(varied, { kind: "statement" })).toEqual([]);
  });

  it("narrows to emails that need a check, are past due, or have an unverified sender", () => {
    expect(ids(filterCaptures(varied, { needsCheck: true }))).toEqual(["check"]);
    expect(ids(filterCaptures(varied, { pastDue: true }))).toEqual(["late"]);
    expect(ids(filterCaptures(varied, { unverified: true }))).toEqual(["stranger"]);
    // Ticks add up: an email must meet each one.
    expect(filterCaptures(varied, { pastDue: true, needsCheck: true })).toEqual([]);
  });

  it("narrows to a range of days, both ends included, by the date the row shows", () => {
    expect(ids(filterCaptures(varied, { from: "2026-10-10" }))).toEqual(["late", "check", "stranger"]);
    expect(ids(filterCaptures(varied, { to: "2026-10-10" }))).toEqual(["bill", "late"]);
    expect(ids(filterCaptures(varied, { from: "2026-10-06", to: "2026-10-20" }))).toEqual(["late", "check"]);
    // No date of its own: the day it was captured.
    expect(ids(filterCaptures(varied, { from: "2026-10-31", to: "2026-10-31" }))).toEqual(["stranger"]);
    // From after To shows nothing.
    expect(filterCaptures(varied, { from: "2026-10-20", to: "2026-10-05" })).toEqual([]);
  });

  it("narrows to the emails still to review, or marked one way", () => {
    const marked = (state: "checked" | "not-bill") => ({ state, by: "Sam", at: "2026-10-30T12:00:00Z" });
    const list = [
      varied[0]!,
      { ...varied[1]!, review: marked("checked") },
      { ...varied[2]!, review: marked("not-bill") },
    ];
    expect(ids(filterCaptures(list, { review: "todo" }))).toEqual(["bill"]);
    expect(ids(filterCaptures(list, { review: "checked" }))).toEqual(["late"]);
    expect(ids(filterCaptures(list, { review: "not-bill" }))).toEqual(["check"]);
    expect(filterCaptures(list, { review: "all" })).toHaveLength(3);
  });

  it("no longer counts a reviewed email as needing a check", () => {
    const reviewed = { ...varied[2]!, review: { state: "checked" as const, by: null, at: "2026-10-30T12:00:00Z" } };
    expect(filterCaptures([reviewed], { needsCheck: true })).toEqual([]);
    expect(ids(filterCaptures([varied[2]!], { needsCheck: true }))).toEqual(["check"]);
  });

  it("combines every filter with the search", () => {
    expect(ids(filterCaptures(varied, { query: "past", kind: "bill", from: "2026-10-01", pastDue: true }))).toEqual(["late"]);
    expect(filterCaptures(varied, { query: "receipt", kind: "bill" })).toEqual([]);
  });
});

describe("moreFiltersOn and isNarrowed", () => {
  it("counts the filters behind the Filters button, the two dates as one", () => {
    expect(moreFiltersOn(NO_FILTERS)).toBe(0);
    expect(moreFiltersOn({ ...NO_FILTERS, from: "2026-10-01", to: "2026-10-31" })).toBe(1);
    expect(moreFiltersOn({ ...NO_FILTERS, kind: "bill", to: "2026-10-31", needsCheck: true, pastDue: true, unverified: true })).toBe(5);
    expect(moreFiltersOn({ ...NO_FILTERS, review: "todo" })).toBe(1);
    expect(moreFiltersOn({ ...NO_FILTERS, query: "water", billers: "matched", tag: 1 })).toBe(0);
  });

  it("knows when anything narrows the list", () => {
    expect(isNarrowed(NO_FILTERS)).toBe(false);
    expect(isNarrowed({ ...NO_FILTERS, query: "   " })).toBe(false);
    expect(isNarrowed({ ...NO_FILTERS, query: "water" })).toBe(true);
    expect(isNarrowed({ ...NO_FILTERS, tag: "none" })).toBe(true);
    expect(isNarrowed({ ...NO_FILTERS, unverified: true })).toBe(true);
  });
});

describe("tagFilterFrom", () => {
  it("reads ?tag= from the page address", () => {
    expect(tagFilterFrom(null, [1, 2])).toBe("all");
    expect(tagFilterFrom("none", [1, 2])).toBe("none");
    expect(tagFilterFrom("2", [1, 2])).toBe(2);
  });

  it("ignores a tag that does not exist or a value that is not an id", () => {
    expect(tagFilterFrom("9", [1, 2])).toBe("all");
    for (const bad of ["", "0", "-1", "1.5", "abc", "01"]) expect(tagFilterFrom(bad, [1, 2])).toBe("all");
  });

  it("keeps the id while the tags are loading", () => {
    expect(tagFilterFrom("9", undefined)).toBe(9);
  });
});

describe("the filters in the page address", () => {
  it("reads every filter", () => {
    const params = new URLSearchParams("q=water+bill&biller=matched&tag=2&kind=reminder&from=2026-10-01&to=2026-10-31&review=todo&check=1&pastdue=1&unverified=1");
    expect(filtersFrom(params, [1, 2])).toEqual({
      query: "water bill",
      billers: "matched",
      tag: 2,
      kind: "reminder",
      from: "2026-10-01",
      to: "2026-10-31",
      review: "todo",
      needsCheck: true,
      pastDue: true,
      unverified: true,
    });
    expect(filtersFrom(new URLSearchParams(), [1, 2])).toEqual(NO_FILTERS);
  });

  it("treats anything it gets wrong as no filter", () => {
    const params = new URLSearchParams("biller=maybe&kind=invoice&from=2026-02-30&to=10/31/2026&review=done&check=yes&pastdue=true");
    expect(filtersFrom(params, [1])).toEqual(NO_FILTERS);
    expect(filtersFrom(new URLSearchParams("review=not-bill"), []).review).toBe("not-bill");
    expect(filtersFrom(new URLSearchParams("review=checked"), []).review).toBe("checked");
    expect(filtersFrom(new URLSearchParams("review=Checked"), []).review).toBe("all");
    expect(filtersFrom(new URLSearchParams("from=2028-02-29&to=2026-13-01"), []).from).toBe("2028-02-29");
    expect(filtersFrom(new URLSearchParams("to=2026-13-01"), []).to).toBe("");
  });

  it("writes changes, drops a filter set back to none, and keeps the rest of the address", () => {
    const start = new URLSearchParams("tag=2&kind=bill&other=keep");
    const next = withFilters(start, { kind: "all", pastDue: true, query: "water", from: "2026-10-01" });
    expect(next.toString()).toBe("tag=2&other=keep&pastdue=1&q=water&from=2026-10-01");
    expect(withFilters(next, { pastDue: false, query: "", tag: "none" }).toString()).toBe("tag=none&other=keep&from=2026-10-01");
    expect(start.toString()).toBe("tag=2&kind=bill&other=keep"); // not changed in place
  });

  it("round-trips through the address", () => {
    const filters = {
      ...NO_FILTERS,
      query: "a b",
      billers: "unmatched" as const,
      tag: 1,
      kind: "receipt" as const,
      to: "2026-10-31",
      review: "not-bill" as const,
      unverified: true,
    };
    expect(filtersFrom(withFilters(new URLSearchParams(), filters), [1])).toEqual(filters);
  });

  it("takes every filter off at once", () => {
    const params = new URLSearchParams("q=x&biller=matched&tag=none&kind=bill&from=2026-10-01&to=2026-10-02&review=todo&check=1&pastdue=1&unverified=1&other=keep");
    expect(withoutFilters(params).toString()).toBe("other=keep");
  });
});

describe("listPathWith", () => {
  it("gives the list's address narrowed by the filters named, for links from other pages", () => {
    expect(listPathWith({})).toBe("/");
    expect(listPathWith({ review: "todo" })).toBe("/?review=todo");
    expect(listPathWith({ billers: "unmatched" })).toBe("/?biller=unmatched");
    expect(listPathWith({ needsCheck: true, kind: "bill" })).toBe("/?check=1&kind=bill");
  });
});

describe("listPathFrom", () => {
  it("goes back to the list as it was left, else the whole list", () => {
    expect(listPathFrom({ listSearch: "?q=water&pastdue=1" })).toBe("/?q=water&pastdue=1");
    expect(listPathFrom({ listSearch: "" })).toBe("/");
    expect(listPathFrom(null)).toBe("/");
    expect(listPathFrom(undefined)).toBe("/");
    expect(listPathFrom({ listSearch: "//elsewhere.example" })).toBe("/");
    expect(listPathFrom({ listSearch: 5 })).toBe("/");
  });
});

describe("localDay", () => {
  it("gives the day in this browser's time zone", () => {
    expect(localDay("2026-10-05T23:59:00")).toBe("2026-10-05");
    expect(localDay("2026-01-02T00:00:00")).toBe("2026-01-02");
    expect(localDay("not a date")).toBe("");
  });
});

describe("captureDate", () => {
  it("uses the email's date, else when it was captured", () => {
    expect(captureDate({ date: "2026-10-01T00:00:00Z", capturedAt: "2026-10-29T00:00:00Z" })).toBe("2026-10-01T00:00:00Z");
    expect(captureDate({ date: null, capturedAt: "2026-10-29T00:00:00Z" })).toBe("2026-10-29T00:00:00Z");
  });
});
