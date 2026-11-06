// The same email captured more than once (copies.ts): only its original is used.

import { describe, expect, it } from "vitest";
import { copyReason, findCopies, findRepeatBills, repeatReason, type CopyCandidate, type RepeatCandidate } from "../../src/server/copies.js";

function email(id: string, messageId: string | null, more: Partial<CopyCandidate> = {}): CopyCandidate {
  return { id, messageId, offered: null, capturedAt: "2026-11-02T12:00:00.000Z", ...more };
}

const CITY = 7;

/** A city bill email sent on `day`: 121.44, due Sep 3, from a sender that passed the check unless said. */
function cityBill(id: string, day: string, more: Partial<RepeatCandidate> = {}): RepeatCandidate {
  return {
    id,
    kind: "bill",
    billerId: CITY,
    amountCents: 12144,
    dueDay: "2026-09-03",
    emailDay: day,
    emailTime: `${day}T12:00:00.000Z`,
    notBill: false,
    invoiceNo: null,
    accountNo: null,
    offered: null,
    checked: false,
    senderVerified: true,
    ...more,
  };
}

describe("findRepeatBills", () => {
  it("uses the verified sender's email of the city's two, and makes the other a repeat (2026-11-05)", () => {
    // "New Bill" from siouxfalls.org (fails the check), then "Invoice# 14221231" from siouxfalls.gov.
    const repeats = findRepeatBills([
      cityBill("org", "2026-08-13", { senderVerified: false, accountNo: "50160510000220840" }),
      cityBill("gov", "2026-08-14", { invoiceNo: "14221231", accountNo: "XXXXXXXXXXXXXXX840" }),
    ]);
    expect([...repeats]).toEqual([["org", "gov"]]);
  });

  it("uses the oldest when nothing else tells them apart, and puts an offered or Checked one first", () => {
    expect([...findRepeatBills([cityBill("b", "2026-08-14"), cityBill("a", "2026-08-13")])]).toEqual([["b", "a"]]);
    expect([...findRepeatBills([cityBill("a", "2026-08-13"), cityBill("b", "2026-08-14", { checked: true })])]).toEqual([["a", "b"]]);
    expect([...findRepeatBills([cityBill("a", "2026-08-13", { checked: true }), cityBill("b", "2026-08-14", { offered: 4 })])]).toEqual([["a", "b"]]);
  });

  it("never makes an email already offered to OurHome a repeat", () => {
    expect(findRepeatBills([cityBill("a", "2026-08-13", { offered: 3 }), cityBill("b", "2026-08-14", { offered: 4 })]).size).toBe(0);
  });

  it("keeps bills apart that differ in amount, due date, biller, invoice number, account or time", () => {
    const apart = (more: Partial<RepeatCandidate>) => findRepeatBills([cityBill("a", "2026-08-13"), cityBill("b", "2026-08-14", more)]).size;
    expect(apart({ amountCents: 12145 })).toBe(0);
    expect(apart({ dueDay: "2026-10-03" })).toBe(0);
    expect(apart({ billerId: 8 })).toBe(0);
    expect(findRepeatBills([cityBill("a", "2026-08-13", { invoiceNo: "1" }), cityBill("b", "2026-08-14", { invoiceNo: "2" })]).size).toBe(0);
    expect(findRepeatBills([cityBill("a", "2026-08-13", { accountNo: "50160510000220840" }), cityBill("b", "2026-08-14", { accountNo: "XXXX0841" })]).size).toBe(0);
    // A masked account number with the same ending is the same account; the city masks all but the last 3 digits.
    expect(findRepeatBills([cityBill("a", "2026-08-13", { accountNo: "50160510000220840" }), cityBill("b", "2026-08-14", { accountNo: "XXXX0840" })]).size).toBe(1);
    expect(findRepeatBills([cityBill("a", "2026-08-13", { accountNo: "50160510000220840" }), cityBill("b", "2026-08-14", { accountNo: "XXXXXXXXXXXXXXX840" })]).size).toBe(1);
    expect(findRepeatBills([cityBill("a", "2026-08-13", { accountNo: "50160510000220840" }), cityBill("b", "2026-08-14", { accountNo: "XXXXXXXXXXXXXXX841" })]).size).toBe(0);
    expect(apart({ emailDay: "2026-08-21", emailTime: "2026-08-21T12:00:00.000Z" })).toBe(0);
    expect(apart({ emailDay: "2026-08-20", emailTime: "2026-08-20T12:00:00.000Z" })).toBe(1);
  });

  it("needs a bill with an amount and a due date, not marked Not a bill", () => {
    const apart = (more: Partial<RepeatCandidate>) => findRepeatBills([cityBill("a", "2026-08-13", more), cityBill("b", "2026-08-14", more)]).size;
    expect(apart({ kind: "receipt" })).toBe(0);
    expect(apart({ amountCents: null })).toBe(0);
    expect(apart({ dueDay: null })).toBe(0);
    expect(apart({ billerId: null })).toBe(0);
    // Marking one Not a bill leaves the other as the bill, with no repeat.
    expect(findRepeatBills([cityBill("a", "2026-08-13", { notBill: true }), cityBill("b", "2026-08-14")]).size).toBe(0);
  });

  it("says which email is used instead", () => {
    expect(repeatReason("City of Sioux Falls", "2026-08-14")).toBe(
      "A second email about the City of Sioux Falls bill of 2026-08-14 (same amount and due date): only that one is used.",
    );
  });
});

describe("findCopies", () => {
  it("makes every email with the same Message-ID but the first captured a copy of it", () => {
    const copies = findCopies([
      email("proton-bill-label/1/9", "<bill-1@wm.com>", { capturedAt: "2026-11-02T12:05:00.000Z" }),
      email("proton-bills/1/4", "<bill-1@wm.com>", { capturedAt: "2026-11-02T12:00:00.000Z" }),
      email("proton-bills/1/5", "<bill-2@wm.com>"),
    ]);
    expect(copies).toEqual(new Map([["proton-bill-label/1/9", "proton-bills/1/4"]]));
  });

  it("keeps the one already offered to OurHome as the original, the lowest offer number first", () => {
    const copies = findCopies([
      email("a", "<x@wm.com>", { capturedAt: "2026-11-01T00:00:00.000Z" }),
      email("b", "<x@wm.com>", { offered: 7 }),
      email("c", "<x@wm.com>", { offered: 3, capturedAt: "2026-11-03T00:00:00.000Z" }),
    ]);
    expect(copies).toEqual(
      new Map([
        ["a", "c"],
        ["b", "c"],
      ]),
    );
  });

  it("breaks a tie on the capture id, and compares Message-IDs without their brackets or spaces", () => {
    expect(findCopies([email("b", "<x@wm.com>"), email("a", " x@wm.com ")])).toEqual(new Map([["b", "a"]]));
  });

  it("never makes an email with no Message-ID a copy", () => {
    expect(findCopies([email("a", null), email("b", null), email("c", ""), email("d", "<>")]).size).toBe(0);
  });

  it("tells a copy's reason with its original's mailbox", () => {
    expect(copyReason("Proton bills")).toBe("A copy of an email also captured from the Proton bills mailbox: only that one is used.");
  });
});
