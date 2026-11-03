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
// Pure: no database, no files, so every rule is tested directly.

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
