// Whether an email really comes from the sender it shows, as the mail
// provider checked it on arrival. Types only, so the web app can use them
// too; the check itself is in src/server/sender.ts.

/**
 * - verified: the provider checked the From address's domain and it passed (DMARC).
 * - failed: the provider checked it and it did not pass.
 * - mismatch: the provider's check passed for a different domain than the From address shows.
 * - missing: there is no verdict from the provider, or no From address to check.
 * - planted: the email carries a verdict in the provider's name that the provider did not add.
 */
export const SENDER_OUTCOMES = ["verified", "failed", "mismatch", "missing", "planted"] as const;
export type SenderOutcome = (typeof SENDER_OUTCOMES)[number];

export interface SenderCheck {
  /** True only for "verified". Anything else is never sent on or followed without a person's OK. */
  verified: boolean;
  outcome: SenderOutcome;
  /** The domain of the email's first From address, lower case, or null when it has none. */
  domain: string | null;
  /** The DMARC result as the provider wrote it ("pass", "fail", "none"), or null when there is none. */
  result: string | null;
  /** What the check found, in plain words. */
  reason: string;
}
