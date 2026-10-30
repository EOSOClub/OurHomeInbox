// Tests for searching the captured-mail list.

import { describe, expect, it } from "vitest";
import type { BillerMatch, CaptureListItem } from "../../../src/shared/api";
import { captureDate, filterCaptures } from "./captureList";

function item(
  id: string,
  subject: string | null,
  name: string,
  address: string,
  mailbox = "Proton bills",
  biller: BillerMatch | null = null,
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
    picked: { kind: "statement", amount: null, dueDate: null, paidDate: null, needsCheck: false },
  };
}

const ACME: BillerMatch = { id: 7, name: "Acme Utilities", kind: "bill", matchedOn: "power.example" };

const items = [
  item("a", "Your water bill", "City Water", "bills@water.example"),
  item("b", "Statement ready", "Power Co", "noreply@power.example", "Gmail bills", ACME),
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
});

describe("captureDate", () => {
  it("uses the email's date, else when it was captured", () => {
    expect(captureDate({ date: "2026-10-01T00:00:00Z", capturedAt: "2026-10-29T00:00:00Z" })).toBe("2026-10-01T00:00:00Z");
    expect(captureDate({ date: null, capturedAt: "2026-10-29T00:00:00Z" })).toBe("2026-10-29T00:00:00Z");
  });
});
