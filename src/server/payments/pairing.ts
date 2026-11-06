// Which bill email each payment email pays (the vault's "Hand-off" note,
// section 7; owner, 2026-11-01). Worked out on read, like the hand-off
// decision, from the household's emails, the pairings people chose or that
// were locked on sending, and what OurHome reported.
//
//   A payment: a receipt with an amount that is not a credit, not marked Not
//   a bill. Its day is its paid date, else its email date. (One with no biller
//   is a payment too: it can never be paired by itself, so it needs a bill
//   until a person chooses.)
//   A candidate bill: same biller, kind bill, an amount that is not a credit,
//   not marked Not a bill, an email date on or before the payment's day, not
//   paired with another payment, and not reported paid or removed by OurHome.
//   Fixed first: pairings a person chose, and pairings locked on sending.
//   Then, a payment whose invoice number is a candidate's takes that one (the
//   city's receipts name the invoice they pay). Then, per biller, the other
//   payments in date order each take the oldest candidate
//   that asks for money (more than 0.00) whose amount fits: when the payment
//   email states its own fee ("Convenience Fee $ 1.99"), the bill must be
//   exactly the payment less that fee; otherwise OurHome's fee band (at least
//   the bill, at most the bill plus the larger of 6.00 or 4% of it), in cents.
//   (Seen 2026-11-05 in real mail: a 0.00 bill took a 4.13 payment through the
//   6.00 band, and a 60.00 payment stating a 0.00 fee took a 56.52 bill.)
//   Then, a payment still without a bill takes the first fitting candidate
//   that came in after it, at most BILL_WAIT_DAYS later (paid before the bill
//   email arrived; owner, 2026-11-05), the one naming its invoice number
//   first. Until those days are past, one with a biller and no bill waits for
//   its bill email instead of needing a bill.
//   One payment for several bills (owner, 2026-11-05; contract v3): when no
//   one bill fits, the biller's oldest unpaid bills, 2 to AUTO_BILLS_MAX in
//   date order (before the payment or within its days after), when their sum
//   fits. A person can pick several. The oldest is its bill (with the fee);
//   the others are what it also pays, each with its part and its own late.
//   Paid late: another bill of the same biller (asking for money, not Not a
//   bill) dated after the paired bill and on or before the payment's day; or
//   the payment's day is after the bill's due date.
//   Fee: the payment less the bill when more, else 0 (a part payment a person
//   chose has no fee); the base amount is the payment less the fee.
//   Locked pairings are applied first and never change. A person's choice is
//   kept only while its bill can still be paid (a bill, not Not a bill, a
//   settled amount that is not a credit, not reported paid or removed) and no
//   locked pairing has taken it; otherwise the payment needs a bill again.
//   Days are the sender's own days (the offset in the email's Date header),
//   as paid dates are printed; UTC days only when the header gives no offset.
//
// Second emails about one payment (owner, 2026-11-02): a biller's own payment
// confirmation and a payment service's receipt for the same payment (PayPal's
// "Waste Management Nat...: $57.39 USD"), or a biller confirming twice. Last,
// after the automatic pairing, in date order: a payment that still needs a
// bill and that nobody chose a bill for is a duplicate of another payment (the
// original) with a biller, the same amount in cents, and payment days at most
// DUPLICATE_DAYS apart, when either
//   - both have the same biller, and the original has a bill (or Paid on its
//     own, or is locked) or is the older of the two; or
//   - it has no biller and its subject or From name names the original's
//     biller (the name's first NAME_KEY characters, from the start of a word,
//     since PayPal cuts long names short).
// The original is one that has its bill first, then the nearest day, then the
// oldest; a duplicate is never an original. A duplicate is never sent, so
// OurHome counts the payment once. A person overrides it by choosing a bill or
// Paid on its own; a locked payment was sent already and is never one.
// A payment with no biller that matches only on amount and days is left
// needing a bill, with that payment named as a maybe (a person decides).
//
// Pure: no database, no files, so every rule is tested directly.

import type { EmailKind, FieldName } from "../../shared/extraction.js";
import { AUTO_BILLS_MAX, BILL_WAIT_DAYS, DUPLICATE_DAYS, FEE_FLOOR_CENTS, FEE_PERCENT, type PairingHow } from "../../shared/payments.js";
import { isoDay, type BaseItem } from "../handoff/rules.js";

