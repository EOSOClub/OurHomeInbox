// Whether an email goes to OurHome, waits, or never goes (the vault's
// "Hand-off" note, section 2), and the document OurHome gets (section 6).

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  duplicateReason,
  handoffDecision,
  handoffDocument,
  isoDay,
  maybeDuplicateReason,
  PAIRING_REASONS,
  REMINDER_REASON,
  type HandoffInput,
  type PaymentHandoff,
} from "../../../src/server/handoff/rules.js";
import type { CaptureListItem } from "../../../src/shared/api.js";
import type { ExtractionSummary } from "../../../src/shared/extraction.js";

type Item = HandoffInput["item"];

function item(more: Partial<Item> = {}, picked: Partial<ExtractionSummary> = {}): Item {
  return {
    id: "proton-bills/1700000000/7",
    mailbox: "Proton bills",
    mailboxSlug: "proton-bills",
    folder: "Folders/Bills",
    uidValidity: "1700000000",
    uid: 7,
    subject: "Your bill is ready",
    from: [{ name: "City Water", address: "billing@water.example" }],
    date: "2026-10-20T14:03:11.000Z",
    capturedAt: "2026-10-21T00:00:00.000Z",
    attachmentCount: 0,
    linkCount: 1,
    hasText: true,
    hasHtml: true,
    biller: { id: 3, name: "City Water", kind: "bill", matchedOn: "water.example" },
    senderVerified: true,
    picked: { kind: "bill", amount: "42.10", dueDate: "2026-11-04", paidDate: null, dueNow: false, needsCheck: false, values: { amount: ["42.10"], dueDate: ["2026-11-04"] }, ...picked },
    tags: [],
    review: null,
    ...more,
  } satisfies Omit<CaptureListItem, "handoff" | "payment">;
}

const input = (it: Item, more: Partial<HandoffInput> = {}): HandoffInput => ({
  item: it,
  messageId: "<abc@water.example>",
  autoSend: false,
  startDate: "2026-10-01",
  payment: null,
  offeredReference: null,
  emailDay: isoDay(it.date ?? it.capturedAt),
  ...more,
});
const checked = { state: "checked" as const, by: "Sam", at: "2026-10-22T00:00:00Z" };
const decide = (it: Item, more: Partial<HandoffInput> = {}) => handoffDecision(input(it, more));

