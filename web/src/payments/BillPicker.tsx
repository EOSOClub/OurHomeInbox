// Choose a bill (the vault's "Hand-off" note, section 7): a popup listing the
// bills a payment could pay, newest first, its biller's or (with the switch)
// every biller's. Selecting a bill shows it (sender, subject, dates, amount,
// invoice number and a link to open the email in a new tab) before Pick this
// bill. One payment can pay several bills (owner, 2026-11-05): each row turns
// on and off, the last one selected is shown, and the selected bills are added
// up against the payment before Pick these bills. Also Paid on its own (it goes to OurHome with no bill) and Let
// OurHomeInbox choose (the person's choice goes). Bills another payment pays,
// or that OurHome reported paid or removed, are shown but cannot be picked.
// Escape closes it without changing anything.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { BillChoice, PairingRequest } from "../../../src/shared/payments";
import { api, capturePagePath } from "../api";
import { Button, DetailRow, ErrorState, LoadingState, Notice } from "../components/ui";
import { formatDateTime, subjectDisplay } from "../format";
import { formatDay, formatMoney } from "../mail/picked";
import { refreshAfterPairing, useBillChoices } from "../queries";
import { BILL_STATE_LABELS, formatShortDate } from "./paymentText";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function amountText(bill: BillChoice): string {
  return bill.amount === null ? "No amount" : formatMoney(String(bill.amount));
}

/** One bill in the list: a button that selects it, or a disabled one saying why it cannot be picked. */
function BillRow({ bill, all, selected, onSelect }: { bill: BillChoice; all: boolean; selected: boolean; onSelect: () => void }) {
  const day = formatShortDate(bill.date);
  // Paired with another payment: name that payment, rather than repeat it in a second line.
  const state = bill.state === "paired" && bill.paidByDate ? `Paid by the ${formatShortDate(bill.paidByDate)} payment` : BILL_STATE_LABELS[bill.state];
  // The reason line only where it says more than the state (paid or removed in OurHome, or paired, say no more).
  const extra = bill.state === "paired" || bill.state === "paid" || bill.state === "removed" ? null : bill.reason;
  // Named in full: words in separate spans can lose their spaces in the accessible name.
  const label = [`${day} bill`, amountText(bill), state, all && bill.biller ? bill.biller : null, bill.reason].filter(Boolean).join(", ");
  return (
    <li>
      <button
        type="button"
        disabled={!bill.canPick}
        aria-pressed={selected}
        aria-label={label}
        onClick={onSelect}
        className={
          "w-full rounded-md border px-3 py-2 text-left disabled:cursor-not-allowed " +
          (selected ? "border-accent bg-accent-soft" : "border-line bg-surface hover:bg-surface-muted disabled:hover:bg-surface")
        }
      >
        <span className="flex items-baseline justify-between gap-3">
          <span className={"font-medium" + (bill.canPick ? "" : " text-muted")}>{day}</span>
          <span className={"shrink-0" + (bill.canPick ? " font-medium" : " text-muted")}>{amountText(bill)}</span>
        </span>
        <span className="block text-sm text-muted wrap-anywhere">
          {state}
          {all && bill.biller ? `, ${bill.biller}` : ""}
        </span>
        {extra ? <span className="block text-xs text-muted wrap-anywhere">{extra}</span> : null}
      </button>
    </li>
  );
}

/** What the selected bills come to, against the payment: "2 bills selected: $113.46, the payment is $113.46." */
function totalLine(bills: readonly BillChoice[], paymentAmount: number | null): string {
  const cents = bills.reduce((sum, bill) => sum + Math.round((bill.amount ?? 0) * 100), 0);
  const total = formatMoney((cents / 100).toFixed(2));
  const count = bills.length === 1 ? "1 bill selected" : `${bills.length} bills selected`;
  if (paymentAmount === null) return `${count}: ${total}.`;
  const payment = formatMoney(paymentAmount.toFixed(2));
  const diff = Math.round(paymentAmount * 100) - cents;
  const fit = diff === 0 ? "exactly the payment" : diff > 0 ? `${formatMoney((diff / 100).toFixed(2))} less than the ${payment} payment` : `${formatMoney((-diff / 100).toFixed(2))} more than the ${payment} payment`;
  return `${count}: ${total}, ${fit}.`;
}

