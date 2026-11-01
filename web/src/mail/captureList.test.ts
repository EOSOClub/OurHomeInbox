// Tests for searching the captured-mail list.

import { describe, expect, it } from "vitest";
import type { BillerMatch, CaptureListItem, TagRef } from "../../../src/shared/api";
import { captureDate, filterCaptures, tagFilterFrom } from "./captureList";

function item(
  id: string,
  subject: string | null,
  name: string,
  address: string,
  mailbox = "Proton bills",
  biller: BillerMatch | null = null,
  tags: TagRef[] = [],
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
    picked: { kind: "statement", amount: null, dueDate: null, paidDate: null, dueNow: false, needsCheck: false },
    tags,
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

describe("filterCaptures", () => {
  it("returns everything for an empty search", () => {
    expect(filterCaptures(items, "  ")).toHaveLength(3);
  });

  it("matches subject, sender name, sender address and mailbox, ignoring case", () => {
    expect(filterCaptures(items, "WATER").map((i) => i.id)).toEqual(["a"]);
    expect(filterCaptures(items, "power co").map((i) => i.id)).toEqual(["b"]);
    expect(filterCaptures(items, "else.example").map((i) => i.id)).toEqual(["c"]);
    expect(filterCaptures(items, "gmail").map((i) => i.id)).toEqual(["b"]);
  });

  it("matches the biller's name", () => {
    expect(filterCaptures(items, "acme").map((i) => i.id)).toEqual(["b"]);
  });

  it("needs every word to match", () => {
    expect(filterCaptures(items, "bill water").map((i) => i.id)).toEqual(["a"]);
    expect(filterCaptures(items, "water power")).toEqual([]);
  });

  it("narrows to emails with a biller, or without one", () => {
    expect(filterCaptures(items, "", "matched").map((i) => i.id)).toEqual(["b"]);
    expect(filterCaptures(items, "", "unmatched").map((i) => i.id)).toEqual(["a", "c"]);
    expect(filterCaptures(items, "water", "matched")).toEqual([]);
  });

  it("matches a tag's name", () => {
    expect(filterCaptures(items, "taxes").map((i) => i.id)).toEqual(["a"]);
    expect(filterCaptures(items, "paid").map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("narrows to one tag, or to emails with no tags, alongside the other filters", () => {
    expect(filterCaptures(items, "", "all", PAID.id).map((i) => i.id)).toEqual(["a", "b"]);
    expect(filterCaptures(items, "", "all", TAXES.id).map((i) => i.id)).toEqual(["a"]);
    expect(filterCaptures(items, "", "all", "none").map((i) => i.id)).toEqual(["c"]);
    expect(filterCaptures(items, "", "matched", PAID.id).map((i) => i.id)).toEqual(["b"]);
    expect(filterCaptures(items, "water", "all", PAID.id).map((i) => i.id)).toEqual(["a"]);
    expect(filterCaptures(items, "", "all", 99)).toEqual([]);
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

describe("captureDate", () => {
  it("uses the email's date, else when it was captured", () => {
    expect(captureDate({ date: "2026-10-01T00:00:00Z", capturedAt: "2026-10-29T00:00:00Z" })).toBe("2026-10-01T00:00:00Z");
    expect(captureDate({ date: null, capturedAt: "2026-10-29T00:00:00Z" })).toBe("2026-10-29T00:00:00Z");
  });
});
