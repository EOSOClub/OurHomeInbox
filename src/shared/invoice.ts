// The invoice behind an email's "View Invoice" link, got once and kept with
// the email. Types only, so the web app can use them too; the getting is in
// src/server/invoices.ts.

import type { InvoiceText } from "./extraction.js";

/**
 * - saved: the link gave a PDF with text, kept as invoice.pdf.
 * - sign-in: the link leads to a sign-in page.
 * - not-pdf: the link gave a web page or something else that is not a PDF.
 * - unreadable: the PDF has no text to read (a scan, or damaged).
 * - failed: the link did not answer properly; tried again later, a few times.
 * - blocked: the link was not followed, for safety (not https, a home-network address, too big).
 */
export const INVOICE_OUTCOMES = ["saved", "sign-in", "not-pdf", "unreadable", "failed", "blocked"] as const;
export type InvoiceOutcome = (typeof INVOICE_OUTCOMES)[number];

/** invoice.json in the email's folder. */
export interface InvoiceRecord {
  version: 1;
  outcome: InvoiceOutcome;
  /** What happened, in plain words. */
  reason: string;
  /** The link's words in the email, such as "View Invoice". */
  linkText: string;
  /** The link as it is in the email. */
  url: string;
  /** The site the invoice finally came from (after any redirects), or null when none answered. */
  host: string | null;
  /** When it was last tried (ISO). */
  triedAt: string;
  attempts: number;
  /** "invoice.pdf" when saved. */
  file: "invoice.pdf" | null;
  size: number | null;
  sha256: string | null;
  pages: number | null;
  /** The PDF's text, read when it was saved. */
  text: InvoiceText | null;
}

/** What the API says about an email's invoice: the record without its text or link. */
export type InvoiceInfo = Omit<InvoiceRecord, "version" | "text" | "url">;
