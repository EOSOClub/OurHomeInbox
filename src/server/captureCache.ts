// Reading captured emails from disk once. Pairing needs every email of the
// household, so even one email's page goes through all of them; this keeps
// what each list row needs from an email's files, and checks the files'
// stamps (modified time and size) on each read, so an unchanged email is not
// read or parsed again. A file that changes is read again; one that cannot be
// read is warned about once, until it changes. One per app (createApp).
//
// What an email shows also depends on the household's billers, rules, tags
// and marks, which are read fresh on every request (captures.ts); only what
// comes from the email's own files is kept here.

import { stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { log } from "../log.js";
import type { CapturedAddress, Capture } from "../shared/capture.js";
import type { BillerRule, ExtractionSummary } from "../shared/extraction.js";
import type { InvoiceRecord } from "../shared/invoice.js";
import type { CaptureStore } from "../store.js";
import { extract, summarize } from "./extraction.js";
import { eachMessageDir, INVOICE_RECORD, readCapture, readInvoiceRecord, type MessagePlace } from "./mail.js";
import type { MailboxPlace } from "./mailboxes.js";
import { checkSender } from "./sender.js";

/** What a list row needs from an email's files. */
export interface CachedEmail extends MessagePlace {
  subject: string | null;
  from: CapturedAddress[];
  /** The email's Date header as an ISO time, or null. */
  date: string | null;
  capturedAt: string;
  /** The folder recorded in capture.json, or null when it records none. */
  folder: string | null;
  attachmentCount: number;
  linkCount: number;
  hasText: boolean;
  hasHtml: boolean;
  senderVerified: boolean;
  messageId: string | null;
  /** The Date header as received ("Tue, 06 Oct 2026 20:30:00 -0500"), or null: its offset gives the sender's own day. */
  dateHeader: string | null;
  rawSha256: string;
  invoice: InvoiceRecord | null;
}

/** The Date header's value as received, or null. */
export function dateHeaderOf(capture: Capture): string | null {
  const line = capture.headers?.find((header) => header.name === "date")?.line;
  if (typeof line !== "string") return null;
  const at = line.indexOf(":");
  return at === -1 ? null : line.slice(at + 1).replace(/\s+/g, " ").trim() || null;
}

function cachedEmail(place: MessagePlace, capture: Capture, invoice: InvoiceRecord | null): CachedEmail {
  return {
    ...place,
    subject: capture.subject,
    from: capture.from,
    date: capture.date,
    capturedAt: capture.capturedAt,
    folder: typeof capture.folder === "string" ? capture.folder : null,
    attachmentCount: capture.attachments.length,
    linkCount: capture.links.length,
    hasText: capture.text !== null,
    hasHtml: capture.html !== null,
    senderVerified: checkSender(capture).verified,
    messageId: capture.messageId,
    dateHeader: dateHeaderOf(capture),
    rawSha256: capture.raw?.sha256 ?? "",
    invoice,
  };
}

/** A file's stamp (modified time to the nanosecond, and size), or "-" when it is not there. */
async function stamp(path: string): Promise<string> {
  try {
    const info = await stat(path, { bigint: true });
    return `${info.mtimeNs}:${info.size}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "-";
    throw err;
  }
}

/**
 * Remembers each email's summary, so the list does not extract every email on
 * every load. Keyed on the email's place, its fingerprint and the rules that
 * applied, so a changed file or a changed rule is read again.
 */
export class SummaryCache {
  private readonly entries = new Map<string, ExtractionSummary>();

  constructor(private readonly limit = 10_000) {}

  /** The summary of the email with these rules; `load` reads the whole email only when it is not known yet. */
  async get(email: CachedEmail, rules: readonly BillerRule[], load: () => Promise<Capture | null>): Promise<ExtractionSummary> {
    const ruleKey = rules.map((rule) => `${rule.field}=${rule.label}`).join("\n");
    const invoiceKey = email.invoice ? `${email.invoice.outcome}:${email.invoice.sha256 ?? ""}` : "";
    const key = `${email.id}|${email.capturedAt}|${email.rawSha256}|${invoiceKey}|${ruleKey}`;
    let summary = this.entries.get(key);
    if (!summary) {
      const capture = await load();
      if (!capture) throw new Error("capture.json is gone");
      summary = summarize(extract(capture, rules, email.invoice?.text ?? null));
      if (this.entries.size >= this.limit) this.entries.clear();
      this.entries.set(key, summary);
    }
    return summary;
  }
}

interface FileEntry {
  stamp: string;
  /** Null when the files could not be read (warned once). */
  email: CachedEmail | null;
}

export class CaptureCache {
  readonly summaries = new SummaryCache();
  private readonly files = new Map<string, FileEntry>();
  /** How many times an email's files were read and parsed (not just stamped). */
  fileReads = 0;

  /** How many message folders are kept. */
  get kept(): number {
    return this.files.size;
  }

  constructor(private readonly limit = 20_000) {}

  /** What the email's files give, read again only when they changed; null when it is not there or cannot be read. */
  async read(place: MessagePlace): Promise<CachedEmail | null> {
    const capturePath = join(place.dir, "capture.json");
    let fileStamp: string;
    const known = this.files.get(place.dir);
    try {
      const [captureStamp, invoiceStamp] = await Promise.all([stamp(capturePath), stamp(join(place.dir, INVOICE_RECORD))]);
      if (captureStamp === "-") {
        this.files.delete(place.dir);
        return null;
      }
      fileStamp = `${captureStamp}|${invoiceStamp}`;
    } catch (err) {
      // Warned once, like a file that cannot be read, until the problem changes.
      const problem = `stat failed: ${err instanceof Error ? err.message : String(err)}`;
      if (known?.stamp !== problem) log.warn(`Could not read ${capturePath}: ${problem.slice("stat failed: ".length)}`);
      this.files.set(place.dir, { stamp: problem, email: null });
      return null;
    }
    // The place is taken as given: a renamed mailbox keeps its folder, but not its name.
    if (known && known.stamp === fileStamp) return known.email ? { ...known.email, ...place } : null;

    let email: CachedEmail | null = null;
    this.fileReads++;
    try {
      const capture = await readCapture(place.dir);
      if (!capture) return null;
      email = cachedEmail(place, capture, await readInvoiceRecord(place.dir));
    } catch (err) {
      log.warn(`Skipping ${capturePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.files.size >= this.limit) this.files.clear();
    this.files.set(place.dir, { stamp: fileStamp, email });
    return email;
  }

  /** Every readable captured email in the given mailboxes (a household's). Once all are read, what is kept for folders now gone is dropped. */
  async *each(mailboxes: Iterable<MailboxPlace>, store: CaptureStore): AsyncGenerator<CachedEmail> {
    const list = [...mailboxes];
    const roots = list.map((mailbox) => join(store.root, mailbox.slug) + sep);
    const present = new Set<string>();
    for await (const place of eachMessageDir(list, store)) {
      present.add(place.dir);
      const email = await this.read(place);
      if (email) yield email;
    }
    for (const dir of this.files.keys()) {
      if (!present.has(dir) && roots.some((root) => dir.startsWith(root))) this.files.delete(dir);
    }
  }
}
