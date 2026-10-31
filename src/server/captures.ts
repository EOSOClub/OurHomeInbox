// Captured mail, read from the capture store's folders:
//   GET /api/captures                                       every captured email, newest first
//   GET /api/captures/:mailbox/:uidValidity/:uid             one email's capture record
//   GET /api/captures/:mailbox/:uidValidity/:uid/raw         its raw .eml, as a download
//   GET /api/captures/:mailbox/:uidValidity/:uid/attachments/:index   one attachment, as a download
//   GET /api/captures/:mailbox/:uidValidity/:uid/choices/:field       what Fix offers for one value
//   GET /api/captures/:mailbox/:uidValidity/:uid/invoice              the invoice its link gave, as a download
//
// Each email carries the household's biller for its sender (see matching.ts),
// whether the mail provider confirmed that sender (see sender.ts), and what
// the reader picked out of it with that biller's rules (see
// extraction.ts and rules.ts), worked out on every request so a change to a
// biller or a rule shows at once.
//
// Everything here came from strangers' email. It is sent as JSON or as a
// download (never as a page), and nothing in it is used as a path except
// through checks that keep it inside the message's own folder.

import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Hono, type Context } from "hono";
import { log } from "../log.js";
import type { CaptureDetailResponse, CaptureListItem, CaptureListResponse, FieldChoicesResponse } from "../shared/api.js";
import type { Capture } from "../shared/capture.js";
import { FIELDS, type BillerRule, type ExtractionSummary, type FieldName } from "../shared/extraction.js";
import type { InvoiceInfo, InvoiceRecord } from "../shared/invoice.js";
import type { CaptureStore } from "../store.js";
import { listBillers } from "./billers.js";
import type { Database } from "./db.js";
import { choicesFor, extract, PreparedEmail, summarize } from "./extraction.js";
import { apiError, householdOf, type AppEnv } from "./http.js";
import { eachCapture, INVOICE_FILE, readCapture, readInvoiceRecord, UID, UID_VALIDITY, type StoredCapture } from "./mail.js";
import type { MailboxPlace, Mailboxes } from "./mailboxes.js";
import { BillerMatcher } from "./matching.js";
import { billerEmails, householdRules } from "./rules.js";
import { checkSender } from "./sender.js";

export interface CaptureDeps {
  store: CaptureStore;
  db: Database;
  mailboxes: Mailboxes;
}

const NOT_FOUND = "That email was not found. It may be in a mailbox that is no longer set up.";
const BAD_LINK = "That link does not point to a saved email.";
const NO_ATTACHMENT = "That attachment was not found.";
const UNREADABLE = "That email's saved copy could not be read.";
const NO_SUCH_FIELD = "That is not a value OurHomeInbox picks out.";
const NO_BILLER = "To fix a value, this email's sender must belong to one of your billers first.";
const NO_INVOICE = "This email has no saved invoice.";

const INDEX = /^[1-9]\d*$/;

/**
 * Remembers each email's summary, so the list does not read every email on
 * every load. Keyed on the email's place, its fingerprint and the rules that
 * applied, so a changed file or a changed rule is read again.
 */
class SummaryCache {
  private readonly entries = new Map<string, ExtractionSummary>();

  constructor(private readonly limit = 10_000) {}

  get(id: string, capture: Capture, rules: readonly BillerRule[], invoice: InvoiceRecord | null): ExtractionSummary {
    const ruleKey = rules.map((rule) => `${rule.field}=${rule.label}`).join("\n");
    const invoiceKey = invoice ? `${invoice.outcome}:${invoice.sha256 ?? ""}` : "";
    const key = `${id}|${capture.capturedAt}|${capture.raw?.sha256 ?? ""}|${invoiceKey}|${ruleKey}`;
    let summary = this.entries.get(key);
    if (!summary) {
      summary = summarize(extract(capture, rules, invoice?.text ?? null));
      if (this.entries.size >= this.limit) this.entries.clear();
      this.entries.set(key, summary);
    }
    return summary;
  }
}

/** The household's mailboxes, billers and their rules, read once per request. */
class HouseholdReader {
  readonly matcher: BillerMatcher;
  /** The household's mailboxes by slug: only their mail is shown. */
  readonly places: Map<string, MailboxPlace>;
  private readonly rules: Map<number, BillerRule[]>;

  constructor(db: Database, mailboxes: Mailboxes, householdId: number) {
    this.matcher = new BillerMatcher(listBillers(db, householdId));
    this.places = mailboxes.places(householdId);
    this.rules = householdRules(db, householdId);
  }

  rulesFor(billerId: number | undefined): BillerRule[] {
    return billerId === undefined ? [] : (this.rules.get(billerId) ?? []);
  }
}

