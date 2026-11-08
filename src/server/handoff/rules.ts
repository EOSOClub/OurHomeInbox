// Whether one email goes to OurHome, waits for a person, or is never sent,
// with the reason in plain words, and the document OurHome gets when it goes.
// The rules are the vault's "Hand-off" note, section 2 (owner, 2026-11-01):
//
//   Never: reminders (OurHome gets the bill itself; a reminder a person marked
//   as the bill, or one from a biller whose reminders are its bills, reaches
//   here as a bill, see asBill.ts), statements (nothing to
//   pay), credits (nothing owed), emails marked Not a bill, and emails dated
//   before the connection's start date.
//   Waits: no amount, or two different amounts (Fix settles it; Checked alone
//   does not say which is right).
//   Goes: a person marked it Checked; or its biller sends automatically and
//   the email is clean (sender verified, nothing picked out twice).
//   Otherwise it waits for someone to mark it Checked, with the reason.
//
// A payment (a receipt) also follows its pairing with a bill (section 7,
// worked out in payments/pairing.ts and handed in here): it waits while it
// needs a bill or its bill is dated before the start date (a person can act on
// those, so they come before the check), and, once the check rule lets it go,
// until its bill goes to OurHome first. Every bill carries a `reference`; a
// paired payment carries its bill's, with the fee and whether it was late.
// A second email about a payment another email reports (pairing.ts) is never
// sent, even when Checked, so OurHome counts the payment once (owner,
// 2026-11-02). Copies of one email (copies.ts) are decided in captures.ts.
//
// Pure: no database, no files, so every branch is tested directly.

import { createHash } from "node:crypto";
import type { CaptureListItem } from "../../shared/api.js";
import { CHECKS_BEFORE_AUTO, OURHOME_LIMITS, OURHOME_MAX_AMOUNT, type HandoffDocument, type HandoffState } from "../../shared/handoff.js";
import type { FieldName } from "../../shared/extraction.js";

/** An email as the list has it, before its hand-off and pairing are worked out. */
export type BaseItem = Omit<CaptureListItem, "handoff" | "payment">;

/**
 * A payment's pairing, as the hand-off needs it:
 * - own: Paid on its own; it goes with no reference.
 * - waiting-bill: paid before its bill email came in; it waits for one until `until`.
 * - needs-bill: no bill fits and nobody chose one.
 *   `staleChoice`: someone chose a bill that can no longer be used.
 *   `maybeDuplicateOf`: the payment it may repeat, in words ("the Midco payment email of 2026-08-27").
 * - duplicate: a second email about the payment `of` names, in the same words.
 * - bill-missing: its chosen or locked bill's email cannot be read.
 * - paired: it pays a bill (and with `alsoPays`, others too). `billGoes` is
 *   true when every bill it pays goes to OurHome (they are numbered first, so
 *   they always have the lower numbers). `locked`: the
 *   payment has already been sent, so it no longer waits for its bill.
 */
export type PaymentHandoff =
  | { pairing: "own" }
  | { pairing: "needs-bill"; staleChoice?: boolean; maybeDuplicateOf?: string }
  | { pairing: "waiting-bill"; until: string }
  | { pairing: "duplicate"; of: string }
  | { pairing: "bill-missing" }
  | {
      pairing: "paired";
      reference: string;
      feeCents: number;
      baseCents: number;
      paidLate: boolean;
      billBeforeStart: boolean;
      billGoes: boolean;
      locked?: boolean;
      /** Contract v3: the other bills it pays, oldest first (their references, the part of the payment for each, late or not). None when it pays one. */
      alsoPays?: ReadonlyArray<{ reference: string; cents: number; paidLate: boolean }>;
    };

/** What the rules look at: an email as the list has it, its Message-ID, and the household's settings. */
export interface HandoffInput {
  item: BaseItem;
  /** The email's Message-ID header, or null when it has none. */
  messageId: string | null;
  /** True when the email's biller sends automatically. */
  autoSend: boolean;
  /** The connection's start date ("2026-11-01"), or null with no connection. */
  startDate: string | null;
  /** For a payment (a receipt with an amount): its pairing. Null for anything else; a receipt that reaches the pairing rule without one needs a bill. */
  payment: PaymentHandoff | null;
  /** For a bill already offered: the reference it went with, kept from then on (through a withdrawal too). Null when it never went. */
  offeredReference: string | null;
  /**
   * The day the email was sent, as its sender saw it ("2026-10-31"): its own
   * date shifted by the offset in its Date header (UTC only when it gives
   * none), else the day it was captured. Worked out once (captures.ts), so the
   * start date, a past due email's due date and pairing all agree.
   */
  emailDay: string;
}

export interface HandoffDecision {
  state: HandoffState;
  reason: string;
  /** Only when it goes. */
  document?: HandoffDocument;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The day of an ISO time, as UTC writes it ("2026-10-28"); "" when it is not a time. */
export function isoDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  return Number.isNaN(time) ? "" : new Date(time).toISOString().slice(0, 10);
}