/** The last bill selected, to look at before picking, and what all the selected bills come to. */
function BillPreview({ bill, picked, paymentAmount, busy, onPick }: { bill: BillChoice; picked: readonly BillChoice[]; paymentAmount: number | null; busy: boolean; onPick: () => void }) {
  return (
    <section aria-label="The selected bill" className="mt-3 rounded-md border border-line bg-surface-muted p-3">
      <dl className="divide-y divide-line">
        <DetailRow label="Sender">{bill.sender || <span className="text-muted">Not given</span>}</DetailRow>
        <DetailRow label="Subject">{subjectDisplay(bill.subject)}</DetailRow>
        <DetailRow label="Email date">{formatDateTime(bill.date)}</DetailRow>
        <DetailRow label="Amount">{amountText(bill)}</DetailRow>
        <DetailRow label="Due date">{bill.dueDate ? formatDay(bill.dueDate) : <span className="text-muted">Not found</span>}</DetailRow>
        <DetailRow label="Invoice number">{bill.invoiceNo ?? <span className="text-muted">Not found</span>}</DetailRow>
      </dl>
      {picked.length > 1 || paymentAmount !== null ? (
        <p role="status" className="mt-3 text-sm font-medium wrap-anywhere">
          {totalLine(picked, paymentAmount)}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="primary" className="px-3 py-1.5" busy={busy} onClick={onPick}>
          {picked.length === 1 ? "Pick this bill" : `Pick these ${picked.length} bills`}
        </Button>
        <a
          href={capturePagePath(bill.id)}
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
 * The picker for one payment. `onClose` gets what was saved, in words, or
 * null when it was closed without a change.
 */
export function BillPicker({ paymentId, biller, onClose }: { paymentId: string; biller: string | null; onClose: (message: string | null) => void }) {
  const queryClient = useQueryClient();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [all, setAll] = useState(biller === null);
  // In the order they were selected; the last one is shown.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const choices = useBillChoices(paymentId, all);
  const bills = choices.data?.bills ?? [];
  const picked = selectedIds.flatMap((id) => bills.find((bill) => bill.id === id && bill.canPick) ?? []);
  const shown = picked[picked.length - 1] ?? null;
  const toggle = (id: string) => setSelectedIds((ids) => (ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id]));

  const save = useMutation({
    mutationFn: (body: PairingRequest) => api.setPairing(paymentId, body),
    onSuccess: (_result, body) => {
      refreshAfterPairing(queryClient);
      if (body.choice === "own") onClose("Saved: this payment goes to OurHome on its own, with no bill.");
      else if (body.choice === "auto") onClose("Saved: OurHomeInbox chooses this payment's bill.");
      else if (picked.length === 0) onClose("Saved: this payment pays the chosen bill.");
      else {
        // Oldest first, as the payment's page lists them.
        const days = [...picked].sort((a, b) => a.date.localeCompare(b.date)).map((bill) => formatShortDate(bill.date));
        onClose(days.length === 1 ? `Saved: this payment pays the ${days[0]} bill.` : `Saved: this payment pays the ${days.slice(0, -1).join(", ")} and ${days[days.length - 1]} bills.`);
      }
    },
  });
  const pick = () => save.mutate(picked.length === 1 ? { choice: "bill", billId: picked[0]!.id } : { choice: "bills", billIds: picked.map((bill) => bill.id) });

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

  const whose = all ? "Every biller's bills" : `${biller}'s bills`;

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
              Choose its bill
            </h2>
            <Button variant="quiet" className="-mt-1 -mr-2 px-2 py-1" aria-label="Close" onClick={() => onClose(null)}>
              <X aria-hidden className="size-4" />
            </Button>
          </div>
          <p className="mt-1 text-sm text-muted">
            {whose}, newest first. Select one to see it before you pick it. One payment for several bills: select each of them.
          </p>
          {biller !== null ? (
            <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                role="switch"
                checked={all}
                onChange={(e) => {
                  setAll(e.target.checked);
                  setSelectedIds([]);
                }}
                className="size-4 accent-accent"
              />
              Show every biller's bills
            </label>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {choices.isPending ? <LoadingState label="Loading the bills" /> : null}
          {choices.isError ? <ErrorState error={choices.error} onRetry={() => void choices.refetch()} /> : null}
          {choices.data && bills.length === 0 ? (
            <p className="text-muted">{all ? "There are no bill emails yet." : `There are no bill emails from ${biller} yet. Try every biller's bills.`}</p>
          ) : null}
          {bills.length > 0 ? (
            <ul aria-label="Bills" className="flex flex-col gap-2">
              {bills.map((bill) => (
                <BillRow key={bill.id} bill={bill} all={all} selected={picked.some((p) => p.id === bill.id)} onSelect={() => toggle(bill.id)} />
              ))}
            </ul>
          ) : null}
          {shown ? (
            <BillPreview
              bill={shown}
              picked={picked}
              paymentAmount={choices.data?.paymentAmount ?? null}
              busy={save.isPending && (save.variables?.choice === "bill" || save.variables?.choice === "bills")}
              onPick={pick}
            />
          ) : null}
        </div>

        <div className="flex flex-col gap-3 border-t border-line p-4">
          {save.isError ? (
            <Notice tone="error" live>
              Could not save that: {save.error.message}
            </Notice>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" className="px-3 py-1.5" busy={save.isPending && save.variables?.choice === "own"} disabled={save.isPending} onClick={() => save.mutate({ choice: "own" })}>
              Paid on its own
            </Button>
            <Button variant="quiet" className="px-3 py-1.5" busy={save.isPending && save.variables?.choice === "auto"} disabled={save.isPending} onClick={() => save.mutate({ choice: "auto" })}>
              Let OurHomeInbox choose
            </Button>
            <Button variant="quiet" className="px-3 py-1.5" onClick={() => onClose(null)}>
              Cancel
            </Button>
          </div>
          <p className="text-xs text-muted">Paid on its own sends the payment to OurHome with no bill, as a bill that is already paid.</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
