// Choose its payment (owner, 2026-11-07): from a bill's page, a popup listing
// the payment emails that could pay it, newest first, its biller's or (with
// the switch) every biller's. Selecting one shows it (sender, subject, dates,
// amount, and what it pays now, with a link to open the email in a new tab)
// before Pick this payment. Picking saves a person's pick on that payment,
// just as Choose a bill on it would: it then pays this bill only. While the
// bill is unpaid or paid only in part, the payment is added to what pays it;
// while other payments pay it in full, it takes their place. Payments sent to
// OurHome are shown but cannot be picked. Escape closes it without a change.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { PaymentChoice, PaymentChoicesResponse } from "../../../src/shared/payments";
import { api, capturePagePath } from "../api";
import { Button, DetailRow, ErrorState, LoadingState, Notice } from "../components/ui";
import { formatDateTime, subjectDisplay } from "../format";
import { formatDay, formatMoney } from "../mail/picked";
import { refreshAfterPairing, usePaymentChoices } from "../queries";
import { formatShortDate } from "./paymentText";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function amountText(payment: PaymentChoice): string {
  return payment.amount === null ? "No amount" : formatMoney(String(payment.amount));
}

/** "the Oct 6 bill", "the Aug 6 and Sep 8 bills". */
function billsText(pays: PaymentChoice["pays"]): string {
  const days = pays.map((bill) => formatShortDate(bill.date));
  return days.length === 1 ? `the ${days[0]} bill` : `the ${days.slice(0, -1).join(", ")} and ${days[days.length - 1]} bills`;
}

/** What a payment's state says in the list. */
function stateText(payment: PaymentChoice): string {
  switch (payment.state) {
    case "this":
      return "Pays this bill";
    case "other":
      return `Pays ${billsText(payment.pays)}`;
    case "own":
      return "Paid on its own";
    case "duplicate":
      return "A second email about another payment";
    case "locked":
      return payment.pays.length > 0 ? `Sent to OurHome, pays ${billsText(payment.pays)}` : "Sent to OurHome";
    default:
      return "No bill yet";
  }
}

/** What picking it does, in plain words, for the preview. `payers` is how many payments pay the bill now. */
function effectText(payment: PaymentChoice, mode: PaymentChoicesResponse["mode"], payers: number): string {
  const move =
    payment.state === "other"
      ? `It pays ${billsText(payment.pays)} now: picking it moves it to this bill only. `
      : payment.state === "own"
        ? "It is marked Paid on its own now: picking it makes it pay this bill. "
        : payment.state === "duplicate"
          ? "It is taken as a second email about another payment now: picking it makes it a payment of its own. "
          : "";
  const together =
    mode === "add"
      ? "It is added to what pays this bill."
      : payers > 1
        ? `It takes the place of the ${payers} payments that pay this bill now.`
        : "It takes the place of the payment that pays this bill now.";
  return move + together;
}

/** One payment in the list: a button that selects it, or a disabled one saying why it cannot be picked. */
function PaymentRow({ payment, all, selected, onSelect }: { payment: PaymentChoice; all: boolean; selected: boolean; onSelect: () => void }) {
  const day = formatShortDate(payment.date);
  const state = stateText(payment);
  // Named in full: words in separate spans can lose their spaces in the accessible name.
  const label = [`${day} payment`, amountText(payment), state, all && payment.biller ? payment.biller : null, payment.reason].filter(Boolean).join(", ");
  return (
    <li>
      <button
        type="button"
        disabled={!payment.canPick}
        aria-pressed={selected}
        aria-label={label}
        onClick={onSelect}
        className={
          "w-full rounded-md border px-3 py-2 text-left disabled:cursor-not-allowed " +
          (selected ? "border-accent bg-accent-soft" : "border-line bg-surface hover:bg-surface-muted disabled:hover:bg-surface")
        }
      >
        <span className="flex items-baseline justify-between gap-3">
          <span className={"font-medium" + (payment.canPick ? "" : " text-muted")}>{day}</span>
          <span className={"shrink-0" + (payment.canPick ? " font-medium" : " text-muted")}>{amountText(payment)}</span>
        </span>
        <span className="block text-sm text-muted wrap-anywhere">
          {state}
          {all && payment.biller ? `, ${payment.biller}` : ""}
        </span>
      </button>
    </li>
  );
}