/** One email as pairing sees it. */
export interface PairingEmail {
  id: string;
  kind: EmailKind;
  billerId: number | null;
  /** The biller's name, or null. */
  billerName: string | null;
  /** Its subject and first From name, lower case, spaces collapsed: where a payment service's receipt names the biller. */
  names: string;
  /** The one amount picked out, in cents; null when there is none, more than one, or it is not money. */
  amountCents: number | null;
  /** The one fee picked out (a payment's own "Convenience Fee" line), in cents; null when there is none or more than one. */
  feeCents: number | null;
  /** The one invoice number picked out, as `numberKey` writes it; null when there is none or more than one. */
  invoiceNo: string | null;
  /** The one account number picked out, as `numberKey` writes it; null when there is none or more than one. */
  accountNo: string | null;
  notBill: boolean;
  /** The email's own date, else when it was captured (ISO): orders emails of the same day. */
  emailTime: string;
  /** The day of emailTime, "2026-10-06". */
  emailDay: string;
  /** The one paid date picked out, or null. */
  paidDay: string | null;
  /** The bill's due date (a past due email is due on its own day), or null. */
  dueDay: string | null;
}

/** A pairing that is not worked out again: a person's choice, or one locked on sending. */
export interface FixedPairing {
  /** The bill, or null for Paid on its own. */
  billId: string | null;
  /** The other bills it pays when it pays several (`billId` is the oldest); none otherwise. */
  alsoBillIds: readonly string[];
  /** Sent to OurHome: never changes again. */
  locked: boolean;
  /** A person chose it (Choose a bill, or Paid on its own). */
  person: boolean;
  /** When it was chosen (ISO): of two people's picks of one bill, the earlier keeps it. */
  chosenAt: string;
}

export interface PairingInput {
  emails: readonly PairingEmail[];
  /** By payment id. */
  fixed: ReadonlyMap<string, FixedPairing>;
  /** Bills OurHome reported paid by hand or removed, by id. */
  reported: ReadonlySet<string>;
  /** The OurHome connection's start date, or null with no connection. */
  startDate: string | null;
  /** Today ("2026-11-05"): a payment with no bill yet waits for its bill email until BILL_WAIT_DAYS after it. */
  today: string;
}

export interface PaymentPairing {
  paymentId: string;
  /** The bill it pays, or null (Paid on its own, or it needs a bill). */
  billId: string | null;
  /** Null while it needs a bill. */
  how: PairingHow | null;
  locked: boolean;
  needsBill: boolean;
  paidLate: boolean;
  /** The payment less all its bills when more, else 0; it belongs to the bill in billId. */
  feeCents: number;
  /** The part of the payment that pays the bill in billId (the whole payment less the fee, when it pays one bill). */
  baseCents: number;
  /** The other bills it pays, oldest first, when it pays several (contract v3 `alsoPays`): the part of the payment for each, and whether that one was late. */
  also: Array<{ billId: string; cents: number; paidLate: boolean }>;
  /** A fixed pairing names a bill email that is not among the household's emails (its mailbox removed, say). */
  billMissing: boolean;
  /** Its bill is dated before the OurHome start date. */
  beforeStart: boolean;
  /** A person chose a bill that can no longer be used, so it needs a bill again. */
  staleChoice: boolean;
  /** Paid before its bill email came in, with none fitting yet: it waits until this day, then needs a bill. Then needsBill is false. */
  waitingUntil: string | null;
  /** A second email about this payment's original (its id): never sent. Then billId and how are null and needsBill is false. */
  duplicateOf: string | null;
  /** While it needs a bill: the payment it may repeat (its id), matching on amount and days only. */
  maybeDuplicateOf: string | null;
}

