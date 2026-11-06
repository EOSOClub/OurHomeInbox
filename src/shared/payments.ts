// Payment pairing (the vault's "Hand-off" note, section 7; owner, 2026-11-01):
// OurHomeInbox decides which bill email each payment email pays, the card
// fee, and whether it was paid late, and tells OurHome through `reference`.
// Types and limits only, so the web app can use them too; the work is in
// src/server/payments/.
//
//   GET /api/captures/:mailbox/:uidValidity/:uid/bill-choices[?all=1]   BillChoicesResponse
//   PUT /api/captures/:mailbox/:uidValidity/:uid/pairing                PairingRequest -> PairingResponse; 409 once locked

/** OurHome's fee band: a payment fits a bill when it is at least the bill and at most the bill plus the larger of these. */
export const FEE_FLOOR_CENTS = 600;
export const FEE_PERCENT = 4;

/**
 * Second emails about one payment (owner, 2026-11-02): a payment that finds no
 * bill repeats another payment of the same amount paid at most this many days
 * apart (the biller's own confirmation and PayPal's receipt for it, say).
 */
export const DUPLICATE_DAYS = 3;

/**
 * A payment made before its bill email came in (owner, 2026-11-05: bills are
 * paid early, often before the email; Waste Management's comes about 5 days
 * after the invoice date) pays the first fitting bill of its biller that
 * arrives at most this many days after it, and until then waits for one.
 * Short of a month, so a payment never takes the next month's bill.
 */
export const BILL_WAIT_DAYS = 14;

/**
 * One payment for several bills (owner, 2026-11-05; contract v3 `alsoPays`):
 * OurHomeInbox tries the oldest 2 or 3 unpaid bills of a biller together when
 * no one bill fits; a person can pick up to MAX_BILLS_PER_PAYMENT (the
 * contract's 5 `alsoPays` entries, plus the bill in `reference`).
 */
export const AUTO_BILLS_MAX = 3;
export const MAX_BILLS_PER_PAYMENT = 6;

/** Another payment email, as a payment's page names it. `date` is that email's own date, else when it was captured. */
export interface PaymentRef {
  id: string;
  date: string;
  biller: string | null;
}

/**
 * How a payment came to pay its bill:
 * - auto: OurHomeInbox chose it (the oldest fitting bill of that biller).
 * - person: someone chose it with Choose a bill.
 * - own: someone chose Paid on its own; it goes with no bill.
 */
export type PairingHow = "auto" | "person" | "own";

/** A payment email's place in pairing, for its page and the list. */
export interface PaymentSide {
  role: "payment";
  /** The bill it pays, or null (Paid on its own, or it needs a bill). `date` is the bill email's own date, else when it was captured. */
  bill: { id: string; date: string; amount: number | null } | null;
  /** The other bills it pays, oldest first, when it pays more than one (`bill` is the oldest); none otherwise. */
  alsoBills: Array<{ id: string; date: string; amount: number | null }>;
  /** Null while it needs a bill. */
  how: PairingHow | null;
  /** Another bill came between its bill and the payment, or it was paid after the bill's due date. */
  paidLate: boolean;
  /** No bill fits it and nobody chose one (or the chosen one can no longer be used): it waits. */
  needsBill: boolean;
  /** Paid before its bill email came in: it waits for a fitting one until this day ("2026-11-19"), then needs a bill. Null otherwise. */
  waitingUntil: string | null;
  /** Someone chose a bill for it that can no longer be used (marked Not a bill, paid or removed in OurHome, or taken by a payment already sent). */
  staleChoice: boolean;
  /** Sent to OurHome: its bill can only be changed in OurHome now. */
  locked: boolean;
  /** A second email about the payment this one reports: it is never sent, so OurHome counts the payment once. */
  duplicateOf: PaymentRef | null;
  /** While it needs a bill: a payment of the same amount a few days apart that it may repeat (a person decides). */
  maybeDuplicateOf: PaymentRef | null;
}

/** A bill email's place in pairing. */
export interface BillSide {
  role: "bill";
  /** The payment email that pays it; `date` is that email's own date, else when it was captured. */
  paidBy: { id: string; date: string } | null;
  /** What OurHome reported a person did to it there, or null. */
  ourhome: { change: OurHomeChangeKind; at: string } | null;
}

export type PaymentInfo = PaymentSide | BillSide;

/** What OurHome reports a person did to an email bill in OurHome (POST /api/handoff/changes). */
export type OurHomeChangeKind = "paid" | "removed";

/**
 * A bill in the picker, as seen from one payment:
 * - unpaid: no payment pays it.
 * - this: this payment pays it now.
 * - paired: another payment pays it.
 * - paid, removed: OurHome reported it paid by hand, or removed.
 * - unusable: its amount is not settled, or it is a credit.
 */
export type BillChoiceState = "unpaid" | "this" | "paired" | "paid" | "removed" | "unusable";

export interface BillChoice {
  /** The bill email, as CaptureListItem.id. */
  id: string;
  /** Its own date, else when it was captured (ISO). */
  date: string;
  amount: number | null;
  state: BillChoiceState;
  canPick: boolean;
  /** Why it cannot be picked, in plain words; null when it can. */
  reason: string | null;
  /** The date of the payment email that pays it (its own date, else when it was captured); null when none does. */
  paidByDate: string | null;
  biller: string | null;
  /** Who sent it: the first From name, else its address. */
  sender: string;
  subject: string | null;
  /** A day, "2026-11-04", or null when not known. */
  dueDate: string | null;
  invoiceNo: string | null;
}

export interface BillChoicesResponse {
  /** The payment's biller, or null when it has none (then every biller's bills are listed). */
  biller: string | null;
  /** True when every biller's bills are listed. */
  all: boolean;
  /** Newest first. */
  bills: BillChoice[];
  /** True once the payment has been sent to OurHome: nothing can be picked. */
  locked: boolean;
  /** The payment's own amount, to add picked bills up against; null when it has none settled. */
  paymentAmount: number | null;
}

/**
 * Choosing a payment's bill:
 * - bill: this bill (a person's pick).
 * - bills: these bills, 1 to MAX_BILLS_PER_PAYMENT (one payment for several).
 * - own: Paid on its own (goes with no bill).
 * - auto: Let OurHomeInbox choose (clears the person's choice).
 */
export type PairingRequest = { choice: "bill"; billId: string } | { choice: "bills"; billIds: string[] } | { choice: "own" } | { choice: "auto" };

export interface PairingResponse {
  payment: PaymentInfo | null;
}
