// Captured mail, read from the capture store's folders:
//   GET /api/captures                                       every captured email, newest first
//   GET /api/captures/:mailbox/:uidValidity/:uid             one email's capture record
//   GET /api/captures/:mailbox/:uidValidity/:uid/raw         its raw .eml, as a download
//   GET /api/captures/:mailbox/:uidValidity/:uid/attachments/:index   one attachment, as a download
//   GET /api/captures/:mailbox/:uidValidity/:uid/choices/:field       what Fix offers for one value
//   GET /api/captures/:mailbox/:uidValidity/:uid/invoice              the invoice its link gave, as a download
//
// Each email carries the household's biller for its sender (see matching.ts),
// its tags (see tags.ts), a person's review mark (see reviews.ts), whether the mail provider confirmed that sender (see sender.ts), what
// the reader picked out of it with that biller's rules (see
// extraction.ts and rules.ts), which bill a payment pays and what pays a bill
// (see payments/pairing.ts), and whether it goes to OurHome (see
// handoff/rules.ts), worked out on every request so a change to a biller or a
// rule shows at once. Pairing looks at every email of the household, so even
// one email's page goes through them all, as the list does; captureCache.ts
// keeps what their files give, so only files that changed are read again.
//
// Everything here came from strangers' email. It is sent as JSON or as a
// download (never as a page), and nothing in it is used as a path except
// through checks that keep it inside the message's own folder.

import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Hono, type Context } from "hono";
import { log } from "../log.js";
import type { CaptureDetailResponse, CaptureListItem, CaptureListResponse, CaptureReview, FieldChoicesResponse, TagRef } from "../shared/api.js";
import type { Capture } from "../shared/capture.js";
import type { HandoffDocument, HandoffInfo } from "../shared/handoff.js";
import { FIELDS, type BillerRule, type FieldName } from "../shared/extraction.js";
import type { InvoiceInfo, InvoiceRecord } from "../shared/invoice.js";
import type { OurHomeChangeKind, PaymentInfo } from "../shared/payments.js";
import type { CaptureStore } from "../store.js";
import { listBillers } from "./billers.js";
import type { CachedEmail, CaptureCache } from "./captureCache.js";
import type { Database } from "./db.js";
import { choicesFor, extract, PreparedEmail } from "./extraction.js";
import { apiError, householdOf, type AppEnv } from "./http.js";
import { INVOICE_FILE, readCapture, readInvoiceRecord, UID, UID_VALIDITY } from "./mail.js";
import type { MailboxPlace, Mailboxes } from "./mailboxes.js";
import { BillerMatcher } from "./matching.js";
import { billReference, documentMessageId, handoffDecision, type BaseItem, type HandoffDecision, type PaymentHandoff } from "./handoff/rules.js";
import { connectionRow, householdOffers, liveStartDate, type OfferRow } from "./handoff/store.js";
import { pairingEmail, pairPayments, type FixedPairing, type PairingEmail, type PairingResult, type PaymentPairing } from "./payments/pairing.js";
import { householdPairings, householdReports } from "./payments/store.js";
import { billerEmails, householdRules } from "./rules.js";
import { captureReviews } from "./reviews.js";
import { checkSender } from "./sender.js";
import { captureTags } from "./tags.js";
import { autoSendBillers } from "./handoff/trust.js";

export interface CaptureDeps {
  store: CaptureStore;
  db: Database;
  mailboxes: Mailboxes;
  /** What each email's files give, and its summaries: one for the whole app (captureCache.ts). */
  cache: CaptureCache;
}

const NOT_FOUND = "That email was not found. It may be in a mailbox that is no longer set up.";
const BAD_LINK = "That link does not point to a saved email.";
const NO_ATTACHMENT = "That attachment was not found.";
const UNREADABLE = "That email's saved copy could not be read.";
const NO_SUCH_FIELD = "That is not a value OurHomeInbox picks out.";
const NO_BILLER = "To fix a value, this email's sender must belong to one of your billers first.";
const NO_INVOICE = "This email has no saved invoice.";

const INDEX = /^[1-9]\d*$/;

/** One email read, before its pairing and hand-off are worked out. */
interface ReadEmail {
  base: BaseItem;
  /** Its Message-ID header, or null. */
  messageId: string | null;
  /** Its Date header as received, or null: its offset gives the sender's own day. */
  dateHeader: string | null;
}

/**
 * An email of the household as the list shows it, its hand-off decision (the
 * document OurHome would get, when it goes), for a payment its pairing, and
 * how pairing sees it (its days are the sender's own days).
 */
