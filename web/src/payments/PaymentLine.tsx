// Pairing on an email's page (the vault's "Hand-off" note, section 7). On a
// payment: "Pays the Oct 6 bill", "Paid late" when so, or "Needs a bill", and
// Choose a bill (the picker, BillPicker.tsx) until it has been sent to
// OurHome. On a bill: "Paid by the Oct 28 payment", or what OurHome reported a
// person did to it there. PaymentSummary is the plain version for the email's
// view on its own (no links, no buttons); PaymentEditor is the page's.

import { CircleCheck, Clock, Link2, Lock } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { CaptureDetailResponse } from "../../../src/shared/api";
import type { BillSide, PaymentInfo, PaymentSide } from "../../../src/shared/payments";
import { capturePagePath } from "../api";
import { Button } from "../components/ui";
import { BillPicker } from "./BillPicker";
import { formatShortDate, howLine } from "./paymentText";

/** Shows another email: a link on the page, plain words in the view on its own. */
type EmailRef = (id: string, text: string, label: string) => ReactNode;

const plainRef: EmailRef = (_id, text) => text;

const linkRef: EmailRef = (id, text, label) => (
  <Link to={capturePagePath(id)} aria-label={label} className="font-medium text-accent hover:underline">
    {text}
  </Link>
);

function PaymentLines({ payment, emailRef }: { payment: PaymentSide; emailRef: EmailRef }) {
  if (payment.needsBill) {
    return (
      <>
        <span className="flex items-center gap-1.5 font-medium text-warn">
          <Clock aria-hidden className="size-4 shrink-0" />
          Needs a bill
        </span>
        <span className="block text-sm text-muted">
          {payment.staleChoice
            ? "The bill chosen for this payment can no longer be used. Choose another."
            : "No bill email fits this payment. Choose its bill, or mark it Paid on its own."}
        </span>
      </>
    );
  }
  if (payment.how === "own") {
    return (
      <>
        <span className="flex items-center gap-1.5 font-medium">
          <CircleCheck aria-hidden className="size-4 shrink-0 text-accent" />
          Paid on its own
        </span>
        <span className="block text-sm text-muted">It goes to OurHome with no bill, as a bill that is already paid.</span>
      </>
    );
  }
  if (!payment.bill) {
    return (
      <>
        <span className="flex items-center gap-1.5 font-medium text-warn">
          <Clock aria-hidden className="size-4 shrink-0" />
          Its bill's email can no longer be read
        </span>
        <span className="block text-sm text-muted">Its mailbox may have been removed.</span>
      </>
    );
  }
  const day = formatShortDate(payment.bill.date);
  const how = howLine(payment);
  return (
    <>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <Link2 aria-hidden className="size-4 shrink-0 text-accent" />
          <span>Pays {emailRef(payment.bill.id, `the ${day} bill`, `Open the ${day} bill`)}</span>
        </span>
        {payment.paidLate ? <span className="rounded border border-warn-line bg-warn-soft px-1.5 text-xs font-medium text-warn">Paid late</span> : null}
      </span>
      {how ? <span className="block text-sm text-muted">{how}</span> : null}
    </>
  );
}

function BillLines({ bill, emailRef }: { bill: BillSide; emailRef: EmailRef }) {
  const lines: ReactNode[] = [];
  if (bill.paidBy) {
    const day = formatShortDate(bill.paidBy.date);
    lines.push(
      <span key="paid" className="flex items-center gap-1.5 font-medium">
        <CircleCheck aria-hidden className="size-4 shrink-0 text-accent" />
        <span>Paid by {emailRef(bill.paidBy.id, `the ${day} payment`, `Open the ${day} payment`)}</span>
      </span>,
    );
  }
  if (bill.ourhome) {
    const text = bill.ourhome.change === "paid" ? "Paid in OurHome by hand" : "Removed in OurHome";
    lines.push(
      <span key="ourhome" className={bill.paidBy ? "block text-sm text-muted" : "block font-medium"}>
        {text} on {formatShortDate(bill.ourhome.at)}.
      </span>,
    );
  }
  if (lines.length === 0) return <span className="text-muted">No payment email for it yet</span>;
  return <>{lines}</>;
}

/** The plain line, for the email's view on its own. */
export function PaymentSummary({ payment }: { payment: PaymentInfo }) {
  return payment.role === "payment" ? <PaymentLines payment={payment} emailRef={plainRef} /> : <BillLines bill={payment} emailRef={plainRef} />;
}

/** On the email's page: links to the other email, and Choose a bill on a payment that has not been sent to OurHome. */
export function PaymentEditor({ detail }: { detail: CaptureDetailResponse & { payment: PaymentInfo } }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const opener = useRef<HTMLDivElement>(null);
  const close = useCallback((said: string | null) => {
    setOpen(false);
    if (said) setMessage(said);
    // Back to the button that opened it, so the keyboard carries on from there.
    opener.current?.querySelector("button")?.focus();
  }, []);
  const { payment } = detail;

  if (payment.role === "bill") return <BillLines bill={payment} emailRef={linkRef} />;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div>
        <PaymentLines payment={payment} emailRef={linkRef} />
      </div>
      {payment.locked ? (
        <span className="flex items-center gap-1.5 text-sm text-muted">
          <Lock aria-hidden className="size-4 shrink-0" />
          Sent to OurHome; change it there.
        </span>
      ) : (
        <div ref={opener}>
          <Button
            variant="secondary"
            className="px-3 py-1"
            onClick={() => {
              setMessage("");
              setOpen(true);
            }}
          >
            Choose a bill
          </Button>
        </div>
      )}
      {/* Always there, so a screen reader hears what was saved. */}
      <p role="status" className={message ? "text-sm text-muted" : "sr-only"}>
        {message}
      </p>
      {open ? <BillPicker paymentId={detail.id} biller={detail.biller?.name ?? null} onClose={close} /> : null}
    </div>
  );
}