/** The one value found for a field, or null when there is none or more than one. */
function single(item: HandoffInput["item"], field: FieldName): string | null {
  const values = item.picked.values[field] ?? [];
  return values.length === 1 ? values[0]!.trim() || null : null;
}

/** A money value OurHome accepts (a number from 0 up to its limit), or null. */
function money(value: string | null): number | null {
  if (value === null) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 && amount <= OURHOME_MAX_AMOUNT ? amount : null;
}

/** Text within OurHome's limit for that field, or undefined (left out). */
function fit(value: string | null | undefined, field: keyof typeof OURHOME_LIMITS): string | undefined {
  const text = value?.trim();
  return text && [...text].length <= OURHOME_LIMITS[field] ? text : undefined;
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** The Message-ID OurHome knows the email by: its header, or one made from its capture id when it has none (or one too long). */
export function documentMessageId(captureId: string, messageId: string | null): string {
  return fit(messageId, "messageId") ?? `ourhomeinbox:${captureId}`;
}

/** A bill's reference (contract v2): its invoice number, else "ohi:" and the first 24 hex characters of the SHA-256 of its Message-ID. */
export function billReference(input: Pick<HandoffInput, "item" | "messageId">): string {
  const invoiceNo = fit(single(input.item, "invoiceNo"), "invoiceNo");
  if (invoiceNo !== undefined && [...invoiceNo].length <= OURHOME_LIMITS.reference) return invoiceNo;
  const messageId = documentMessageId(input.item.id, input.messageId);
  return `ohi:${createHash("sha256").update(messageId).digest("hex").slice(0, 24)}`;
}

/** The document OurHome gets for an email that goes. Fields are in a fixed order, so the same email always gives the same text. */
export function handoffDocument(input: HandoffInput): HandoffDocument {
  const { item } = input;
  const kind = item.picked.kind === "receipt" ? "receipt" : "bill";
  const doc: HandoffDocument = { kind, messageId: documentMessageId(item.id, input.messageId) };
  const set = <K extends keyof HandoffDocument>(key: K, value: HandoffDocument[K] | null | undefined) => {
    if (value !== undefined && value !== null) doc[key] = value;
  };
  const paired = kind === "receipt" && input.payment?.pairing === "paired" ? input.payment : null;

  set("biller", fit(item.biller?.name, "biller"));
  set("billerKey", item.biller ? `ourhomeinbox-biller:${item.biller.id}` : undefined);
  set("billerEmail", fit(item.from[0]?.address, "billerEmail"));
  set("subject", fit(item.subject, "subject"));

  const amount = money(single(item, "amount"));
  set("amount", amount);
  if (paired) {
    // A paired payment's fee is the payment less its bill (contract v2), not a fee the email names.
    set("fee", paired.feeCents / 100);
    set("baseAmount", paired.baseCents / 100);
  } else {
    const fee = money(single(item, "fee"));
    if (fee !== null) {
      set("fee", fee);
      if (amount !== null && fee <= amount) set("baseAmount", cents(amount - fee));
    }
  }

  // A past due email is due now, whatever date it prints: the day it was sent, so OurHome shows it overdue at once.
  const emailDay = input.emailDay;
  const dueDate = item.picked.dueNow ? emailDay : single(item, "dueDate");
  set("dueDate", dueDate && DAY.test(dueDate) ? dueDate : undefined);
  const paidDate = single(item, "paidDate");
  set("paidDate", paidDate && DAY.test(paidDate) ? paidDate : undefined);
  set("emailDate", item.date && !Number.isNaN(Date.parse(item.date)) ? new Date(item.date).toISOString() : undefined);

  set("invoiceNo", fit(single(item, "invoiceNo"), "invoiceNo"));
  set("confirmationNo", fit(single(item, "confirmationNo"), "confirmationNo"));
  set("accountNo", fit(single(item, "accountNo"), "accountNo"));
  // Contract v2: every bill carries its reference (the one it first went with, once offered); a paired payment carries its bill's, and paidLate only when late.
  if (kind === "bill") set("reference", input.offeredReference ?? billReference(input));
  if (paired) {
    set("reference", paired.reference);
    if (paired.paidLate) set("paidLate", true);
    // Contract v3: the other bills a payment for several pays, oldest first, each with its part (no fee).
    if (paired.alsoPays && paired.alsoPays.length > 0) {
      set(
        "alsoPays",
        paired.alsoPays.map(({ reference, cents, paidLate }) => ({ reference, amount: cents / 100, ...(paidLate ? { paidLate: true as const } : {}) })),
      );
    }
  }
  return doc;
}

const CHECK = "Waits for someone to mark it Checked";

export const REMINDER_REASON =
  "Reminders are not sent: OurHome gets the bill itself. If the bill's own email never came in, use this reminder as the bill (in Picked out). If this biller sends all its bills as reminders, say so on the biller's page.";

export const PAIRING_REASONS = {
  needsBill: "Needs a bill: no bill email fits this payment. On its page, use Choose a bill, or mark it Paid on its own.",
  staleChoice: "The bill chosen for this payment can no longer be used. Choose another.",
  billMissing: "Its bill's email can no longer be read (its mailbox may have been removed). On its page, use Choose a bill.",
  beforeStart: "Its bill is from before the OurHome start date. On its page, choose another bill, or mark it Paid on its own.",
  billFirst: "Waits for its bill to go to OurHome first.",
} as const;

/** Why a second email about a payment is never sent. `of` names the payment, "the Waste Management payment email of 2026-07-11". */
export function duplicateReason(of: string): string {
  return `A second email about ${of}: it is not sent, so OurHome counts the payment once. If it is a separate payment, choose its bill or mark it Paid on its own.`;
}

/** Why a payment made before its bill email came in waits. `until` is the last day it waits ("2026-11-19"). */
export function waitingReason(until: string): string {
  return `Waits for its bill email: it was paid before the bill came in. If no bill email fits it by ${until}, it will need a bill. To pick one now, use Choose a bill.`;
}

/** Needs a bill, naming the payment it may repeat. */
export function maybeDuplicateReason(of: string): string {
  return `${PAIRING_REASONS.needsBill} It may be a second email about ${of}: if so, mark it Not a bill.`;
}

/** Whether the email goes to OurHome, waits, or never goes, and why. */
export function handoffDecision(input: HandoffInput): HandoffDecision {
  const decision = checkDecision(input);
  // A payment follows its bill: only once the check rule lets it go does it wait for the bill to go first.
  // One already sent (locked) has gone, so what its bill does now no longer holds it back.
  const payment = input.payment;
  if (decision.state === "goes" && input.item.picked.kind === "receipt" && payment?.pairing === "paired" && !payment.billGoes && !payment.locked) {
    return { state: "waits", reason: PAIRING_REASONS.billFirst };
  }
  return decision;
}

/** The section 2 rules, with the pairing waits a person can act on (needs a bill, bill before the start date). */
function checkDecision(input: HandoffInput): HandoffDecision {
  const { item, autoSend, startDate } = input;
  const never = (reason: string): HandoffDecision => ({ state: "never", reason });
  const waits = (reason: string): HandoffDecision => ({ state: "waits", reason });

  if (item.picked.kind === "reminder") return never(REMINDER_REASON);
  if (item.picked.kind === "statement") return never("Statements are not sent: there is nothing to pay.");
  if (item.review?.state === "not-bill") return never("Marked Not a bill.");
  if (startDate !== null) {
    const day = input.emailDay;
    if (day !== "" && day < startDate) return never("Dated before the OurHome connection's start date (Settings).");
  }

  const amounts = item.picked.values.amount ?? [];
  if (amounts.length === 0) return waits("No amount was picked out. Use Fix on the amount.");
  if (amounts.length > 1) return waits("Two different amounts were picked out. Use Fix to choose the right one.");
  const amount = Number(amounts[0]);
  if (Number.isFinite(amount) && amount < 0) return never("A credit: nothing is owed.");
  if (money(amounts[0]!) === null) return waits("The amount could not be read as money. Use Fix on the amount.");

  if (item.picked.kind === "receipt") {
    const payment = input.payment ?? { pairing: "needs-bill" };
    if (payment.pairing === "duplicate") return never(duplicateReason(payment.of));
    if (payment.pairing === "waiting-bill") return waits(waitingReason(payment.until));
    if (payment.pairing === "needs-bill") {
      if (payment.staleChoice) return waits(PAIRING_REASONS.staleChoice);
      return waits(payment.maybeDuplicateOf ? maybeDuplicateReason(payment.maybeDuplicateOf) : PAIRING_REASONS.needsBill);
    }
    if (payment.pairing === "bill-missing") return waits(PAIRING_REASONS.billMissing);
    if (payment.pairing === "paired" && payment.billBeforeStart && !payment.locked) return waits(PAIRING_REASONS.beforeStart);
  }

  const goes = (reason: string): HandoffDecision => ({ state: "goes", reason, document: handoffDocument(input) });
  if (item.review?.state === "checked") return goes(item.review.by ? `Checked by ${item.review.by}.` : "Checked.");

  const biller = item.biller;
  if (!biller) return waits(`${CHECK}: its sender is not one of your billers.`);
  if (!autoSend) return waits(`${CHECK}. ${biller.name}'s emails are checked each time, until ${CHECKS_BEFORE_AUTO} in a row need no fix.`);
  if (!item.senderVerified) return waits(`${CHECK}: the sender is not verified.`);
  if (item.picked.needsCheck) return waits(`${CHECK}: a value was picked out more than once, with different results.`);
  return goes(`Sent automatically: ${biller.name}'s emails need no check.`);
}
