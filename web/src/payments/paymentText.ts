// Pairing as the pages word it (the vault's "Hand-off" note, section 7): the
// short date in "Pays the Oct 6 bill", what each bill state in the picker is
// called, and whether an email is a payment that needs a bill.

import type { CaptureListItem } from "../../../src/shared/api";
import type { BillChoiceState, PaymentInfo } from "../../../src/shared/payments";
import type { DateOptions } from "../format";

/** True for a payment that no bill fits and nobody chose a bill for: it waits for a person. */
export function needsBill(item: Pick<CaptureListItem, "payment">): boolean {
  return item.payment?.role === "payment" && item.payment.needsBill;
}

/** "Oct 6" this year, "Oct 6, 2025" before or after it: the day in "Pays the Oct 6 bill". */
export function formatShortDate(iso: string, now: Date = new Date(), options: DateOptions = {}): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const { locale, timeZone } = options;
  const year = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric" }).format(d);
  const sameYear = year(date) === year(now);
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone }).format(date);
}

/** What each state is called in the picker. */
export const BILL_STATE_LABELS: Record<BillChoiceState, string> = {
  unpaid: "Unpaid",
  this: "Paid by this payment",
  paired: "Paid by another payment",
  paid: "Paid in OurHome",
  removed: "Removed in OurHome",
  unusable: "Cannot be picked",
};

/** How a payment's bill was chosen, in a few words. */
export function howLine(payment: Extract<PaymentInfo, { role: "payment" }>): string | null {
  if (payment.how === "person") return "Chosen by someone in the household.";
  if (payment.how === "auto" && payment.alsoBills.length > 0) return "Chosen by OurHomeInbox: the oldest unpaid bills of this biller, which together fit the amount.";
  if (payment.how === "auto") return "Chosen by OurHomeInbox: the oldest unpaid bill of this biller that fits the amount.";
  return null;
}
