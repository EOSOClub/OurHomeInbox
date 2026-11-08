// Right after a Fix is saved on a payment or bill email (owner, 2026-11-07):
// pairing is worked out again on the read that follows, so this says at once
// what it found, there by the Fix, and offers the next step: Change its bill
// (or payment) when it matched one, Choose a bill (or its payment) when it did
// not. The pickers are the same as on the email's Payment row. Nothing is
// shown for an email that is neither a payment nor a bill.

import { useState } from "react";
import type { BillSide, PaymentSide } from "../../../src/shared/payments";
import { Button } from "../components/ui";
import { formatMoney } from "../mail/picked";
import { useCapture } from "../queries";
import { BillPicker } from "./BillPicker";
import { PaymentPicker } from "./PaymentPicker";
import { formatShortDate } from "./paymentText";

/** "the Oct 6 bill", "the Aug 6 and Sep 8 bills"; "payment" or "payments" the same way. */
function daysText(dates: readonly string[], noun: "bill" | "payment"): string {
  const days = dates.map((date) => formatShortDate(date));
  if (days.length === 1) return `the ${days[0]} ${noun}`;
  return `the ${days.slice(0, -1).join(", ")} and ${days[days.length - 1]} ${noun}s`;
}

/** What pairing found for a payment, and the button it offers (null for none). */
function paymentResult(payment: PaymentSide): { text: string; button: string | null } {
  if (payment.locked) return { text: "This payment has been sent to OurHome, so its bill can only be changed there.", button: null };
  if (payment.duplicateOf) {
    return { text: `It is taken as a second email about the ${formatShortDate(payment.duplicateOf.date)} payment, so it is not sent to OurHome.`, button: "Choose a bill" };
  }
  if (payment.how === "own") return { text: "It is marked Paid on its own.", button: "Choose a bill" };
  if (payment.waitingUntil) {
    return { text: `No bill email fits it yet. It waits for one until ${formatShortDate(`${payment.waitingUntil}T12:00:00Z`)}.`, button: "Choose a bill" };
  }
  if (payment.needsBill || !payment.bill) return { text: "No bill email fits it. Choose its bill, or mark it Paid on its own.", button: "Choose a bill" };
  const bills = daysText([payment.bill, ...payment.alsoBills].map((bill) => bill.date), "bill");
  const who = payment.how === "person" ? `It pays ${bills}, as chosen in your household.` : `OurHomeInbox matched it to ${bills}.`;
  const part = payment.part ? ` That pays only part of it: ${formatMoney(payment.part.owed.toFixed(2))} is still owed.` : "";
  return { text: who + part, button: "Change its bill" };
}

/** What pairing found for a bill, and the button it offers (null for none). */
function billResult(bill: BillSide): { text: string; button: string | null } {
  if (bill.ourhome) return { text: bill.ourhome.change === "paid" ? "OurHome says it was paid there by hand." : "It was removed in OurHome.", button: null };
  if (!bill.paidBy) return { text: "No payment email fits it yet.", button: "Choose its payment" };
  const payments = daysText([bill.paidBy, ...bill.alsoPaidBy].map((payer) => payer.date), "payment");
  if (bill.part) {
    return { text: `It is partly paid by ${payments}: ${formatMoney(bill.part.owed.toFixed(2))} is still owed.`, button: "Choose its payment" };
  }
  return { text: `It is paid by ${payments}.`, button: "Change its payment" };
}

/** `savedAt` is when the Fix was saved (ms): until the email has been read again since, it is still looking. */
export function MatchAfterFix({ captureId, savedAt }: { captureId: string; savedAt: number }) {
  const capture = useCapture(captureId);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  // Only the read after the Fix: a later refresh in the background keeps showing what was found.
  if (capture.dataUpdatedAt < savedAt && !capture.isError) {
    return (
      <p role="status" className="text-sm text-muted">
        Looking again for what it pairs with...
      </p>
    );
  }
  const info = capture.data?.payment;
  if (!info) return null;
  const { text, button } = info.role === "payment" ? paymentResult(info) : billResult(info);
  const biller = capture.data?.biller?.name ?? null;
  const close = (said: string | null) => {
    setOpen(false);
    if (said) setMessage(said);
  };
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-muted p-3">
      <p className="text-sm font-medium" role="status">
        {text}
      </p>
      {button ? (
        <div>
          <Button variant="secondary" className="px-3 py-1" onClick={() => setOpen(true)}>
            {button}
          </Button>
        </div>
      ) : null}
      {message ? <p className="text-sm text-muted">{message}</p> : null}
      {open && info.role === "payment" ? <BillPicker paymentId={captureId} biller={biller} onClose={close} /> : null}
      {open && info.role === "bill" ? <PaymentPicker billId={captureId} biller={biller} onClose={close} /> : null}
    </div>
  );
}