/** The payment selected, to look at before picking. */
function PaymentPreview({
  payment,
  choices,
  busy,
  onPick,
}: {
  payment: PaymentChoice;
  choices: PaymentChoicesResponse;
  busy: boolean;
  onPick: () => void;
}) {
  return (
    <section aria-label="The selected payment" className="mt-3 rounded-md border border-line bg-surface-muted p-3">
      <dl className="divide-y divide-line">
        <DetailRow label="Sender">{payment.sender || <span className="text-muted">Not given</span>}</DetailRow>
        <DetailRow label="Subject">{subjectDisplay(payment.subject)}</DetailRow>
        <DetailRow label="Email date">{formatDateTime(payment.date)}</DetailRow>
        <DetailRow label="Amount">{amountText(payment)}</DetailRow>
        <DetailRow label="Paid on">{payment.paidDate ? formatDay(payment.paidDate) : <span className="text-muted">Not found</span>}</DetailRow>
      </dl>
      <p className="mt-3 text-sm wrap-anywhere">{effectText(payment, choices.mode, choices.payments.filter((one) => one.state === "this").length)}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="primary" className="px-3 py-1.5" busy={busy} onClick={onPick}>
          Pick this payment
        </Button>
        <a
          href={capturePagePath(payment.id)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open the email, in a new tab"
          className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
        >
          <ExternalLink aria-hidden className="size-4" />
          Open the email
        </a>
      </div>
    </section>
  );
}

/**
 * The picker for one bill. `onClose` gets what was saved, in words, or null
 * when it was closed without a change.
 */
export function PaymentPicker({ billId, biller, onClose }: { billId: string; biller: string | null; onClose: (message: string | null) => void }) {
  const queryClient = useQueryClient();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [all, setAll] = useState(biller === null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const choices = usePaymentChoices(billId, all);
  const payments = choices.data?.payments ?? [];
  const selected = payments.find((payment) => payment.id === selectedId && payment.canPick) ?? null;

  const save = useMutation({
    mutationFn: (paymentId: string) => api.setPayer(billId, { paymentId }),
    onSuccess: (_result, paymentId) => {
      refreshAfterPairing(queryClient);
      const picked = payments.find((payment) => payment.id === paymentId);
      onClose(picked ? `Saved: the ${formatShortDate(picked.date)} payment pays this bill.` : "Saved: the chosen payment pays this bill.");
    },
  });

  // Focus starts inside the popup, so a keyboard or screen reader is in it at once.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** Tab stays inside the popup while it is open. */
  function keepFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const whose = all ? "Every biller's payment emails" : `${biller}'s payment emails`;

  // Into the page's body, so no sticky bar or header it is opened from can sit over it.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={keepFocus}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-lg min-w-0 flex-col rounded-lg border border-line bg-surface shadow-lg outline-none"
      >
        <div className="border-b border-line p-4">
          <div className="flex items-start justify-between gap-3">
            <h2 id={titleId} className="text-lg font-semibold">
              Choose its payment
            </h2>
            <Button variant="quiet" className="-mt-1 -mr-2 px-2 py-1" aria-label="Close" onClick={() => onClose(null)}>
              <X aria-hidden className="size-4" />
            </Button>
          </div>
          <p className="mt-1 text-sm text-muted">{whose}, newest first. Select one to see it before you pick it.</p>
          {biller !== null ? (
            <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                role="switch"
                checked={all}
                onChange={(e) => {
                  setAll(e.target.checked);
                  setSelectedId(null);
                }}
                className="size-4 accent-accent"
              />
              Show every biller's payment emails
            </label>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {choices.isPending ? <LoadingState label="Loading the payments" /> : null}
          {choices.isError ? <ErrorState error={choices.error} onRetry={() => void choices.refetch()} /> : null}
          {choices.data?.blocked ? (
            <div className="mb-3">
              <Notice tone="warning">{choices.data.blocked}</Notice>
            </div>
          ) : null}
          {choices.data && payments.length === 0 ? (
            <p className="text-muted">{all ? "There are no payment emails yet." : `There are no payment emails from ${biller} yet. Try every biller's payment emails.`}</p>
          ) : null}
          {payments.length > 0 ? (
            <ul aria-label="Payments" className="flex flex-col gap-2">
              {payments.map((payment) => (
                <PaymentRow
                  key={payment.id}
                  payment={payment}
                  all={all}
                  selected={payment.id === selected?.id}
                  onSelect={() => setSelectedId((id) => (id === payment.id ? null : payment.id))}
                />
              ))}
            </ul>
          ) : null}
          {selected && choices.data ? (
            <PaymentPreview payment={selected} choices={choices.data} busy={save.isPending} onPick={() => save.mutate(selected.id)} />
          ) : null}
        </div>

        <div className="flex flex-col gap-3 border-t border-line p-4">
          {save.isError ? (
            <Notice tone="error" live>
              Could not save that: {save.error.message}
            </Notice>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="quiet" className="px-3 py-1.5" onClick={() => onClose(null)}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