export interface HouseholdEmail {
  item: CaptureListItem;
  decision: HandoffDecision;
  pairing: PaymentPairing | null;
  seen: PairingEmail;
}

interface HandoffRecords {
  autoSend: Set<number>;
  startDate: string | null;
  takenUpTo: number;
  offers: Map<string, OfferRow>;
  pairings: Map<string, FixedPairing>;
  reports: Map<string, { change: OurHomeChangeKind; at: string }>;
}

/**
 * The household's mailboxes, billers and their rules, read once per request.
 * Its tags, reviews and hand-off and pairing records are read when first asked for.
 */
class HouseholdReader {
  readonly matcher: BillerMatcher;
  /** The household's mailboxes by slug: only their mail is shown. */
  readonly places: Map<string, MailboxPlace>;
  private readonly rules: Map<number, BillerRule[]>;
  private tags: Map<string, TagRef[]> | null = null;
  private reviews: Map<string, CaptureReview> | null = null;
  private handoff: HandoffRecords | null = null;

  constructor(
    private readonly db: Database,
    mailboxes: Mailboxes,
    private readonly householdId: number,
  ) {
    this.matcher = new BillerMatcher(listBillers(db, householdId));
    this.places = mailboxes.places(householdId);
    this.rules = householdRules(db, householdId);
  }

  private handoffRecords(): HandoffRecords {
    if (!this.handoff) {
      const row = connectionRow(this.db, this.householdId);
      this.handoff = {
        autoSend: autoSendBillers(this.db, this.householdId),
        startDate: liveStartDate(this.db, this.householdId),
        takenUpTo: row?.taken_up_to ?? 0,
        offers: householdOffers(this.db, this.householdId),
        pairings: householdPairings(this.db, this.householdId),
        reports: householdReports(this.db, this.householdId),
      };
    }
    return this.handoff;
  }

  /** Whether the email goes to OurHome, waits, or never goes. `emailDay` is the sender's day it was sent (pairing's too). */
  decide(item: BaseItem, messageId: string | null, payment: PaymentHandoff | null, emailDay: string): HandoffDecision {
    const { autoSend, startDate } = this.handoffRecords();
    return handoffDecision({
      item,
      messageId,
      autoSend: item.biller ? autoSend.has(item.biller.id) : false,
      startDate,
      payment,
      offeredReference: this.offeredReference(item.id),
      emailDay,
    });
  }

  /**
   * The reference OurHome was offered for this bill, which never changes once
   * offered, even after the bill was withdrawn (its document is kept); null
   * when it never went.
   */
  offeredReference(captureId: string): string | null {
    const offer = this.handoffRecords().offers.get(captureId);
    if (!offer?.document) return null;
    try {
      const document = JSON.parse(offer.document) as HandoffDocument;
      return document.kind === "bill" && typeof document.reference === "string" ? document.reference : null;
    } catch {
      return null;
    }
  }

  /**
   * Pairs the household's payments with its bills, then decides each email:
   * bills (and everything else) first, since a payment goes only once its
   * bill goes. `read` must be every email of the household, for pairing.
   */
  finish(read: readonly ReadEmail[]): HouseholdEmail[] {
    const { pairings, reports, startDate } = this.handoffRecords();
    const byId = new Map(read.map((email) => [email.base.id, email]));
    // OurHome reports by the Message-ID it was offered; only bills matter.
    const reported = new Map<string, { change: OurHomeChangeKind; at: string }>();
    for (const { base, messageId } of read) {
      const report = base.picked.kind === "bill" ? reports.get(documentMessageId(base.id, messageId)) : undefined;
      if (report) reported.set(base.id, report);
    }
    const seen = new Map(read.map(({ base, dateHeader }) => [base.id, pairingEmail(base, dateHeader)]));
    const pairing = pairPayments({ emails: [...seen.values()], fixed: pairings, reported: new Set(reported.keys()), startDate });

    const decisions = new Map<string, HandoffDecision>();
    const dayOf = (id: string) => seen.get(id)!.emailDay;
    for (const { base, messageId } of read) {
      if (!pairing.payments.has(base.id)) decisions.set(base.id, this.decide(base, messageId, null, dayOf(base.id)));
    }
    const reference = (bill: ReadEmail) => this.offeredReference(bill.base.id) ?? billReference({ item: bill.base, messageId: bill.messageId });
    for (const { base, messageId } of read) {
      const paired = pairing.payments.get(base.id);
      if (paired) decisions.set(base.id, this.decide(base, messageId, paymentHandoff(paired, byId, decisions, reference), dayOf(base.id)));
    }

    return read.map(({ base }) => {
      const decision = decisions.get(base.id)!;
      const paired = pairing.payments.get(base.id) ?? null;
      return {
        item: { ...base, handoff: this.handoffInfo(base.id, decision), payment: paymentInfo(base, paired, pairing, byId, seen, reported) },
        decision,
        pairing: paired,
        seen: seen.get(base.id)!,
      };
    });
  }

