// What the biller pages share: how each kind is described, the add/change
// form's checks (the same rules the server applies), starting a biller from
// an email or adding an email's sender to one, and how a biller's senders are
// summed up in one line.

import type { BillerInput } from "../../src/shared/api";
import {
  MAX_BILLER_NAME,
  MAX_BILLER_NOTES,
  MAX_BILLER_SENDERS,
  normalizeSender,
  parseSenders,
  senderProblem,
  type BillerKind,
} from "../../src/shared/billers";
import type { CapturedAddress } from "../../src/shared/capture";
import type { Choice } from "./components/ui";

export const KIND_LABELS: Record<BillerKind, string> = { bill: "Bill", subscription: "Subscription" };

export const KIND_CHOICES: ReadonlyArray<Choice<BillerKind>> = [
  { value: "bill", label: "Bill", description: "A service to the home, like power, water, internet or phone." },
  { value: "subscription", label: "Subscription", description: "An extra, like streaming, software or a membership." },
];

export interface BillerForm {
  name: string;
  kind: BillerKind | null;
  /** As typed: one per line, or separated by commas. */
  senders: string;
  notes: string;
  fetchInvoices: boolean;
}

export type BillerFormErrors = Partial<Record<keyof BillerForm, string>>;

export const EMPTY_BILLER_FORM: BillerForm = { name: "", kind: null, senders: "", notes: "", fetchInvoices: true };

/** The form's problems, or the request to send when there are none. */
export function checkBillerForm(form: BillerForm): { errors: BillerFormErrors; input: BillerInput | null } {
  const errors: BillerFormErrors = {};
  const name = form.name.trim();
  if (!name) errors.name = "Enter the biller's name.";
  else if (name.length > MAX_BILLER_NAME) errors.name = `Keep the name under ${MAX_BILLER_NAME} characters.`;
  if (form.kind === null) errors.kind = "Choose whether this is a bill or a subscription.";

  const senders = parseSenders(form.senders);
  if (senders.length > MAX_BILLER_SENDERS) {
    errors.senders = `List at most ${MAX_BILLER_SENDERS} email addresses for one biller.`;
  } else {
    const problems = senders.map(senderProblem).filter((p): p is string => p !== null);
    const others = problems.length - 1;
    if (others === 0) errors.senders = problems[0];
    else if (others > 0) errors.senders = `${problems[0]} ${others === 1 ? "One more has" : `${others} more have`} the same problem.`;
  }

  const notes = form.notes.trim();
  if (notes.length > MAX_BILLER_NOTES) errors.notes = `Keep the notes under ${MAX_BILLER_NOTES} characters.`;

  if (Object.keys(errors).length > 0 || form.kind === null) return { errors, input: null };
  return { errors, input: { name, kind: form.kind, senders, notes, fetchInvoices: form.fetchInvoices } };
}

/**
 * The page that starts a new biller from an email's sender, filled in with the
 * sender's name (or their domain when the email gives no name) and address.
 * Null when the email has no From address.
 */
export function newBillerPathFrom(from: readonly CapturedAddress[]): string | null {
  const sender = from.find((a) => a.address.trim() !== "");
  if (!sender) return null;
  const address = sender.address.trim();
  const name = sender.name.trim() || address.slice(address.lastIndexOf("@") + 1);
  return `/billers/new?${new URLSearchParams({ name, sender: address }).toString()}`;
}

/**
 * The page that changes biller `id` with an email's sender added to its list
 * (saved only on Save). Null when the email has no From address.
 */
export function addSenderPathFrom(id: number, from: readonly CapturedAddress[]): string | null {
  const sender = from.find((a) => a.address.trim() !== "");
  if (!sender) return null;
  return `/billers/${id}?${new URLSearchParams({ addSender: sender.address.trim() }).toString()}`;
}

/** The form's senders box for a saved biller, with `extra` added at the end unless it is already listed. */
export function sendersWith(senders: readonly string[], extra: string | null): { text: string; added: string | null } {
  const sender = extra === null ? "" : normalizeSender(extra);
  const added = sender !== "" && !senders.includes(sender) ? sender : null;
  return { text: (added ? [...senders, added] : senders).join("\n"), added };
}

/** "billing@a.example", "billing@a.example and b.example", "billing@a.example and 2 more". */
export function sendersSummary(senders: readonly string[]): string {
  if (senders.length <= 2) return senders.join(" and ");
  return `${senders[0]} and ${senders.length - 1} more`;
}
