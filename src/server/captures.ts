// Captured mail, read from the capture store's folders:
//   GET /api/captures                                       every captured email, newest first
//   GET /api/captures/:mailbox/:uidValidity/:uid             one email's capture record
//   GET /api/captures/:mailbox/:uidValidity/:uid/raw         its raw .eml, as a download
//   GET /api/captures/:mailbox/:uidValidity/:uid/attachments/:index   one attachment, as a download
//
// Each email carries the household's biller for its sender (see matching.ts),
// worked out on every request so a biller change shows at once, and what the
// built-in reader picked out of it (see extraction.ts).
//
// Everything here came from strangers' email. It is sent as JSON or as a
// download (never as a page), and nothing in it is used as a path except
// through checks that keep it inside the message's own folder.

import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Hono, type Context } from "hono";
import type { Config, MailboxConfig } from "../config.js";
import { mailboxSlug } from "../config.js";
import { log } from "../log.js";
import type { CaptureDetailResponse, CaptureListItem, CaptureListResponse } from "../shared/api.js";
import type { Capture } from "../shared/capture.js";
import type { ExtractionSummary } from "../shared/extraction.js";
import type { CaptureStore } from "../store.js";
import { listBillers } from "./billers.js";
import type { Database } from "./db.js";
import { extract, summarize } from "./extraction.js";
import { apiError, householdOf, type AppEnv } from "./http.js";
import { BillerMatcher } from "./matching.js";

export interface CaptureDeps {
  config: Config;
  store: CaptureStore;
  db: Database;
}

const NOT_FOUND = "That email was not found. It may be in a mailbox that is no longer set up.";
const BAD_LINK = "That link does not point to a saved email.";
const NO_ATTACHMENT = "That attachment was not found.";
const UNREADABLE = "That email's saved copy could not be read.";

const UID_VALIDITY = /^\d+$/;
const UID = /^[1-9]\d*$/;
const INDEX = /^[1-9]\d*$/;

/**
 * v1 has one household, and every mailbox in config.yml belongs to it, so a
 * signed-in user sees every configured mailbox's mail. When mailboxes become
 * per-household, this is where the list gets filtered by c.var.user.household.
 */
function householdMailboxes(config: Config): Map<string, MailboxConfig> {
  return new Map(config.mailboxes.map((mailbox) => [mailboxSlug(mailbox.name), mailbox]));
}

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

async function readCapture(dir: string): Promise<Capture | null> {
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

/**
 * Remembers each email's summary, so the list does not read every email on
 * every load. Keyed on the email's place and its fingerprint, so a changed
 * file is read again. The reader is the same for every household; once
 * biller rules exist, the key must include the rules that applied.
 */
class SummaryCache {
  private readonly entries = new Map<string, ExtractionSummary>();

  constructor(private readonly limit = 10_000) {}

  get(id: string, capture: Capture): ExtractionSummary {
    const key = `${id}|${capture.capturedAt}|${capture.raw?.sha256 ?? ""}`;
    let summary = this.entries.get(key);
    if (!summary) {
      summary = summarize(extract(capture));
      if (this.entries.size >= this.limit) this.entries.clear();
      this.entries.set(key, summary);
    }
    return summary;
  }
}

function listItem(
  slug: string,
  mailbox: MailboxConfig,
  uidValidity: string,
  uid: number,
  capture: Capture,
  matcher: BillerMatcher,
  summaries: SummaryCache,
): CaptureListItem {
  const id = `${slug}/${uidValidity}/${uid}`;
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
    biller: matcher.match(capture.from),
    picked: summaries.get(id, capture),
  };
}

async function listCaptures(deps: CaptureDeps, matcher: BillerMatcher, summaries: SummaryCache): Promise<CaptureListItem[]> {
  const items: CaptureListItem[] = [];
  for (const [slug, mailbox] of householdMailboxes(deps.config)) {
    const mailboxDir = join(deps.store.root, slug);
    for (const uidValidity of await subfolders(mailboxDir, UID_VALIDITY)) {
      for (const uidName of await subfolders(join(mailboxDir, uidValidity), UID)) {
        const uid = Number(uidName);
        if (!Number.isSafeInteger(uid)) continue;
        const dir = join(mailboxDir, uidValidity, uidName);
        try {
          const capture = await readCapture(dir);
          if (capture) items.push(listItem(slug, mailbox, uidValidity, uid, capture, matcher, summaries));
        } catch (err) {
          log.warn(`Skipping ${join(dir, "capture.json")}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
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

/** The message folder named by the route's params, or an error reply when they name nothing. */
function locate(c: Context, deps: CaptureDeps): Located | Response {
  const { mailbox: slug = "", uidValidity = "", uid: uidText = "" } = c.req.param();
  const mailbox = householdMailboxes(deps.config).get(slug);
  if (!mailbox) return apiError(c, 404, NOT_FOUND);
  if (!UID_VALIDITY.test(uidValidity) || !UID.test(uidText)) return apiError(c, 400, BAD_LINK);
  const uid = Number(uidText);
  if (!Number.isSafeInteger(uid)) return apiError(c, 400, BAD_LINK);
  return { slug, uidValidity, uid, dir: deps.store.messageDir(mailbox.name, uidValidity, uid) };
}

async function locateCapture(c: Context, deps: CaptureDeps): Promise<(Located & { capture: Capture }) | Response> {
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
  return { ...found, capture };
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

  const matcherFor = (c: Context<AppEnv>) => new BillerMatcher(listBillers(deps.db, householdOf(c)));
  const summaries = new SummaryCache();

  app.get("/captures", async (c) => {
    const body: CaptureListResponse = { captures: await listCaptures(deps, matcherFor(c), summaries) };
    return c.json(body);
  });

  app.get("/captures/:mailbox/:uidValidity/:uid", async (c) => {
    const found = await locateCapture(c, deps);
    if (found instanceof Response) return found;
    const body: CaptureDetailResponse = {
      id: `${found.slug}/${found.uidValidity}/${found.uid}`,
      mailboxSlug: found.slug,
      capture: found.capture,
      biller: matcherFor(c).match(found.capture.from),
      extraction: extract(found.capture),
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