  /** What the page shows about the email and OurHome. */
  handoffInfo(captureId: string, decision: HandoffDecision): HandoffInfo {
    const { startDate, takenUpTo, offers } = this.handoffRecords();
    const offer = offers.get(captureId);
    return {
      state: decision.state,
      reason: decision.reason,
      connected: startDate !== null,
      offered: offer ? { status: offer.status, number: offer.number, at: offer.offered_at, taken: offer.number <= takenUpTo } : null,
    };
  }

  rulesFor(billerId: number | undefined): BillerRule[] {
    return billerId === undefined ? [] : (this.rules.get(billerId) ?? []);
  }

  tagsOn(captureId: string): TagRef[] {
    this.tags ??= captureTags(this.db, this.householdId);
    return this.tags.get(captureId) ?? [];
  }

  reviewOn(captureId: string): CaptureReview | null {
    this.reviews ??= captureReviews(this.db, this.householdId);
    return this.reviews.get(captureId) ?? null;
  }
}

/** A payment's pairing as the hand-off needs it: the bill's reference, and whether the bill goes. */
function paymentHandoff(
  paired: PaymentPairing,
  byId: ReadonlyMap<string, ReadEmail>,
  decisions: ReadonlyMap<string, HandoffDecision>,
  reference: (bill: ReadEmail) => string,
): PaymentHandoff {
  if (paired.how === "own") return { pairing: "own" };
  if (paired.needsBill) return { pairing: "needs-bill", staleChoice: paired.staleChoice };
  const bill = paired.billId === null ? undefined : byId.get(paired.billId);
  if (!bill) return { pairing: "bill-missing" };
  return {
    pairing: "paired",
    reference: reference(bill),
    feeCents: paired.feeCents,
    baseCents: paired.baseCents,
    paidLate: paired.paidLate,
    billBeforeStart: paired.beforeStart,
    billGoes: decisions.get(bill.base.id)?.state === "goes",
    locked: paired.locked,
  };
}

/** The date a page shows for an email: its own date, else when it was captured. */
const shownDate = (item: BaseItem) => item.date ?? item.capturedAt;

/** What the list and the email's page say about pairing: for a payment, its bill; for a bill, what pays it. */
function paymentInfo(
  base: BaseItem,
  paired: PaymentPairing | null,
  pairing: PairingResult,
  byId: ReadonlyMap<string, ReadEmail>,
  seen: ReadonlyMap<string, PairingEmail>,
  reported: ReadonlyMap<string, { change: OurHomeChangeKind; at: string }>,
): PaymentInfo | null {
  if (paired) {
    const bill = paired.billId === null ? undefined : byId.get(paired.billId)?.base;
    const cents = bill ? (seen.get(bill.id)?.amountCents ?? null) : null;
    return {
      role: "payment",
      bill: bill ? { id: bill.id, date: shownDate(bill), amount: cents === null ? null : cents / 100 } : null,
      how: paired.how,
      paidLate: paired.paidLate,
      needsBill: paired.needsBill,
      staleChoice: paired.staleChoice,
      locked: paired.locked,
    };
  }
  if (base.picked.kind !== "bill" || base.review?.state === "not-bill") return null;
  const payer = pairing.paidBy.get(base.id);
  const payment = payer === undefined ? undefined : byId.get(payer)?.base;
  return { role: "bill", paidBy: payment ? { id: payment.id, date: shownDate(payment) } : null, ourhome: reported.get(base.id) ?? null };
}

/** An email as the list shows it, from what its files gave (kept in the cache) and the household's billers, rules, tags and marks. */
async function baseItem(email: CachedEmail, reader: HouseholdReader, cache: CaptureCache): Promise<BaseItem> {
  const { id, slug, mailbox, uidValidity, uid } = email;
  const biller = reader.matcher.match(email.from);
  return {
    id,
    mailbox: mailbox.name,
    mailboxSlug: slug,
    folder: email.folder ?? mailbox.folder,
    uidValidity,
    uid,
    subject: email.subject,
    from: email.from,
    date: email.date,
    capturedAt: email.capturedAt,
    attachmentCount: email.attachmentCount,
    linkCount: email.linkCount,
    hasText: email.hasText,
    hasHtml: email.hasHtml,
    biller,
    senderVerified: email.senderVerified,
    // The whole email is read again only when this summary is not known yet (a new rule, say).
    picked: await cache.summaries.get(email, reader.rulesFor(biller?.id), () => readCapture(email.dir)),
    tags: reader.tagsOn(id),
    review: reader.reviewOn(id),
  };
}

