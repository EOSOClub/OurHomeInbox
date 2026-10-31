// Reading captured mail back from the capture store's folders, for the routes
// that show it (captures.ts), the ones that try biller rules on it (rules.ts)
// and the invoice pass (invoices.ts). Always for a household's own mailboxes
// (mailboxes.ts). Everything here came from strangers' email: it is only read.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../log.js";
import type { Capture } from "../shared/capture.js";
import type { InvoiceRecord } from "../shared/invoice.js";
import type { CaptureStore } from "../store.js";
import type { MailboxPlace } from "./mailboxes.js";

export const UID_VALIDITY = /^\d+$/;
export const UID = /^[1-9]\d*$/;

/** A light shape check, so a damaged capture.json is skipped instead of breaking the list. */
function isCapture(value: unknown): value is Capture {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const stringOrNull = (x: unknown) => x === null || typeof x === "string";
  return (
    typeof v.capturedAt === "string" &&
    stringOrNull(v.subject) &&
    stringOrNull(v.date) &&
    stringOrNull(v.text) &&
    stringOrNull(v.html) &&
    Array.isArray(v.from) &&
    Array.isArray(v.attachments) &&
    Array.isArray(v.links)
  );
}

export async function readCapture(dir: string): Promise<Capture | null> {
  let text: string;
  try {
    text = await readFile(join(dir, "capture.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const value: unknown = JSON.parse(text);
  if (!isCapture(value)) throw new Error("capture.json is not a capture record");
  return value;
}

/** Folder names in `dir` that match `pattern`; none when the folder does not exist. */
async function subfolders(dir: string, pattern: RegExp): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && pattern.test(e.name)).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** The invoice its link gave, kept beside capture.json (see invoices.ts). */
export const INVOICE_FILE = "invoice.pdf";
export const INVOICE_RECORD = "invoice.json";

/** The email's invoice record, or null when there is none (or it is damaged). */
export async function readInvoiceRecord(dir: string): Promise<InvoiceRecord | null> {
  let text: string;
  try {
    text = await readFile(join(dir, INVOICE_RECORD), "utf8");
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(text) as InvoiceRecord;
    return value && value.version === 1 && typeof value.outcome === "string" && typeof value.attempts === "number" ? value : null;
  } catch {
    return null;
  }
}

export interface StoredCapture {
  /** "<mailboxSlug>/<uidValidity>/<uid>", as in CaptureListItem.id. */
  id: string;
  slug: string;
  mailbox: MailboxPlace;
  uidValidity: string;
  uid: number;
  /** The message's folder, for warnings. */
  dir: string;
  capture: Capture;
  invoice: InvoiceRecord | null;
}

/** Every captured email in the given mailboxes (a household's). A damaged one is skipped with a warning. */
export async function* eachCapture(mailboxes: Iterable<MailboxPlace>, store: CaptureStore): AsyncGenerator<StoredCapture> {
  for (const mailbox of mailboxes) {
    const { slug } = mailbox;
    const mailboxDir = join(store.root, slug);
    for (const uidValidity of await subfolders(mailboxDir, UID_VALIDITY)) {
      for (const uidName of await subfolders(join(mailboxDir, uidValidity), UID)) {
        const uid = Number(uidName);
        if (!Number.isSafeInteger(uid)) continue;
        const dir = join(mailboxDir, uidValidity, uidName);
        let capture: Capture | null;
        try {
          capture = await readCapture(dir);
        } catch (err) {
          log.warn(`Skipping ${join(dir, "capture.json")}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (capture) yield { id: `${slug}/${uidValidity}/${uid}`, slug, mailbox, uidValidity, uid, dir, capture, invoice: await readInvoiceRecord(dir) };
      }
    }
  }
}
