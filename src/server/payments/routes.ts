// Choosing which bill a payment email pays (the vault's "Hand-off" note,
// section 7), signed in:
//   GET /api/captures/:mailbox/:uidValidity/:uid/bill-choices[?all=1]   the bills the picker lists, newest first
//   PUT /api/captures/:mailbox/:uidValidity/:uid/pairing                a bill (or several), Paid on its own, or Let OurHomeInbox choose
// and from a bill's side (Choose its payment, owner 2026-11-07):
//   GET /api/captures/:mailbox/:uidValidity/:uid/payment-choices[?all=1]   the payments the picker lists, newest first
//   PUT /api/captures/:mailbox/:uidValidity/:uid/payer                     this payment pays the bill (a person's pick on that payment)
//
// Scoped to the signed-in person's household: only its emails can be named.
// Once a payment has been offered to OurHome as ready its pairing is locked,
// and a change is refused with a 409 that says to change it in OurHome.

import { Hono, type Context } from "hono";
import { z } from "zod";
import type { CaptureListItem, SessionUser } from "../../shared/api.js";
import {
  MAX_BILLS_PER_PAYMENT,
  type BillChoice,
  type BillChoicesResponse,
  type BillSide,
  type PairingResponse,
  type PayerResponse,
  type PaymentChoice,
  type PaymentChoicesResponse,
  type PaymentChoiceState,
  type PaymentSide,
} from "../../shared/payments.js";
import type { CaptureStore } from "../../store.js";
import type { CaptureCache } from "../captureCache.js";
import { readHouseholdEmails, type HouseholdEmail } from "../captures.js";
import type { Database } from "../db.js";
import { apiError, householdOf, jsonBody, MESSAGES, type AppEnv } from "../http.js";
import { UID, UID_VALIDITY } from "../mail.js";
import type { Mailboxes } from "../mailboxes.js";
import { clearPick, householdPairings, setPick } from "./store.js";

export interface PaymentDeps {
  store: CaptureStore;
  db: Database;
  mailboxes: Mailboxes;
  cache: CaptureCache;
  now: () => Date;
}

const NOT_FOUND = "That email was not found. It may be in a mailbox that is no longer set up.";
const BAD_LINK = "That link does not point to a saved email.";
const NOT_A_PAYMENT =
  "Only a payment email can be paired with a bill. This one is not a payment: it may not be a receipt, have no amount yet, or be marked Not a bill.";
const LOCKED = "This payment has been sent to OurHome, so its bill can no longer be changed here. Change it in OurHome.";
const NO_BILL = "That bill was not found. It may be in a mailbox that is no longer set up.";
const NOT_A_BILL =
  "Only a bill email can be given its payment. This one is not a bill: it may be another kind of email, be marked Not a bill, or be a second email about a bill.";
const NO_PAYMENT = "That payment was not found. It may be in a mailbox that is no longer set up.";
export const PAID_BY_SENT = "A payment already sent to OurHome pays this bill, so its payment can only be changed in OurHome.";

export const CHOICE_REASONS = {
  paid: "OurHome says this bill was paid there by hand.",
  removed: "This bill was removed in OurHome.",
  paired: "Another payment already pays this bill.",
  noAmount: "Its amount is not settled. Use Fix on its amount first.",
  credit: "It is a credit: nothing is owed.",
  locked: "This payment has been sent to OurHome; change it there.",
} as const;

const TOO_MANY = `A payment can pay up to ${MAX_BILLS_PER_PAYMENT} bills.`;
const TWICE = "Each bill can only be picked once.";

const billIdSchema = z.string({ error: MESSAGES.badShape }).min(1, NO_BILL).max(300, NO_BILL);

const pairingSchema = z.discriminatedUnion(
  "choice",
  [
    z.object({ choice: z.literal("bill"), billId: billIdSchema }),
    z.object({
      choice: z.literal("bills"),
      billIds: z.array(billIdSchema, { error: MESSAGES.badShape }).min(1, NO_BILL).max(MAX_BILLS_PER_PAYMENT, TOO_MANY),
    }),
    z.object({ choice: z.literal("own") }),
    z.object({ choice: z.literal("auto") }),
  ],
  { error: MESSAGES.badShape },
);

const payerSchema = z.object({ paymentId: z.string({ error: MESSAGES.badShape }).min(1, NO_PAYMENT).max(300, NO_PAYMENT) }, { error: MESSAGES.badShape });

/** The one value found for a field, or null when there is none or more than one. */
function single(item: CaptureListItem, field: "invoiceNo"): string | null {
  const values = item.picked.values[field] ?? [];
  return values.length === 1 ? values[0]!.trim() || null : null;
}

