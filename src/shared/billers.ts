// Billers: who a household's bills come from, and the email addresses their
// bills are sent from. Shared by the server (which stores and checks them) and
// the web app (which runs the same checks while someone types).
//
// A biller's sender is either a full address ("billing@citywater.com") or a
// domain ("citywater.com"), which covers every address there and at its
// subdomains ("mail.citywater.com").

/** The same two kinds OurHome's bills have: a service to the home, or an extra. */
export const BILLER_KINDS = ["bill", "subscription"] as const;
export type BillerKind = (typeof BILLER_KINDS)[number];

export const MAX_BILLER_NAME = 200;
export const MAX_BILLER_NOTES = 2000;
export const MAX_BILLER_SENDERS = 50;
// The longest an email address can be (RFC 5321).
const MAX_SENDER = 254;

/**
 * A sender as stored: lowercase, trimmed, without a "mailto:", a leading "@"
 * ("@citywater.com" means the domain) or a trailing dot. A pasted
 * "City Water <billing@citywater.com>" keeps only the address.
 */
export function normalizeSender(input: string): string {
  let sender = input.trim().toLowerCase();
  const angle = /<([^<>]*)>\s*$/.exec(sender);
  if (angle) sender = angle[1]!.trim();
  if (sender.startsWith("mailto:")) sender = sender.slice("mailto:".length);
  if (sender.startsWith("@")) sender = sender.slice(1);
  return sender.replace(/\.$/, "");
}

/** A list typed into one box: one sender per line, or separated by commas or semicolons. Normalized, blanks and repeats dropped. */
export function parseSenders(text: string): string[] {
  return uniqueSenders(text.split(/[\n,;]+/));
}

/** Normalizes each sender, dropping blanks and repeats and keeping the first one's place. */
export function uniqueSenders(list: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const item of list) {
    const sender = normalizeSender(item);
    if (sender !== "") seen.add(sender);
  }
  return [...seen];
}

const LABEL = "[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]{0,61}[\\p{L}\\p{N}])?";
const DOMAIN = new RegExp(`^(?:${LABEL}\\.)+${LABEL}$`, "u");
// The part before the @: anything an address may hold except spaces and the
// characters that only appear in quoted or bracketed forms.
const LOCAL_PART = /^[^\s@<>()[\]\\,;:"]+$/u;

export function isDomain(sender: string): boolean {
  return !sender.includes("@");
}

/** What is wrong with a normalized sender, in plain words, or null when it is fine. */
export function senderProblem(sender: string): string | null {
  if (sender.length > MAX_SENDER) return `"${sender.slice(0, 40)}..." is too long to be an email address.`;
  const at = sender.lastIndexOf("@");
  const local = at === -1 ? null : sender.slice(0, at);
  const domain = at === -1 ? sender : sender.slice(at + 1);
  if ((local === null || LOCAL_PART.test(local)) && DOMAIN.test(domain)) return null;
  return `"${sender}" is not an email address or domain. Use a full address like billing@citywater.com, or the part after the @ like citywater.com.`;
}
