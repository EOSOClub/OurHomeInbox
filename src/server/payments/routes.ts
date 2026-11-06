// Choosing which bill a payment email pays (the vault's "Hand-off" note,
// section 7), signed in:
//   GET /api/captures/:mailbox/:uidValidity/:uid/bill-choices[?all=1]   the bills the picker lists, newest first
//   PUT /api/captures/:mailbox/:uidValidity/:uid/pairing                a bill (or several), Paid on its own, or Let OurHomeInbox choose
//
// Scoped to the signed-in person's household: only its emails can be named.
// Once a payment has been offered to OurHome as ready its pairing is locked,
// and a change is refused with a 409 that says to change it in OurHome.

import { Hono, type Context } from "hono";
import { z } from "zod";
import type { CaptureListItem, SessionUser } from "../../shared/api.js";
import { MAX_BILLS_PER_PAYMENT, type BillChoice, type BillChoicesResponse, type BillSide, type PairingResponse } from "../../shared/payments.js";
import type { CaptureStore } from "../../store.js";
import type { CaptureCache } from "../captureCache.js";
import { readHouseholdEmails, type HouseholdEmail } from "../captures.js";
import type { Database } from "../db.js";
import { apiError, householdOf, jsonBody, MESSAGES, type AppEnv } from "../http.js";
import { UID, UID_VALIDITY } from "../mail.js";
import type { Mailboxes } from "../mailboxes.js";
import { clearPick, setPick } from "./store.js";

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

/**
 * The bills the picker lists for one payment, newest first: that biller's,
 * or every biller's with `all` (always, for a payment with no biller). A bill
 * that another payment pays, that OurHome reported paid or removed, or whose
 * amount is not settled, is listed but cannot be picked.
 */
export function billChoices(emails: readonly HouseholdEmail[], payment: CaptureListItem, all: boolean): BillChoicesResponse {
  const side = payment.payment?.role === "payment" ? payment.payment : null;
  const billerId = payment.biller?.id ?? null;
  const every = all || billerId === null;
  const locked = side?.locked ?? false;
  const bills = emails
    .filter(({ item }) => item.payment?.role === "bill" && (every || item.biller?.id === billerId))
    .map(({ item, seen }): BillChoice & { time: string } => {
      const info = item.payment as BillSide;
      let state: BillChoice["state"] = "unpaid";
      let reason: string | null = null;
      if (info.ourhome) {
        state = info.ourhome.change;
        reason = CHOICE_REASONS[info.ourhome.change];
      } else if (info.paidBy?.id === payment.id) {
        state = "this";
      } else if (info.paidBy) {
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
        state,
        canPick: reason === null,
        reason,
        paidByDate: info.paidBy?.date ?? null,
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
      // Every bill picked must get some of the payment: it is shared out oldest first.
      if (chosen.length > 1 && listed.paymentAmount !== null) {
        let before = 0;
        for (const bill of chosen.slice(0, -1)) before += Math.round((bill.amount ?? 0) * 100);
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

  return app;
}