/** Who sent it: the first From name, else its address. */
function sender(item: CaptureListItem): string {
  const first = item.from[0];
  return first ? first.name.trim() || first.address.trim() : "";
}

/** What other payments than `paymentId` pay of each bill, in cents, by bill id (part payments, owner 2026-11-07). */
function paidByOthers(emails: readonly HouseholdEmail[], paymentId: string): Map<string, number> {
  const paid = new Map<string, number>();
  const add = (billId: string, cents: number) => paid.set(billId, (paid.get(billId) ?? 0) + cents);
  for (const { item, pairing } of emails) {
    if (item.id === paymentId || !pairing || pairing.billId === null || pairing.needsBill || pairing.billMissing) continue;
    add(pairing.billId, pairing.baseCents);
    for (const also of pairing.also) add(also.billId, also.cents);
  }
  return paid;
}

/**
 * The bills the picker lists for one payment, newest first: that biller's,
 * or every biller's with `all` (always, for a payment with no biller). A bill
 * that other payments pay in full, that OurHome reported paid or removed, or
 * whose amount is not settled, is listed but cannot be picked. A bill other
 * payments pay only in part can be picked, for what is still owed.
 */
export function billChoices(emails: readonly HouseholdEmail[], payment: CaptureListItem, all: boolean): BillChoicesResponse {
  const side = payment.payment?.role === "payment" ? payment.payment : null;
  const billerId = payment.biller?.id ?? null;
  const every = all || billerId === null;
  const locked = side?.locked ?? false;
  const others = paidByOthers(emails, payment.id);
  const bills = emails
    .filter(({ item }) => item.payment?.role === "bill" && (every || item.biller?.id === billerId))
    .map(({ item, seen }): BillChoice & { time: string } => {
      const info = item.payment as BillSide;
      const payers = info.paidBy ? [info.paidBy, ...info.alsoPaidBy] : [];
      const otherPayers = payers.filter((payer) => payer.id !== payment.id);
      const owedCents = seen.amountCents === null ? null : Math.max(seen.amountCents - (others.get(item.id) ?? 0), 0);
      let state: BillChoice["state"] = "unpaid";
      let reason: string | null = null;
      if (info.ourhome) {
        state = info.ourhome.change;
        reason = CHOICE_REASONS[info.ourhome.change];
      } else if (payers.some((payer) => payer.id === payment.id)) {
        state = "this";
      } else if (otherPayers.length > 0 && owedCents !== null && owedCents > 0) {
        state = "part";
      } else if (otherPayers.length > 0) {
        state = "paired";
        reason = CHOICE_REASONS.paired;
      } else if (seen.amountCents === null || seen.amountCents < 0) {
        state = "unusable";
        reason = seen.amountCents === null ? CHOICE_REASONS.noAmount : CHOICE_REASONS.credit;
      }
      if (locked && reason === null) reason = CHOICE_REASONS.locked;
      return {
        id: item.id,
        date: item.date ?? item.capturedAt,
        amount: seen.amountCents === null ? null : seen.amountCents / 100,
        owed: owedCents === null ? null : owedCents / 100,
        state,
        canPick: reason === null,
        reason,
        paidByDate: (otherPayers[0] ?? payers[0])?.date ?? null,
        biller: item.biller?.name ?? null,
        sender: sender(item),
        subject: item.subject,
        dueDate: seen.dueDay,
        invoiceNo: single(item, "invoiceNo"),
        time: seen.emailTime,
      };
    })
    .sort((a, b) => b.time.localeCompare(a.time) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .map(({ time: _time, ...choice }) => choice);
  const cents = emails.find(({ item }) => item.id === payment.id)?.seen.amountCents ?? null;
  return { biller: payment.biller?.name ?? null, all: every, bills, locked, paymentAmount: cents === null ? null : cents / 100 };
}

/** The payment emails that pay a bill now, first one first (BillSide). */
function payersOf(bill: CaptureListItem): Array<{ id: string; date: string }> {
  const info = bill.payment?.role === "bill" ? bill.payment : null;
  return info?.paidBy ? [info.paidBy, ...info.alsoPaidBy] : [];
}

/**
 * The payments a bill's picker lists, newest first (owner, 2026-11-07): that
 * biller's, or every biller's with `all` (always, for a bill with no biller).
 * Picking one adds it to the bill's payments while the bill is unpaid or paid
 * only in part, and replaces them while they pay it in full. A payment sent to
 * OurHome is listed but cannot be picked; nothing can be picked when the bill
 * cannot be paid, or a sent payment pays it in full.
 */
export function paymentChoices(emails: readonly HouseholdEmail[], bill: CaptureListItem, all: boolean): PaymentChoicesResponse {
  const info = bill.payment?.role === "bill" ? bill.payment : null;
  const billerId = bill.biller?.id ?? null;
  const every = all || billerId === null;
  const byId = new Map(emails.map((email) => [email.item.id, email]));
  const cents = byId.get(bill.id)?.seen.amountCents ?? null;
  const payers = payersOf(bill);
  const mode = payers.length > 0 && !info?.part ? "replace" : "add";
  let blocked: string | null = null;
  if (info?.ourhome) blocked = CHOICE_REASONS[info.ourhome.change];
  else if (cents === null) blocked = CHOICE_REASONS.noAmount;
  else if (cents < 0) blocked = CHOICE_REASONS.credit;
  else if (mode === "replace" && payers.some((payer) => byId.get(payer.id)?.pairing?.locked)) blocked = PAID_BY_SENT;

  const payments = emails
    .filter(({ item }) => item.payment?.role === "payment" && (every || item.biller?.id === billerId))
    .map(({ item, seen }): PaymentChoice & { time: string } => {
      const side = item.payment as PaymentSide;
      const pays = side.bill ? [side.bill, ...side.alsoBills].map(({ id, date }) => ({ id, date })) : [];
      let state: PaymentChoiceState = "free";
      let reason: string | null = null;
      if (pays.some((paid) => paid.id === bill.id)) state = "this";
      else if (side.locked) {
        state = "locked";
        reason = CHOICE_REASONS.locked;
      } else if (side.duplicateOf) state = "duplicate";
      else if (side.how === "own") state = "own";
      else if (pays.length > 0) state = "other";
      return {
        id: item.id,
        date: item.date ?? item.capturedAt,
        amount: seen.amountCents === null ? null : seen.amountCents / 100,
        state,
        canPick: blocked === null && reason === null && state !== "this",
        reason,
        pays,
        biller: item.biller?.name ?? null,
        sender: sender(item),
        subject: item.subject,
        paidDate: seen.paidDay,
        time: seen.emailTime,
      };
    })
    .sort((a, b) => b.time.localeCompare(a.time) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .map(({ time: _time, ...choice }) => choice);
  return { biller: bill.biller?.name ?? null, all: every, payments, billAmount: cents === null ? null : cents / 100, mode, blocked };
}

/** "Nov 4" for a bill's date, in the server's words (an email date, ISO). */
const shortDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function paymentRoutes(deps: PaymentDeps): Hono<AppEnv> {
  const { db, mailboxes, now } = deps;
  const app = new Hono<AppEnv>();

  /** The email the route names, as its capture id, or an error reply. Only the household's own mailboxes count. */
  const emailId = (c: Context<AppEnv>): string | Response => {
    const { mailbox: slug = "", uidValidity = "", uid = "" } = c.req.param();
    if (!mailboxes.places(householdOf(c)).has(slug)) return apiError(c, 404, NOT_FOUND);
    if (!UID_VALIDITY.test(uidValidity) || !UID.test(uid) || !Number.isSafeInteger(Number(uid))) return apiError(c, 400, BAD_LINK);
    return `${slug}/${uidValidity}/${Number(uid)}`;
  };

  /** The household's emails and the payment the route names, or an error reply. */
  const findPayment = async (c: Context<AppEnv>): Promise<{ emails: HouseholdEmail[]; payment: CaptureListItem } | Response> => {
    const id = emailId(c);
    if (id instanceof Response) return id;
    const emails = await readHouseholdEmails(deps, householdOf(c));
    const payment = emails.find((email) => email.item.id === id)?.item;
    if (!payment) return apiError(c, 404, NOT_FOUND);
    if (payment.payment?.role !== "payment") return apiError(c, 409, NOT_A_PAYMENT);
    return { emails, payment };
  };

  app.get("/captures/:mailbox/:uidValidity/:uid/bill-choices", async (c) => {
    const found = await findPayment(c);
    if (found instanceof Response) return found;
    return c.json(billChoices(found.emails, found.payment, c.req.query("all") === "1"));
  });

  app.put("/captures/:mailbox/:uidValidity/:uid/pairing", jsonBody(pairingSchema), async (c) => {
    const found = await findPayment(c);
    if (found instanceof Response) return found;
    const { payment, emails } = found;
    if (payment.payment?.role === "payment" && payment.payment.locked) return apiError(c, 409, LOCKED);
    const householdId = householdOf(c);
    const request = c.req.valid("json");

    let result: "saved" | "locked";
    if (request.choice === "auto") {
      result = clearPick(db, householdId, payment.id);
    } else if (request.choice === "own") {
      result = setPick(db, householdId, payment.id, null, (c.var.user as SessionUser).id, now());
    } else {
      const ids = request.choice === "bill" ? [request.billId] : request.billIds;
      if (new Set(ids).size !== ids.length) return apiError(c, 400, TWICE);
      const listed = billChoices(emails, payment, true);
      const chosen: BillChoice[] = [];
      for (const id of ids) {
        const choice = listed.bills.find((bill) => bill.id === id);
        if (!choice) return apiError(c, 404, NO_BILL);
        if (!choice.canPick) return apiError(c, 409, choice.reason ?? NO_BILL);
        chosen.push(choice);
      }
      // Oldest first, as pairing reads them: the oldest is the payment's bill, the others what it also pays.
      const seenOf = new Map(emails.map((email) => [email.item.id, email.seen]));
      chosen.sort((a, b) => seenOf.get(a.id)!.emailTime.localeCompare(seenOf.get(b.id)!.emailTime) || a.id.localeCompare(b.id));
      // Every bill picked must get some of the payment: it is shared out oldest first, each bill taking what is still owed on it.
      if (chosen.length > 1 && listed.paymentAmount !== null) {
        let before = 0;
        for (const bill of chosen.slice(0, -1)) before += Math.round((bill.owed ?? bill.amount ?? 0) * 100);
        if (Math.round(listed.paymentAmount * 100) <= before) {
          return apiError(c, 409, `This payment is used up by the older bills before it reaches the ${shortDay(chosen[chosen.length - 1]!.date)} bill. Pick fewer bills.`);
        }
      }
      const [main, ...also] = chosen;
      result = setPick(db, householdId, payment.id, main!.id, (c.var.user as SessionUser).id, now(), also.map((bill) => bill.id));
    }
    if (result === "locked") return apiError(c, 409, LOCKED);

    const fresh = (await readHouseholdEmails(deps, householdId)).find((email) => email.item.id === payment.id);
    const body: PairingResponse = { payment: fresh?.item.payment ?? null };
    return c.json(body);
  });

  /** The household's emails and the bill the route names, or an error reply. */
  const findBill = async (c: Context<AppEnv>): Promise<{ emails: HouseholdEmail[]; bill: CaptureListItem } | Response> => {
    const id = emailId(c);
    if (id instanceof Response) return id;
    const emails = await readHouseholdEmails(deps, householdOf(c));
    const bill = emails.find((email) => email.item.id === id)?.item;
    if (!bill) return apiError(c, 404, NOT_FOUND);
    if (bill.payment?.role !== "bill") return apiError(c, 409, NOT_A_BILL);
    return { emails, bill };
  };

  app.get("/captures/:mailbox/:uidValidity/:uid/payment-choices", async (c) => {
    const found = await findBill(c);
    if (found instanceof Response) return found;
    return c.json(paymentChoices(found.emails, found.bill, c.req.query("all") === "1"));
  });

  // This payment pays the bill: saved as a person's pick on the payment (only this bill), as Choose a bill
  // on that payment would. When other payments pay the bill in full, it takes their place: a person's pick of
  // this bill on them goes (they keep their other bills, else OurHomeInbox chooses for them again).
  app.put("/captures/:mailbox/:uidValidity/:uid/payer", jsonBody(payerSchema), async (c) => {
    const found = await findBill(c);
    if (found instanceof Response) return found;
    const { emails, bill } = found;
    const { paymentId } = c.req.valid("json");
    const householdId = householdOf(c);
    const userId = (c.var.user as SessionUser).id;
    const listed = paymentChoices(emails, bill, true);
    if (listed.blocked !== null) return apiError(c, 409, listed.blocked);
    const choice = listed.payments.find((payment) => payment.id === paymentId);
    if (!choice) return apiError(c, 404, NO_PAYMENT);
    if (choice.state !== "this") {
      if (!choice.canPick) return apiError(c, 409, choice.reason ?? NO_PAYMENT);
      const stamp = now();
      if (listed.mode === "replace") {
        const fixed = householdPairings(db, householdId);
        for (const payer of payersOf(bill)) {
          const pick = fixed.get(payer.id);
          if (payer.id === paymentId || !pick || pick.locked || pick.billId === null) continue;
          const ids = [pick.billId, ...pick.alsoBillIds];
          if (!ids.includes(bill.id)) continue;
          const rest = ids.filter((other) => other !== bill.id);
          if (rest.length === 0) clearPick(db, householdId, payer.id);
          else setPick(db, householdId, payer.id, rest[0]!, userId, stamp, rest.slice(1));
        }
      }
      if (setPick(db, householdId, paymentId, bill.id, userId, stamp) === "locked") return apiError(c, 409, LOCKED);
    }
    const fresh = (await readHouseholdEmails(deps, householdId)).find((email) => email.item.id === bill.id);
    const body: PayerResponse = { bill: fresh?.item.payment ?? null };
    return c.json(body);
  });

  return app;
}