export interface PairingResult {
  /** Every payment, by id. */
  payments: Map<string, PaymentPairing>;
  /** The payment that pays each paired bill, by bill id. */
  paidBy: Map<string, string>;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The one value found for a field, or null when there is none or more than one. */
function single(item: BaseItem, field: FieldName): string | null {
  const values = item.picked.values[field] ?? [];
  return values.length === 1 ? values[0]!.trim() || null : null;
}

/** Offsets of the zone names RFC 5322 allows in a Date header, in minutes. */
const ZONES: Record<string, number> = { UT: 0, UTC: 0, GMT: 0, Z: 0, EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420 };

/** The sender's offset from UTC in a Date header ("... -0500" or "... CDT"), in minutes; null when it gives none. */
export function headerOffset(header: string | null): number | null {
  if (!header) return null;
  const text = header.replace(/\([^)]*\)/g, " ").trim();
  const numeric = /(?:^|\s)([+-])(\d{2})(\d{2})$/.exec(text);
  if (numeric) {
    const hours = Number(numeric[2]);
    const minutes = Number(numeric[3]);
    if (hours > 14 || minutes > 59) return null;
    return (numeric[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
  }
  const named = /(?:^|\s)([A-Za-z]{1,3})$/.exec(text);
  const zone = named ? named[1]!.toUpperCase() : "";
  return zone in ZONES ? ZONES[zone]! : null;
}

/**
 * The day an email was sent on, as its sender saw it: the time shifted by the
 * offset in its own Date header, so a bill sent at 8:30 pm in Sioux Falls is
 * that day, not the next (paid dates are printed in the sender's day too). The
 * UTC day when the header gives no offset.
 */
export function senderDay(iso: string, dateHeader: string | null): string {
  const time = Date.parse(iso);
  const offset = headerOffset(dateHeader);
  if (Number.isNaN(time) || offset === null) return isoDay(iso);
  return new Date(time + offset * 60_000).toISOString().slice(0, 10);
}

/** An email as pairing sees it, from what the list has and its Date header as received (null when unknown: then days are UTC days). */
export function pairingEmail(item: BaseItem, dateHeader: string | null = null): PairingEmail {
  const parsed = Date.parse(item.date ?? item.capturedAt);
  const emailTime = Number.isNaN(parsed) ? (item.date ?? item.capturedAt) : new Date(parsed).toISOString();
  // Only the email's own date has the sender's offset; a capture time is ours.
  const emailDay = item.date ? senderDay(emailTime, dateHeader) : isoDay(emailTime);
  const amountText = single(item, "amount");
  const amount = amountText === null ? Number.NaN : Number(amountText);
  const feeText = single(item, "fee");
  const fee = feeText === null ? Number.NaN : Number(feeText);
  const paid = single(item, "paidDate");
  const due = item.picked.dueNow ? emailDay : single(item, "dueDate");
  return {
    id: item.id,
    kind: item.picked.kind,
    billerId: item.biller?.id ?? null,
    billerName: item.biller?.name ?? null,
    names: plainWords(`${item.subject ?? ""} ${item.from[0]?.name ?? ""}`),
    amountCents: Number.isFinite(amount) ? Math.round(amount * 100) : null,
    feeCents: Number.isFinite(fee) && fee >= 0 ? Math.round(fee * 100) : null,
    invoiceNo: numberKey(single(item, "invoiceNo")),
    accountNo: numberKey(single(item, "accountNo")),
    notBill: item.review?.state === "not-bill",
    emailTime,
    emailDay,
    paidDay: paid && DAY.test(paid) ? paid : null,
    dueDay: due && DAY.test(due) ? due : null,
  };
}

/** An invoice or account number to compare: letters and digits only, upper case ("7345698-1762-4" is "734569817624"); null when nothing is left. */
export function numberKey(text: string | null): string | null {
  const key = text?.toUpperCase().replace(/[^\p{L}\p{N}]/gu, "") ?? "";
  return key === "" ? null : key;
}

/** How much of a biller's name a payment service's receipt must show: PayPal cuts "Waste Management National Services" to "Waste Management Nat...". */
export const NAME_KEY = 12;

/** Lower case, with runs of spaces (non-breaking ones too) made one space. */
function plainWords(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Whether `names` (a subject and From name, as PairingEmail keeps them) names the biller: its first NAME_KEY characters, from the start of a word. */
export function namesBiller(names: string, billerName: string | null): boolean {
  const key = billerName ? plainWords(billerName).slice(0, NAME_KEY).trim() : "";
  if (key === "") return false;
  let at = names.indexOf(key);
  while (at !== -1) {
    if (at === 0 || !/[\p{L}\p{N}]/u.test(names[at - 1]!)) return true;
    at = names.indexOf(key, at + 1);
  }
  return false;
}

/** The day `days` after `day` ("2026-10-06"). */
function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days between two days ("2026-10-06"), either way round. */
function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/** A receipt with an amount that is not a credit, not marked Not a bill. */
export function isPayment(email: PairingEmail): boolean {
  return email.kind === "receipt" && !email.notBill && email.amountCents !== null && email.amountCents >= 0;
}

/** A bill that could be paid at all: an amount that is not a credit, not marked Not a bill. */
export function isPayableBill(email: PairingEmail): boolean {
  return email.kind === "bill" && !email.notBill && email.amountCents !== null && email.amountCents >= 0;
}

/** OurHome's fee band: at least the bill, at most the bill plus the larger of 6.00 or 4% of it. */
export function fitsFeeBand(paymentCents: number, billCents: number): boolean {
  if (paymentCents < billCents) return false;
  // 100 * (payment - bill) <= max(100 * 600, 4 * bill), all whole numbers.
  return 100 * (paymentCents - billCents) <= Math.max(100 * FEE_FLOOR_CENTS, FEE_PERCENT * billCents);
}

/** Whether a payment fits a bill of `billCents`: exactly, less the fee its email states; else within the fee band. */
export function paymentFits(payment: PairingEmail, billCents: number): boolean {
  if (payment.amountCents === null) return false;
  if (payment.feeCents !== null) return payment.amountCents - payment.feeCents === billCents;
  return fitsFeeBand(payment.amountCents, billCents);
}

/** The payment's day: its paid date, else its email date. */
export function paymentDay(email: PairingEmail): string {
  return email.paidDay ?? email.emailDay;
}

const byAge = (a: PairingEmail, b: PairingEmail) => a.emailTime.localeCompare(b.emailTime) || a.id.localeCompare(b.id);

/** Whether a payment on `day` paying `bill` was late, judged against the household's emails. */
function wasLate(bill: PairingEmail, day: string, emails: readonly PairingEmail[]): boolean {
  if (bill.dueDay !== null && day > bill.dueDay) return true;
  if (bill.billerId === null) return false;
  return emails.some(
    (other) =>
      other.id !== bill.id &&
      other.kind === "bill" &&
      other.billerId === bill.billerId &&
      (other.amountCents ?? 0) > 0 &&
      !other.notBill &&
      other.emailDay > bill.emailDay &&
      other.emailDay <= day,
  );
}

export function pairPayments(input: PairingInput): PairingResult {
  const { emails, fixed, reported, startDate, today } = input;
  const byId = new Map(emails.map((email) => [email.id, email]));
  const payments = emails.filter(isPayment);
  const result: PairingResult = { payments: new Map(), paidBy: new Map() };

  /**
   * Records what a payment pays: `bills` (none for Paid on its own or while it
   * needs a bill), oldest first. The oldest is its bill; the others are what
   * it also pays (contract v3). The fee is the one the payment email states;
   * when it states none, the payment less all the bills when more. It belongs
   * to the oldest; each bill gets its amount, oldest first, and the last
   * whatever is left (a person's part payment, or an overpayment the biller
   * carries as a credit: it stays on this bill, never a fee and never the next
   * bill's, owner 2026-11-05).
   */
  const settle = (payment: PairingEmail, bills: readonly PairingEmail[], how: PairingHow | null, locked: boolean, billMissing = false, staleChoice = false) => {
    const pay = payment.amountCents!;
    const ordered = [...bills].sort(byAge);
    const day = paymentDay(payment);
    const total = ordered.reduce((sum, bill) => sum + (bill.amountCents ?? 0), 0);
    // A bill whose amount is not known (on a locked pairing) leaves a fee the email does not state unknown: 0, as before.
    const known = ordered.every((bill) => bill.amountCents !== null);
    const feeCents =
      ordered.length === 0 ? 0 : payment.feeCents !== null ? Math.min(payment.feeCents, pay) : known && pay > total ? pay - total : 0;
    let left = pay - feeCents;
    const shares = ordered.map((bill, i) => {
      const share = i === ordered.length - 1 ? left : Math.min(Math.max(bill.amountCents ?? 0, 0), left);
      left -= share;
      return share;
    });
    for (const bill of ordered) result.paidBy.set(bill.id, payment.id);
    const main = ordered[0];
    result.payments.set(payment.id, {
      paymentId: payment.id,
      billId: main?.id ?? (billMissing ? fixed.get(payment.id)!.billId : null),
      how,
      locked,
      needsBill: how === null,
      paidLate: main ? wasLate(main, day, emails) : false,
      feeCents,
      baseCents: main ? shares[0]! : pay,
      also: ordered.slice(1).map((bill, i) => ({ billId: bill.id, cents: shares[i + 1]!, paidLate: wasLate(bill, day, emails) })),
      billMissing,
      beforeStart: startDate !== null && ordered.some((bill) => bill.emailDay < startDate),
      staleChoice,
      waitingUntil: null,
      duplicateOf: null,
      maybeDuplicateOf: null,
    });
  };

  // Fixed first. Pairings locked on sending come before everything: they never change.
  for (const payment of payments) {
    const choice = fixed.get(payment.id);
    if (!choice?.locked) continue;
    if (choice.billId === null) {
      settle(payment, [], "own", true);
      continue;
    }
    const how: PairingHow = choice.person ? "person" : "auto";
    const chosen = [choice.billId, ...choice.alsoBillIds].map((id) => byId.get(id));
    if (chosen.every((bill) => bill !== undefined)) settle(payment, chosen as PairingEmail[], how, true);
    else settle(payment, [], how, true, true);
  }
  // Then a person's choices, earliest first, each kept only while every bill in it can still be paid
  // and is not taken already; otherwise the payment needs a bill again (the choice is ignored, not removed).
  const picked = payments
    .filter((payment) => fixed.get(payment.id)?.locked === false)
    .sort((a, b) => fixed.get(a.id)!.chosenAt.localeCompare(fixed.get(b.id)!.chosenAt) || a.id.localeCompare(b.id));
  for (const payment of picked) {
    const choice = fixed.get(payment.id)!;
    if (choice.billId === null) {
      settle(payment, [], "own", false);
      continue;
    }
    const chosen = [choice.billId, ...choice.alsoBillIds].map((id) => byId.get(id));
    const usable = (bill: PairingEmail | undefined): bill is PairingEmail =>
      bill !== undefined && isPayableBill(bill) && !reported.has(bill.id) && !result.paidBy.has(bill.id);
    if (chosen.every(usable)) settle(payment, chosen, "person", false);
    else settle(payment, [], null, false, false, true);
  }

  // Then the automatic pairing, in payment date order.
  const open = () =>
    payments.filter((payment) => !result.payments.has(payment.id)).sort((a, b) => paymentDay(a).localeCompare(paymentDay(b)) || byAge(a, b));
  const bills = emails.filter(isPayableBill).sort(byAge);
  /** A bill dated on or before the payment's day. */
  const before = (payment: PairingEmail, bill: PairingEmail) => bill.emailDay <= paymentDay(payment);
  /** A bill that came in after the payment, at most BILL_WAIT_DAYS later. */
  const after = (payment: PairingEmail, bill: PairingEmail) =>
    bill.emailDay > paymentDay(payment) && bill.emailDay <= addDays(paymentDay(payment), BILL_WAIT_DAYS);
  /** An unpaid bill of the payment's biller that asks for money, dated as `when` says: one it could pay. */
  const unpaid = (payment: PairingEmail, bill: PairingEmail, when: typeof before) =>
    payment.billerId !== null &&
    bill.billerId === payment.billerId &&
    bill.amountCents! > 0 &&
    when(payment, bill) &&
    !result.paidBy.has(bill.id) &&
    !reported.has(bill.id);
  const candidate = (payment: PairingEmail, bill: PairingEmail, when: typeof before) => unpaid(payment, bill, when) && paymentFits(payment, bill.amountCents!);
  /** The unpaid bills a payment could pay together: its biller's, before it or within its days after, oldest first. */
  const waitingFor = (payment: PairingEmail) => bills.filter((bill) => unpaid(payment, bill, before) || unpaid(payment, bill, after));
  /**
   * The runs that end at the unpaid bill `last` and together fit the payment, shortest first: `last` with the
   * biller's bill right before it, then the one before that, up to AUTO_BILLS_MAX bills. The walk back stops
   * at the first bill that is not still unpaid (paid by another payment, reported by OurHome, or asking for
   * nothing): what is left of the payment only goes to the bill right before, never past a paid one to an
   * older bill (owner, 2026-11-05).
   */
  const runsEndingAt = (payment: PairingEmail, last: PairingEmail) => {
    const own = bills.filter((bill) => bill.billerId === payment.billerId && (before(payment, bill) || after(payment, bill)));
    const runs: PairingEmail[][] = [];
    const run = [last];
    for (let i = own.indexOf(last) - 1; i >= 0 && run.length < AUTO_BILLS_MAX; i--) {
      const bill = own[i]!;
      if (!unpaid(payment, bill, before)) break;
      run.unshift(bill);
      if (paymentFits(payment, run.reduce((sum, one) => sum + one.amountCents!, 0))) runs.push([...run]);
    }
    return runs;
  };
  // First, a payment that names a bill's invoice number takes that bill (the city's receipts do), so an
  // older unpaid bill of the same amount is not paid by mistake (owner, 2026-11-05). When that bill alone
  // is less than the payment, it is the current invoice paid with what was past due: it takes the named
  // bill with the unpaid bills right before it, when together they fit (owner, 2026-11-05).
  for (const payment of open()) {
    if (payment.invoiceNo === null) continue;
    const named = bills.find((bill) => bill.invoiceNo === payment.invoiceNo && unpaid(payment, bill, before));
    if (!named) continue;
    const pays = paymentFits(payment, named.amountCents!) ? [named] : runsEndingAt(payment, named)[0];
    if (pays) settle(payment, pays, "auto", false);
  }
  // Then per biller, each of the rest takes the oldest fitting candidate.
  for (const payment of open()) {
    const bill = bills.find((bill) => candidate(payment, bill, before));
    if (bill) settle(payment, [bill], "auto", false);
  }
  // Then a payment made before its bill email came in takes the first fitting bill after it (the one
  // naming its invoice number first). Only after every payment has had the bills before it, so a late
  // payment whose bill email is missing never takes the bill another payment pays (owner, 2026-11-05).
  for (const payment of open()) {
    const later = bills.filter((bill) => candidate(payment, bill, after));
    const bill = later.find((bill) => payment.invoiceNo !== null && bill.invoiceNo === payment.invoiceNo) ?? later[0];
    if (bill) settle(payment, [bill], "auto", false);
  }
  // Then one payment for several bills (owner, 2026-11-05): when no one bill fits, 2 then up to
  // AUTO_BILLS_MAX of the biller's bills in a row, all unpaid (before the payment, or within its days
  // after), that together fit it. Only bills in a row, never a pick of any few, so bills that happen to
  // add up are not taken. A payment is most often the current invoice with what was past due on it (owner,
  // 2026-11-05), so the run ends at the newest bill it can: the one naming its invoice number, then the
  // newest bill before it and back from there, then the bills after it. So an old bill whose payment
  // email is missing is not taken in place of the current one.
  for (const payment of open()) {
    const waiting = waitingFor(payment);
    const lastFirst = [
      ...waiting.filter((bill) => payment.invoiceNo !== null && bill.invoiceNo === payment.invoiceNo),
      ...waiting.filter((bill) => before(payment, bill)).reverse(),
      ...waiting.filter((bill) => after(payment, bill)),
    ];
    for (const last of lastFirst) {
      const run = runsEndingAt(payment, last)[0];
      if (run) {
        settle(payment, run, "auto", false);
        break;
      }
    }
  }
  // The rest need a bill; one with a biller, still within its days, waits for its bill email instead.
  for (const payment of open()) {
    settle(payment, [], null, false);
    const until = addDays(paymentDay(payment), BILL_WAIT_DAYS);
    if (payment.billerId !== null && today <= until) result.payments.set(payment.id, { ...result.payments.get(payment.id)!, needsBill: false, waitingUntil: until });
  }

  markDuplicates(payments, fixed, result);
  return result;
}

/** Last: payments that still need a bill and that nobody chose one for, checked for repeating another payment (see the top). */
function markDuplicates(payments: readonly PairingEmail[], fixed: ReadonlyMap<string, FixedPairing>, result: PairingResult): void {
  const pairingOf = (email: PairingEmail) => result.payments.get(email.id)!;
  const hasBill = (email: PairingEmail) => !pairingOf(email).needsBill;
  const waiting = payments.filter((payment) => pairingOf(payment).needsBill && !fixed.has(payment.id)).sort(byAge);
  for (const payment of waiting) {
    const day = paymentDay(payment);
    const near = payments.filter(
      (other) =>
        other.id !== payment.id &&
        other.billerId !== null &&
        pairingOf(other).duplicateOf === null &&
        other.amountCents === payment.amountCents &&
        daysApart(paymentDay(other), day) <= DUPLICATE_DAYS,
    );
    const best = (a: PairingEmail, b: PairingEmail) =>
      Number(hasBill(b)) - Number(hasBill(a)) || daysApart(paymentDay(a), day) - daysApart(paymentDay(b), day) || byAge(a, b);
    const original = near
      .filter((other) =>
        payment.billerId !== null
          ? other.billerId === payment.billerId && (hasBill(other) || byAge(other, payment) < 0)
          : namesBiller(payment.names, other.billerName),
      )
      .sort(best)[0];
    if (original) {
      result.payments.set(payment.id, { ...pairingOf(payment), needsBill: false, duplicateOf: original.id });
      continue;
    }
    // A payment service's receipt that does not name the biller (a debit card purchase, say): only a maybe.
    const maybe = payment.billerId === null ? near.sort(best)[0] : undefined;
    if (maybe) result.payments.set(payment.id, { ...pairingOf(payment), maybeDuplicateOf: maybe.id });
  }
}
