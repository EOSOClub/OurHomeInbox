// What the Status page says: which things need someone (a mailbox that keeps
// failing or has no usable password, reading that stopped), and counts of the
// household's emails. Expected states, like a biller's link that needs a
// sign-in or a sender that is not verified, are counted, not raised as alarms.

import type { CaptureListItem, CheckingState, MailboxInfo } from "../../src/shared/api";
import type { InvoiceOutcome } from "../../src/shared/invoice";
import { formatDateTime } from "./format";
import { isToReview, needsCheckNow } from "./mail/review";
import { needsBill } from "./payments/paymentText";

/** Why a mailbox needs someone, or null when it does not. */
export function mailboxProblem(mailbox: MailboxInfo): string | null {
  if (!mailbox.enabled) return null;
  if (mailbox.imap.passwordProblem) return `${mailbox.name}: ${mailbox.imap.passwordProblem}`;
  if (!mailbox.imap.passwordSet) return `${mailbox.name} has no saved password, so it cannot be read. Add it in Settings.`;
  if (mailbox.lastCheck && !mailbox.lastCheck.ok) {
    const since = mailbox.failingSince ? ` since ${formatDateTime(mailbox.failingSince)}` : "";
    return `${mailbox.name} has not been read${since}: ${mailbox.lastCheck.message}`;
  }
  return null;
}

/** True when any mailbox needs someone: shown as a mark on Status in the menu. */
export function anyMailboxProblem(mailboxes: readonly MailboxInfo[]): boolean {
  return mailboxes.some((mailbox) => mailboxProblem(mailbox) !== null);
}

/**
 * Reading that stopped: no read has finished for three times the interval,
 * and none is running. Null when reading is fine.
 */
export function readingProblem(checking: CheckingState, now: Date): string | null {
  if (checking.running || !checking.lastFinishedAt) return null;
  const late = now.getTime() - Date.parse(checking.lastFinishedAt) > 3 * checking.everyMinutes * 60_000;
  return late ? `Mail has not been read since ${formatDateTime(checking.lastFinishedAt)}, though it should be every ${checking.everyMinutes === 1 ? "minute" : `${checking.everyMinutes} minutes`}.` : null;
}

/** Everything that needs someone, in plain sentences. */
export function attention(mailboxes: readonly MailboxInfo[], checking: CheckingState, now: Date): string[] {
  const found = mailboxes.map(mailboxProblem).filter((line): line is string => line !== null);
  const reading = readingProblem(checking, now);
  return reading ? [reading, ...found] : found;
}

/** A mailbox's state in one or two words. */
export function mailboxState(mailbox: MailboxInfo): { label: string; tone: "ok" | "warn" | "quiet" } {
  if (!mailbox.enabled) return { label: "Paused", tone: "quiet" };
  if (mailboxProblem(mailbox)) return { label: "Needs you", tone: "warn" };
  if (!mailbox.lastCheck) return { label: "Not read yet", tone: "quiet" };
  return { label: "Working", tone: "ok" };
}

export interface EmailCounts {
  total: number;
  bills: number;
  /** In the Review list: nobody has marked them checked or not a bill yet, or they are payments that need a bill. */
  toReview: number;
  notBill: number;
  /** Going to OurHome: Checked, or from a biller that sends automatically (shared/handoff.ts). */
  goesToOurHome: number;
  /** Waiting for a person before they can go to OurHome. */
  waitsBeforeOurHome: number;
  /** Payments no bill fits and nobody chose a bill for (shared/payments.ts). */
  needsBill: number;
  /** More than one candidate for a value, and not reviewed yet. */
  needsCheck: number;
  pastDue: number;
  senderNotVerified: number;
  noBiller: number;
}

export function emailCounts(captures: readonly CaptureListItem[]): EmailCounts {
  return {
    total: captures.length,
    bills: captures.filter((c) => c.picked.kind === "bill").length,
    toReview: captures.filter(isToReview).length,
    notBill: captures.filter((c) => c.review?.state === "not-bill").length,
    goesToOurHome: captures.filter((c) => c.handoff.state === "goes").length,
    waitsBeforeOurHome: captures.filter((c) => c.handoff.state === "waits").length,
    needsBill: captures.filter(needsBill).length,
    needsCheck: captures.filter(needsCheckNow).length,
    pastDue: captures.filter((c) => c.picked.dueNow).length,
    senderNotVerified: captures.filter((c) => !c.senderVerified).length,
    noBiller: captures.filter((c) => c.biller === null).length,
  };
}

/** What each invoice link outcome is called on the Status page. */
export const INVOICE_OUTCOME_LABELS: Record<InvoiceOutcome, string> = {
  saved: "Invoice saved",
  "sign-in": "Needs a sign-in",
  "not-pdf": "Not a PDF",
  unreadable: "PDF with no text",
  failed: "Did not work",
  blocked: "Not opened, for safety",
};