/** What the API says about an email's invoice: its record without the text or the link. */
function invoiceInfo(record: InvoiceRecord | null): InvoiceInfo | null {
  if (!record) return null;
  const { version: _version, text: _text, url: _url, ...info } = record;
  return info;
}

/** Every email of the household, read, paired and decided; newest first. */
async function readAll(deps: CaptureDeps, reader: HouseholdReader): Promise<HouseholdEmail[]> {
  const read: ReadEmail[] = [];
  for await (const email of deps.cache.each(reader.places.values(), deps.store)) {
    try {
      read.push({ base: await baseItem(email, reader, deps.cache), messageId: email.messageId, dateHeader: email.dateHeader });
    } catch (err) {
      log.warn(`Skipping ${join(email.dir, "capture.json")}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const when = (item: BaseItem) => {
    const time = Date.parse(item.date ?? item.capturedAt);
    return Number.isNaN(time) ? 0 : time;
  };
  // Ties (same moment) fall back to the id, so the order never shuffles between loads.
  read.sort((a, b) => when(b.base) - when(a.base) || (a.base.id < b.base.id ? 1 : a.base.id > b.base.id ? -1 : 0));
  return reader.finish(read);
}

async function listCaptures(deps: CaptureDeps, reader: HouseholdReader): Promise<CaptureListItem[]> {
  return (await readAll(deps, reader)).map((r) => r.item);
}

/** Every email of the household with its hand-off decision and pairing, newest first (for the feed to OurHome, and pairing's routes). */
export async function readHouseholdEmails(deps: CaptureDeps, householdId: number): Promise<HouseholdEmail[]> {
  return readAll(deps, new HouseholdReader(deps.db, deps.mailboxes, householdId));
}

/**
 * These emails of the household as the list shows them before their pairing
 * and hand-off are worked out (those need every email), skipping any that are
 * not found. For review, which looks only at the biller and what was picked out.
 */
export async function readHouseholdItems(deps: CaptureDeps, householdId: number, ids: readonly string[]): Promise<Map<string, BaseItem>> {
  const reader = new HouseholdReader(deps.db, deps.mailboxes, householdId);
  const found = new Map<string, BaseItem>();
  for (const id of ids) {
    const [slug = "", uidValidity = "", uidText = ""] = id.split("/");
    const mailbox = reader.places.get(slug);
    if (!mailbox || !UID_VALIDITY.test(uidValidity) || !UID.test(uidText)) continue;
    const uid = Number(uidText);
    const dir = deps.store.messageDir(slug, uidValidity, uid);
    try {
      const email = await deps.cache.read({ id, slug, mailbox, uidValidity, uid, dir });
      if (email) found.set(id, await baseItem(email, reader, deps.cache));
    } catch (err) {
      log.warn(`Could not read ${join(dir, "capture.json")}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return found;
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
  app.get("/captures", async (c) => {
    const body: CaptureListResponse = { captures: await listCaptures(deps, readerFor(c)) };
    return c.json(body);
  });

  app.get("/captures/:mailbox/:uidValidity/:uid", async (c) => {
    const found = await locateCapture(c, deps);
    if (found instanceof Response) return found;
    const reader = readerFor(c);
    const biller = reader.matcher.match(found.capture.from);
    const id = `${found.slug}/${found.uidValidity}/${found.uid}`;
    // Pairing needs every email of the household; the list's read gives this one with the rest.
    const all = await readAll(deps, reader);
    let item = all.find((email) => email.item.id === id)?.item;
    if (!item) {
      // Not among them (it could not be read with the rest): shown on its own, paired with nothing.
      const mailbox = reader.places.get(found.slug)!;
      const email = await deps.cache.read({ id, slug: found.slug, mailbox, uidValidity: found.uidValidity, uid: found.uid, dir: found.dir });
      if (!email) return apiError(c, 500, UNREADABLE);
      const base = await baseItem(email, reader, deps.cache);
      item = reader.finish([{ base, messageId: email.messageId, dateHeader: email.dateHeader }])[0]!.item;
    }
    const body: CaptureDetailResponse = {
      id,
      mailboxSlug: found.slug,
      capture: found.capture,
      biller,
      sender: checkSender(found.capture),
      invoice: invoiceInfo(found.invoice),
      extraction: extract(found.capture, reader.rulesFor(biller?.id), found.invoice?.text ?? null),
      tags: item.tags,
      review: item.review,
      handoff: item.handoff,
      payment: item.payment,
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
