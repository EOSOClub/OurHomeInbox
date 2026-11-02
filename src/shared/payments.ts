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
  /** Null while it needs a bill. */
  how: PairingHow | null;
  /** Another bill came between its bill and the payment, or it was paid after the bill's due date. */
  paidLate: boolean;
  /** No bill fits it and nobody chose one (or the chosen one can no longer be used): it waits. */
  needsBill: boolean;
  /** Someone chose a bill for it that can no longer be used (marked Not a bill, paid or removed in OurHome, or taken by a payment already sent). */
  staleChoice: boolean;
  /** Sent to OurHome: its bill can only be changed in OurHome now. */
  locked: boolean;
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
}

/**
 * Choosing a payment's bill:
 * - bill: this bill (a person's pick).
 * - own: Paid on its own (goes with no bill).
 * - auto: Let OurHomeInbox choose (clears the person's choice).
 */
export type PairingRequest = { choice: "bill"; billId: string } | { choice: "own" } | { choice: "auto" };

export interface PairingResponse {
  payment: PaymentInfo | null;
}