describe("handoffDecision", () => {
  it("never sends reminders, statements, Not a bill, or emails from before the start date", () => {
    expect(decide(item({}, { kind: "reminder" }))).toEqual({ state: "never", reason: REMINDER_REASON });
    expect(decide(item({}, { kind: "statement" }))).toEqual({ state: "never", reason: "Statements are not sent: there is nothing to pay." });
    expect(decide(item({ review: { state: "not-bill", by: "Sam", at: "x" } }))).toEqual({ state: "never", reason: "Marked Not a bill." });
    expect(decide(item({ review: checked }), { startDate: "2026-10-21" })).toMatchObject({ state: "never", reason: expect.stringContaining("before the OurHome connection's start date") });
    // The start date's own day counts; with no connection there is no start date to miss.
    expect(decide(item({ review: checked }), { startDate: "2026-10-20" }).state).toBe("goes");
    expect(decide(item({ review: checked }), { startDate: null }).state).toBe("goes");
  });

  it("never sends a credit, and makes an email with no amount, or two, wait for Fix even when Checked", () => {
    expect(decide(item({ review: checked }, { values: { amount: ["-85.27"] } }))).toEqual({ state: "never", reason: "A credit: nothing is owed." });
    expect(decide(item({ review: checked }, { values: {} }))).toEqual({ state: "waits", reason: "No amount was picked out. Use Fix on the amount." });
    expect(decide(item({ review: checked }, { values: { amount: ["10.00", "12.00"] }, needsCheck: true }))).toEqual({
      state: "waits",
      reason: "Two different amounts were picked out. Use Fix to choose the right one.",
    });
  });

  it("sends a Checked email, saying who checked it", () => {
    const decision = decide(item({ review: checked }));
    expect(decision).toMatchObject({ state: "goes", reason: "Checked by Sam." });
    expect(decision.document).toBeDefined();
    expect(decide(item({ review: { ...checked, by: null } })).reason).toBe("Checked.");
    // Checked goes even with an unverified sender or no biller: a person looked.
    expect(decide(item({ review: checked, senderVerified: false, biller: null })).state).toBe("goes");
  });

  it("makes an unchecked email wait, with why, until its biller sends automatically", () => {
    expect(decide(item({ biller: null }))).toEqual({ state: "waits", reason: "Waits for someone to mark it Checked: its sender is not one of your billers." });
    expect(decide(item())).toEqual({
      state: "waits",
      reason: "Waits for someone to mark it Checked. City Water's emails are checked each time, until 3 in a row need no fix.",
    });
    expect(decide(item({ biller: null }), { autoSend: true }).state).toBe("waits");
  });

  it("sends an automatic biller's clean emails by themselves, and holds back odd ones", () => {
    expect(decide(item(), { autoSend: true })).toMatchObject({ state: "goes", reason: "Sent automatically: City Water's emails need no check." });
    expect(decide(item({ senderVerified: false }), { autoSend: true })).toEqual({ state: "waits", reason: "Waits for someone to mark it Checked: the sender is not verified." });
    expect(decide(item({}, { needsCheck: true, values: { amount: ["42.10"], dueDate: ["2026-11-04", "2026-11-05"] } }), { autoSend: true })).toEqual({
      state: "waits",
      reason: "Waits for someone to mark it Checked: a value was picked out more than once, with different results.",
    });
  });
});

describe("handoffDocument", () => {
  it("maps everything picked out onto OurHome's fields, leaving out what is not known", () => {
    expect(handoffDocument(input(item()))).toEqual({
      kind: "bill",
      messageId: "<abc@water.example>",
      biller: "City Water",
      billerKey: "ourhomeinbox-biller:3",
      billerEmail: "billing@water.example",
      subject: "Your bill is ready",
      amount: 42.1,
      dueDate: "2026-11-04",
      emailDate: "2026-10-20T14:03:11.000Z",
      reference: ohiReference("<abc@water.example>"),
    });
  });

  it("splits a receipt's fee off its amount, and keeps its numbers", () => {
    const receipt = item({}, {
      kind: "receipt",
      values: { amount: ["117.43"], fee: ["2.50"], paidDate: ["2026-10-26"], confirmationNo: ["C77"], accountNo: ["XXXX-1234"], invoiceNo: ["INV 9"] },
    });
    expect(handoffDocument(input(receipt))).toMatchObject({
      kind: "receipt",
      amount: 117.43,
      fee: 2.5,
      baseAmount: 114.93,
      paidDate: "2026-10-26",
      confirmationNo: "C77",
      accountNo: "XXXX-1234",
      invoiceNo: "INV 9",
    });
  });

  it("gives a past due email its own day as the due date, so OurHome shows it overdue", () => {
    expect(handoffDocument(input(item({}, { dueNow: true })))).toMatchObject({ dueDate: "2026-10-20" });
  });

  it("leaves out a value in doubt, and one longer than OurHome takes", () => {
    const doc = handoffDocument(
      input(item({ subject: "x".repeat(999) }, { values: { amount: ["42.10"], dueDate: ["2026-11-04", "2026-11-05"], accountNo: ["1".repeat(121)] } })),
    );
    expect(doc).not.toHaveProperty("dueDate");
    expect(doc).not.toHaveProperty("accountNo");
    expect(doc).not.toHaveProperty("subject");
  });

  it("names an email with no Message-ID by its capture id, and one with no biller without a key", () => {
    const doc = handoffDocument(input(item({ biller: null, date: null }), { messageId: null }));
    expect(doc.messageId).toBe("ourhomeinbox:proton-bills/1700000000/7");
    expect(doc).not.toHaveProperty("biller");
    expect(doc).not.toHaveProperty("billerKey");
    expect(doc).not.toHaveProperty("emailDate");
  });

  it("writes the same email the same way every time (field order fixed)", () => {
    expect(JSON.stringify(handoffDocument(input(item())))).toBe(JSON.stringify(handoffDocument(input(item()))));
  });
});

