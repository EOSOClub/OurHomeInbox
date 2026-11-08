// The same email captured more than once (owner, 2026-11-02): two of the
// household's mailboxes can read one email, such as a Proton folder and a
// label the same bill also carries, and a mailbox read again after its
// UIDVALIDITY changed captures everything anew. Emails with the same
// Message-ID are one email: only its original is used (paired, sent to
// OurHome); the others are copies, never sent and left out of pairing.
//
//   The original is the one already offered to OurHome (the lowest offer
//   number), else the one captured first, else the lowest capture id.
//   An email with no Message-ID is never a copy.
//
// One bill sent in two emails (owner, 2026-11-05): the City of Sioux Falls
// sends each bill twice, a "New Bill" email from siouxfalls.org and an
// "Invoice# 14221231" email from siouxfalls.gov a day or a few later. They
// have different Message-IDs, so they are not copies, but they are one bill:
// only one is used, and the other is a repeat, never sent and left out of
// pairing (so it is not a second unpaid bill, and does not make the payment
// look late).
//
//   Two bill emails are one bill when they have the same biller, the same
//   amount and the same due date, are at most REPEAT_DAYS apart, are not
//   marked Not a bill, and do not show different invoice numbers or account
//   numbers (a masked place, "XXXXXXXXXXXXXXX840", matches any digit).
//   The one used is the one already offered to OurHome, else one a person
//   marked Checked, else one from a verified sender (the city's .org emails
//   fail the check), else the oldest. An email already offered is never a
//   repeat: OurHome has it.
//
//   A reminder used as the bill (asBill.ts, 2026-11-08) can come weeks after
//   the bill it is about, so when either email is one, the days apart do not
//   matter: the same biller, amount and due date is the same bill.
//
// Pure: no database, no files, so every rule is tested directly.

import type { EmailKind } from "../shared/extraction.js";

/** One email as copy-finding sees it. */
export interface CopyCandidate {
  /** The capture id. */
  id: string;
  /** Its Message-ID header as received, or null. */
  messageId: string | null;
  /** Its offer number when it was offered to OurHome, else null. */
  offered: number | null;
  /** When it was captured (ISO). */
  capturedAt: string;
}

/** Why a copy is never sent. `mailbox` is the name of the mailbox its original was captured from. */
export function copyReason(mailbox: string): string {
  return `A copy of an email also captured from the ${mailbox} mailbox: only that one is used.`;
}

/** A Message-ID without its angle brackets or outer spaces; null when there is nothing left. */
function messageKey(messageId: string | null): string | null {
  const key = messageId?.trim().replace(/^<(.*)>$/, "$1").trim();
  return key ? key : null;
}

const first = (a: CopyCandidate, b: CopyCandidate) =>
  (a.offered ?? Number.POSITIVE_INFINITY) - (b.offered ?? Number.POSITIVE_INFINITY) ||
  a.capturedAt.localeCompare(b.capturedAt) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Each copy's original, by the copy's capture id. Emails that are not copies are not in it. */
export function findCopies(emails: readonly CopyCandidate[]): Map<string, string> {
  const byKey = new Map<string, CopyCandidate[]>();
  for (const email of emails) {
    const key = messageKey(email.messageId);
    if (key === null) continue;
    const same = byKey.get(key);
    if (same) same.push(email);
    else byKey.set(key, [email]);
  }
  const copies = new Map<string, string>();
  for (const same of byKey.values()) {
    if (same.length < 2) continue;
    const [original, ...others] = [...same].sort(first);
    for (const copy of others) copies.set(copy.id, original!.id);
  }
  return copies;
}

/** Bill emails at most this many days apart can be one bill sent twice (the city's are 1 to 4 days apart). */
export const REPEAT_DAYS = 7;

/** One email as repeat-finding sees it (pairing's view of it, plus what decides which is used). */
export interface RepeatCandidate {
  id: string;
  kind: EmailKind;
  billerId: number | null;
  /** The one amount picked out, in cents, or null. */
  amountCents: number | null;
  /** The one due date picked out ("2026-09-03"), or null. */
  dueDay: string | null;
  /** The sender's day it was sent. */
  emailDay: string;
  /** Its own date, else when it was captured (ISO). */
  emailTime: string;
  notBill: boolean;
  /** Its invoice and account numbers as pairing's numberKey writes them, or null. */
  invoiceNo: string | null;
  accountNo: string | null;
  /** Its offer number when it was offered to OurHome, else null. */
  offered: number | null;
  /** A person marked it Checked. */
  checked: boolean;
  /** The mail provider confirmed its sender. */
  senderVerified: boolean;
  /** A reminder used as the bill (a person's mark, or its biller's setting). Left out: false. */
  reminder?: boolean;
}

/** Why a repeat is never sent. `biller` and `day` name the email used instead. */
export function repeatReason(biller: string, day: string): string {
  return `A second email about the ${biller} bill of ${day} (same amount and due date): only that one is used.`;
}

/**
 * Whether two account numbers can be the same account: lined up from the
 * end, no place where both show a digit differs. Masked places ("X"; "*" is
 * already dropped by numberKey) match anything, so the city's
 * "XXXXXXXXXXXXXXX840" is "50160510000220840".
 */
export function sameAccount(a: string, b: string): boolean {
  for (let i = 1; i <= Math.min(a.length, b.length); i++) {
    const x = a[a.length - i]!;
    const y = b[b.length - i]!;
    if (x !== "X" && y !== "X" && x !== y) return false;
  }
  return true;
}

/** Whether two bill emails show nothing that says they are different bills. */
function sameBill(a: RepeatCandidate, b: RepeatCandidate): boolean {
  if (a.invoiceNo !== null && b.invoiceNo !== null && a.invoiceNo !== b.invoiceNo) return false;
  if (a.accountNo !== null && b.accountNo !== null && !sameAccount(a.accountNo, b.accountNo)) return false;
  if (a.reminder || b.reminder) return true;
  return Math.abs(Date.parse(`${a.emailDay}T00:00:00Z`) - Date.parse(`${b.emailDay}T00:00:00Z`)) <= REPEAT_DAYS * 86_400_000;
}

/** The order in which emails of one bill are used: offered, Checked, verified sender, oldest. */
const used = (a: RepeatCandidate, b: RepeatCandidate) =>
  (a.offered ?? Number.POSITIVE_INFINITY) - (b.offered ?? Number.POSITIVE_INFINITY) ||
  Number(b.checked) - Number(a.checked) ||
  Number(b.senderVerified) - Number(a.senderVerified) ||
  a.emailTime.localeCompare(b.emailTime) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Each repeat's original (the email used for that bill), by the repeat's capture id. Emails that are not repeats are not in it. */
export function findRepeatBills(emails: readonly RepeatCandidate[]): Map<string, string> {
  const byBill = new Map<string, RepeatCandidate[]>();
  for (const email of emails) {
    if (email.kind !== "bill" || email.notBill || email.billerId === null || email.amountCents === null || email.dueDay === null) continue;
    const key = `${email.billerId}|${email.amountCents}|${email.dueDay}`;
    const same = byBill.get(key);
    if (same) same.push(email);
    else byBill.set(key, [email]);
  }
  const repeats = new Map<string, string>();
  for (const same of byBill.values()) {
    let left = [...same].sort(used);
    while (left.length > 1) {
      const [original, ...rest] = left;
      const theirs = rest.filter((email) => email.offered === null && sameBill(original!, email));
      for (const repeat of theirs) repeats.set(repeat.id, original!.id);
      left = rest.filter((email) => !theirs.includes(email));
    }
  }
  return repeats;
}