function listItem(stored: StoredCapture, reader: HouseholdReader, summaries: SummaryCache): CaptureListItem {
  const { id, slug, mailbox, uidValidity, uid, capture } = stored;
  const biller = reader.matcher.match(capture.from);
  return {
    id,
    mailbox: mailbox.name,
    mailboxSlug: slug,
    folder: typeof capture.folder === "string" ? capture.folder : mailbox.folder,
    uidValidity,
    uid,
    subject: capture.subject,
    from: capture.from,
    date: capture.date,
    capturedAt: capture.capturedAt,
    attachmentCount: capture.attachments.length,
    linkCount: capture.links.length,
    hasText: capture.text !== null,
    hasHtml: capture.html !== null,
    biller,
    senderVerified: checkSender(capture).verified,
    picked: summaries.get(id, capture, reader.rulesFor(biller?.id), stored.invoice),
  };
}

/** What the API says about an email's invoice: its record without the text or the link. */
function invoiceInfo(record: InvoiceRecord | null): InvoiceInfo | null {
  if (!record) return null;
  const { version: _version, text: _text, url: _url, ...info } = record;
  return info;
}

async function listCaptures(deps: CaptureDeps, reader: HouseholdReader, summaries: SummaryCache): Promise<CaptureListItem[]> {
  const items: CaptureListItem[] = [];
  for await (const stored of eachCapture(reader.places.values(), deps.store)) {
    try {
      items.push(listItem(stored, reader, summaries));
    } catch (err) {
      log.warn(`Skipping ${join(stored.dir, "capture.json")}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const when = (item: CaptureListItem) => {
    const time = Date.parse(item.date ?? item.capturedAt);
    return Number.isNaN(time) ? 0 : time;
  };
  // Ties (same moment) fall back to the id, so the order never shuffles between loads.
  return items.sort((a, b) => when(b) - when(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

interface Located {
  slug: string;
  uidValidity: string;
  uid: number;
  dir: string;
}

/** The message folder named by the route's params, or an error reply when they name nothing. Only the household's own mailboxes count. */
function locate(c: Context<AppEnv>, deps: CaptureDeps): Located | Response {
  const { mailbox: slug = "", uidValidity = "", uid: uidText = "" } = c.req.param();
  if (!deps.mailboxes.places(householdOf(c)).has(slug)) return apiError(c, 404, NOT_FOUND);
  if (!UID_VALIDITY.test(uidValidity) || !UID.test(uidText)) return apiError(c, 400, BAD_LINK);
  const uid = Number(uidText);
  if (!Number.isSafeInteger(uid)) return apiError(c, 400, BAD_LINK);
  return { slug, uidValidity, uid, dir: deps.store.messageDir(slug, uidValidity, uid) };
}

async function locateCapture(c: Context, deps: CaptureDeps): Promise<(Located & { capture: Capture; invoice: InvoiceRecord | null }) | Response> {
  const found = locate(c, deps);
  if (found instanceof Response) return found;
  let capture: Capture | null;
  try {
    capture = await readCapture(found.dir);
  } catch (err) {
    log.warn(`Could not read ${join(found.dir, "capture.json")}: ${err instanceof Error ? err.message : String(err)}`);
    return apiError(c, 500, UNREADABLE);
  }
  if (!capture) return apiError(c, 404, NOT_FOUND);
  return { ...found, capture, invoice: await readInvoiceRecord(found.dir) };
}

/** True when `path` is strictly inside `dir` (not `dir` itself, not beside it). */
function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/**
 * A Content-Disposition value for a download, from a name a stranger chose:
 * a plain-ASCII `filename` for old clients and an RFC 5987 `filename*` that
 * keeps the real characters. No quotes, slashes or control characters survive.
 */
export function attachmentDisposition(name: string): string {
  const cleaned =
    name
      .normalize("NFC")
      .split(/[\\/]/)
      .pop()!
      .replace(/[\p{Cc}\p{Cf}"]+/gu, "")
      .replace(/^[.\s]+|\s+$/g, "")
      .slice(0, 150) || "download";
  const ascii = cleaned.replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/^[._ ]+/, "") || "download";
  const encoded = encodeURIComponent(cleaned).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function download(c: Context, content: Buffer, name: string): Response {
  c.header("Content-Type", "application/octet-stream");
  c.header("Content-Disposition", attachmentDisposition(name));
  return c.body(new Uint8Array(content), 200);
}

export function captureRoutes(deps: CaptureDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const readerFor = (c: Context<AppEnv>) => new HouseholdReader(deps.db, deps.mailboxes, householdOf(c));
  const summaries = new SummaryCache();

  app.get("/captures", async (c) => {
    const body: CaptureListResponse = { captures: await listCaptures(deps, readerFor(c), summaries) };
    return c.json(body);
  });

  app.get("/captures/:mailbox/:uidValidity/:uid", async (c) => {
    const found = await locateCapture(c, deps);
    if (found instanceof Response) return found;
    const reader = readerFor(c);
    const biller = reader.matcher.match(found.capture.from);
    const body: CaptureDetailResponse = {
      id: `${found.slug}/${found.uidValidity}/${found.uid}`,
      mailboxSlug: found.slug,
      capture: found.capture,
      biller,
      sender: checkSender(found.capture),
      invoice: invoiceInfo(found.invoice),
      extraction: extract(found.capture, reader.rulesFor(biller?.id), found.invoice?.text ?? null),
    };
    return c.json(body);
  });

  app.get("/captures/:mailbox/:uidValidity/:uid/invoice", async (c) => {
    const found = await locateCapture(c, deps);
    if (found instanceof Response) return found;
    // Always invoice.pdf (what invoices.ts writes), never a path from the record.
    if (found.invoice?.file !== INVOICE_FILE) return apiError(c, 404, NO_INVOICE);
    let content: Buffer;
    try {
      content = await readFile(join(found.dir, INVOICE_FILE));
    } catch (err) {
      log.warn(`Could not read ${join(found.dir, INVOICE_FILE)}: ${err instanceof Error ? err.message : String(err)}`);
      return apiError(c, 404, NO_INVOICE);
    }
    return download(c, content, `invoice-${found.uid}.pdf`);
  });

  app.get("/captures/:mailbox/:uidValidity/:uid/choices/:field", async (c) => {
    const field = c.req.param("field");
    if (!(FIELDS as readonly string[]).includes(field)) return apiError(c, 404, NO_SUCH_FIELD);
    const found = await locateCapture(c, deps);
    if (found instanceof Response) return found;
    const reader = readerFor(c);
    const biller = reader.matcher.match(found.capture.from);
    if (!biller) return apiError(c, 409, NO_BILLER);
    const rules = reader.rulesFor(biller.id);
    const id = `${found.slug}/${found.uidValidity}/${found.uid}`;
    const others = await billerEmails(reader.places.values(), deps.store, reader.matcher, biller.id, id);
    const body: FieldChoicesResponse = {
      field: field as FieldName,
      biller,
      rule: rules.find((rule) => rule.field === field) ?? null,
      otherEmails: others.length,
      choices: choicesFor(new PreparedEmail(found.capture, found.invoice?.text ?? null), field as FieldName, rules, others),
    };
    return c.json(body);
  });

  app.get("/captures/:mailbox/:uidValidity/:uid/raw", async (c) => {
    const found = await locateCapture(c, deps);
    if (found instanceof Response) return found;
    // Always message.eml (what store.ts writes), never a path from capture.json.
    let content: Buffer;
    try {
      content = await readFile(join(found.dir, "message.eml"));
    } catch (err) {
      log.warn(`Could not read ${join(found.dir, "message.eml")}: ${err instanceof Error ? err.message : String(err)}`);
      return apiError(c, 404, NOT_FOUND);
    }
    return download(c, content, `${found.uid}.eml`);
  });

  app.get("/captures/:mailbox/:uidValidity/:uid/attachments/:index", async (c) => {
    const indexText = c.req.param("index");
    if (!INDEX.test(indexText)) return apiError(c, 400, "That link does not point to an attachment.");
    const found = await locateCapture(c, deps);
    if (found instanceof Response) return found;
    const index = Number(indexText);
    const attachment = index <= found.capture.attachments.length ? found.capture.attachments[index - 1] : undefined;
    if (!attachment || typeof attachment.file !== "string") return apiError(c, 404, NO_ATTACHMENT);

    // The path comes from capture.json; it must stay inside this message's
    // folder, both as written and after following any links on disk.
    const path = resolve(found.dir, attachment.file);
    if (!isInside(resolve(found.dir), path)) {
      log.warn(`Refusing attachment path ${JSON.stringify(attachment.file)} in ${found.dir}`);
      return apiError(c, 404, NO_ATTACHMENT);
    }
    let content: Buffer;
    try {
      const [realDir, realPath] = await Promise.all([realpath(found.dir), realpath(path)]);
      if (!isInside(realDir, realPath)) {
        log.warn(`Refusing attachment path ${JSON.stringify(attachment.file)} in ${found.dir}: it leads outside`);
        return apiError(c, 404, NO_ATTACHMENT);
      }
      content = await readFile(realPath);
    } catch (err) {
      log.warn(`Could not read attachment ${index} in ${found.dir}: ${err instanceof Error ? err.message : String(err)}`);
      return apiError(c, 404, NO_ATTACHMENT);
    }
    const name = typeof attachment.filename === "string" && attachment.filename !== "" ? attachment.filename : attachment.file;
    return download(c, content, name);
  });

  return app;
}