/** Contract v2: "ohi:" and the first 24 hex characters of the SHA-256 of the messageId. */
const ohiReference = (messageId: string) => `ohi:${createHash("sha256").update(messageId).digest("hex").slice(0, 24)}`;

describe("references and pairing (contract v2)", () => {
  const receipt = (more: Partial<Item> = {}) =>
    item({ subject: "Payment received", ...more }, { kind: "receipt", amount: "80.00", values: { amount: ["80.00"], paidDate: ["2026-11-10"], fee: ["1.00"] } });
  const paired = (more: Partial<Extract<PaymentHandoff, { pairing: "paired" }>> = {}): PaymentHandoff => ({
    pairing: "paired",
    reference: "INV-1",
    feeCents: 0,
    baseCents: 8000,
    paidLate: false,
    billBeforeStart: false,
    billGoes: true,
    ...more,
  });
  const checkedReceipt = receipt({ review: checked });

  it("gives every bill its invoice number as its reference, else one made from its messageId", () => {
    expect(handoffDocument(input(item({}, { values: { amount: ["42.10"], invoiceNo: ["INV 9"] } }))).reference).toBe("INV 9");
    const ref = handoffDocument(input(item())).reference!;
    expect(ref).toMatch(/^ohi:[0-9a-f]{24}$/);
    expect(ref).toBe(ohiReference("<abc@water.example>"));
    // An email with no Message-ID is known by its capture id, and so is its reference.
    expect(handoffDocument(input(item(), { messageId: null })).reference).toBe(ohiReference("ourhomeinbox:proton-bills/1700000000/7"));
  });

  it("sends a paired payment with its bill's reference, the fee and base amount, and paidLate only when late", () => {
    const onTime = handoffDocument(input(checkedReceipt, { payment: paired({ feeCents: 250, baseCents: 7750 }) }));
    expect(onTime).toMatchObject({ kind: "receipt", amount: 80, fee: 2.5, baseAmount: 77.5, reference: "INV-1" });
    expect(onTime).not.toHaveProperty("paidLate");
    const noFee = handoffDocument(input(checkedReceipt, { payment: paired() }));
    expect(noFee).toMatchObject({ fee: 0, baseAmount: 80 });
    expect(handoffDocument(input(checkedReceipt, { payment: paired({ paidLate: true }) })).paidLate).toBe(true);
  });

  it("sends a payment marked Paid on its own with no reference", () => {
    const decision = decide(checkedReceipt, { payment: { pairing: "own" } });
    expect(decision.state).toBe("goes");
    expect(decision.document).not.toHaveProperty("reference");
    expect(decision.document).toMatchObject({ kind: "receipt", fee: 1, baseAmount: 79 });
  });

  it("holds a payment that needs a bill, or whose bill is from before the start date, before the check", () => {
    expect(decide(checkedReceipt, { payment: { pairing: "needs-bill" } })).toEqual({ state: "waits", reason: PAIRING_REASONS.needsBill });
    // A receipt handed in with no pairing at all is treated the same: it is never sent unpaired.
    expect(decide(checkedReceipt)).toEqual({ state: "waits", reason: PAIRING_REASONS.needsBill });
    expect(decide(receipt(), { payment: { pairing: "needs-bill" } }).reason).toBe(PAIRING_REASONS.needsBill);
    expect(decide(checkedReceipt, { payment: paired({ billBeforeStart: true }) })).toEqual({ state: "waits", reason: PAIRING_REASONS.beforeStart });
    expect(PAIRING_REASONS.beforeStart).toContain("Its bill is from before the OurHome start date");
    expect(decide(checkedReceipt, { payment: { pairing: "bill-missing" } }).state).toBe("waits");
  });

  it("lets a payment already sent (locked) go on, whatever its bill's date or state now", () => {
    expect(decide(checkedReceipt, { payment: paired({ billBeforeStart: true, locked: true }) })).toMatchObject({ state: "goes", reason: "Checked by Sam." });
    expect(decide(checkedReceipt, { payment: paired({ billGoes: false, locked: true }) }).state).toBe("goes");
    expect(decide(checkedReceipt, { payment: paired({ billBeforeStart: true, billGoes: false, locked: true }) }).state).toBe("goes");
  });

  it("decides the start date and a past due email's due date on the sender's day it was sent", () => {
    // Sent 8:30 pm Oct 31 in Sioux Falls: Nov 1 in UTC, Oct 31 for the sender.
    const evening = item({ date: "2026-11-01T01:30:00.000Z", review: checked }, { dueNow: true });
    expect(decide(evening, { startDate: "2026-11-01", emailDay: "2026-10-31" }).state).toBe("never");
    expect(decide(evening, { startDate: "2026-11-01", emailDay: "2026-11-01" }).state).toBe("goes");
    expect(handoffDocument(input(evening, { emailDay: "2026-10-31" })).dueDate).toBe("2026-10-31");
  });

  it("never sends a second email about a payment, even when Checked, so OurHome counts the payment once", () => {
    const of = "the Waste Management payment email of 2026-07-11";
    expect(decide(checkedReceipt, { payment: { pairing: "duplicate", of } })).toEqual({ state: "never", reason: duplicateReason(of) });
    expect(duplicateReason(of)).toBe(
      "A second email about the Waste Management payment email of 2026-07-11: it is not sent, so OurHome counts the payment once. If it is a separate payment, choose its bill or mark it Paid on its own.",
    );
    // The usual never rules still come first.
    expect(decide(receipt({ review: { state: "not-bill", by: "Sam", at: "x" } }), { payment: { pairing: "duplicate", of } }).reason).toBe("Marked Not a bill.");
  });

  it("names the payment a payment that needs a bill may repeat, unless its chosen bill went stale", () => {
    const of = "the Midco payment email of 2026-08-27";
    const reason = maybeDuplicateReason(of);
    expect(reason).toBe(`${PAIRING_REASONS.needsBill} It may be a second email about the Midco payment email of 2026-08-27: if so, mark it Not a bill.`);
    expect(decide(checkedReceipt, { payment: { pairing: "needs-bill", maybeDuplicateOf: of } })).toEqual({ state: "waits", reason });
    expect(decide(checkedReceipt, { payment: { pairing: "needs-bill", staleChoice: true, maybeDuplicateOf: of } }).reason).toBe(PAIRING_REASONS.staleChoice);
  });

  it("holds a paired payment until its bill goes, on top of the check rule", () => {
    expect(decide(checkedReceipt, { payment: paired({ billGoes: false }) })).toEqual({ state: "waits", reason: PAIRING_REASONS.billFirst });
    expect(decide(checkedReceipt, { payment: paired() })).toMatchObject({ state: "goes", reason: "Checked by Sam." });
    // Not checked and not automatic: the check rule's wait is what it says.
    expect(decide(receipt(), { payment: paired({ billGoes: false }) }).reason).toContain("Waits for someone to mark it Checked");
    expect(decide(receipt(), { payment: paired() }).state).toBe("waits");
    // The usual never rules come first.
    expect(decide(receipt({ review: { state: "not-bill", by: "Sam", at: "x" } }), { payment: paired() }).state).toBe("never");
  });
});

describe("isoDay", () => {
  it("is the UTC day of a time, or empty", () => {
    expect(isoDay("2026-10-20T23:30:00-05:00")).toBe("2026-10-21");
    expect(isoDay("not a date")).toBe("");
    expect(isoDay(null)).toBe("");
  });
});
