// Getting the invoice behind an email's "View Invoice" link, once, and
// keeping it with the email (invoice.pdf and invoice.json in its folder).
//
// A link in an email is chosen by whoever sent it, so it is followed only:
//   - for an email whose sender the mail provider confirmed (sender.ts), from
//     one of the household's billers with "Get the invoice from its link" on;
//   - when the link's words say it views an invoice, bill or statement;
//   - over https, on the usual port, with no name or password in it;
//   - to a public internet address: every address a name leads to is checked
//     when connecting, and every redirect is checked again, so a link can never
//     make this server open something on the home network;
//   - with limits on redirects, size and time, and no cookies.
// What comes back is only kept when it is a PDF; it is never run or shown as
// a page. A sign-in page is noted and nothing is kept.

import { createHash } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../log.js";
import type { CapturedLink } from "../shared/capture.js";
import type { InvoiceText } from "../shared/extraction.js";
import type { InvoiceOutcome, InvoiceRecord } from "../shared/invoice.js";
import type { CaptureStore } from "../store.js";
import { listBillers } from "./billers.js";
import type { Database } from "./db.js";
import { eachCapture, INVOICE_FILE, INVOICE_RECORD } from "./mail.js";
import type { Mailboxes } from "./mailboxes.js";
import { BillerMatcher } from "./matching.js";
import { readPdf } from "./pdf.js";
import { checkSender } from "./sender.js";

const MAX_REDIRECTS = 5;
const MAX_BYTES = 15 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
/** A link that fails for a passing reason (no answer, a server error) is tried this many times in all. */
export const MAX_ATTEMPTS = 3;
/** At most this many links are opened in one pass, so a backlog is worked through gently. */
const MAX_PER_PASS = 20;

// ---- Which link -----------------------------------------------------------

const INVOICE_WORDS = /\b(?:view|see|download|open|get|print)\b[^.!?]{0,20}?\b(?:invoice|bill|statement)s?\b/i;

/** The email's first link whose words say it views an invoice, bill or statement, or null. */
export function invoiceLink(links: readonly CapturedLink[]): CapturedLink | null {
  return links.find((link) => link.source === "html" && link.text !== null && INVOICE_WORDS.test(link.text) && /^https:/i.test(link.url)) ?? null;
}

// ---- Where it may go ------------------------------------------------------

// Addresses a link may never reach: this machine, the home network, and the
// ranges set aside for special use (RFC 6890 and friends).
const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv6");
}

/** True when `address` is on the public internet. IPv6 forms that carry an IPv4 address are judged by that address. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !PRIVATE.check(address, "ipv4");
  if (family !== 6) return false;
  const lower = address.toLowerCase();
  // ::ffff:10.0.0.1, ::ffff:a00:1, 64:ff9b::10.0.0.1 and ::10.0.0.1 all lead to an IPv4 address.
  const embedded = /^(?:::ffff:|64:ff9b::|::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (embedded) return isPublicAddress(embedded[1]!);
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const n = (parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16);
    return isPublicAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
  }
  return !PRIVATE.check(address, "ipv6");
}

/** Thrown when a link would go somewhere it may not. Its message is shown to the household. */
export class BlockedLink extends Error {}

/** Resolves a name like the system does, refusing it when any address it gives is not public. */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, "", 0);
    const bad = addresses.find((a) => !isPublicAddress(a.address));
    if (bad || addresses.length === 0) {
      return callback(new BlockedLink(`${hostname} leads to an address on a private network`), "", 0);
    }
    if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
    return callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

/** Why `url` may not be opened, or null when it may. */
export function linkProblem(url: URL): string | null {
  if (url.protocol !== "https:") return "it is not a secure (https) link";
  if (url.username || url.password) return "it has a name or password in it";
  if (url.port !== "" && url.port !== "443") return "it uses an unusual port";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host)) return "it leads to an address on a private network";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return "it leads to this computer or the home network";
  }
  return null;
}

// ---- Getting it -----------------------------------------------------------

export interface RawResponse {
  status: number;
  /** Lower-case names. */
  headers: Record<string, string | undefined>;
  body: Buffer;
}

/** One https GET with the guarded lookup, no cookies, and the size and time limits. */
export function httpsGet(url: URL): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const problem = linkProblem(url);
    if (problem) return reject(new BlockedLink(problem));
    const req = request(
      url,
      {
        method: "GET",
        lookup: guardedLookup,
        timeout: TIMEOUT_MS,
        headers: { "User-Agent": "OurHomeInbox (gets a bill's invoice from its link)", Accept: "application/pdf, text/html;q=0.8, */*;q=0.5" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy(new BlockedLink(`what it sent is over ${MAX_BYTES / 1024 / 1024} MB`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const headers: Record<string, string | undefined> = {};
          for (const [name, value] of Object.entries(res.headers)) headers[name] = Array.isArray(value) ? value.join(", ") : value;
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
        });
        res.on("error", reject);
      },
    );
    const deadline = setTimeout(() => req.destroy(new Error("it took too long to answer")), TIMEOUT_MS);
    req.on("timeout", () => req.destroy(new Error("it took too long to answer")));
    req.on("error", (err) => {
      clearTimeout(deadline);
      reject(err);
    });
    req.on("close", () => clearTimeout(deadline));
    req.end();
  });
}

/** What opening an invoice link gave. */
export interface FetchResult {
  outcome: InvoiceOutcome;
  /** Why, in a few plain words, for the reason sentence. */
  detail: string;
  host: string | null;
  /** False when trying again later cannot help. */
  retry: boolean;
  pdf: Buffer | null;
  text: InvoiceText | null;
  pages: number | null;
}

// A sign-in page: a password box, or a title or form that says so.
const SIGN_IN = /<input\b[^>]*\btype\s*=\s*["']?password\b|<title>[^<]*\b(?:sign|log)\s?-?\s?in\b|<form\b[^>]*\baction\s*=\s*["'][^"']*(?:login|signin|sign-in|log-in)/i;

/** Opens an invoice link, following its redirects, and says what it gave. `get` is for tests. */
export async function fetchInvoice(link: string, get: (url: URL) => Promise<RawResponse> = httpsGet): Promise<FetchResult> {
  const result = (outcome: InvoiceOutcome, detail: string, host: string | null, retry = false): FetchResult => ({
    outcome,
    detail,
    host,
    retry,
    pdf: null,
    text: null,
    pages: null,
  });
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return result("blocked", "it is not a web address", null);
  }
  for (let hop = 0; ; hop++) {
    const problem = linkProblem(url);
    if (problem) return result("blocked", problem, url.hostname);
    let res: RawResponse;
    try {
      res = await get(url);
    } catch (err) {
      if (err instanceof BlockedLink) return result("blocked", err.message, url.hostname);
      const code = (err as NodeJS.ErrnoException).code;
      const detail = code === "ENOTFOUND" ? `${url.hostname} could not be found` : err instanceof Error && !code ? err.message : `it could not be reached (${code ?? "no answer"})`;
      return result("failed", detail, url.hostname, true);
    }
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop >= MAX_REDIRECTS) return result("blocked", "it sent the request on too many times", url.hostname);
      try {
        url = new URL(location, url);
      } catch {
        return result("failed", "it sent the request on to an address that is not one", url.hostname);
      }
      continue;
    }
    const host = url.hostname;
    if (res.status !== 200) {
      // 404 or 410: the link is gone, and stays gone. A server error may pass.
      return result("failed", `the site answered with error ${res.status}`, host, res.status >= 500 || res.status === 429);
    }
    const type = (res.headers["content-type"] ?? "").toLowerCase();
    const isPdf = res.body.subarray(0, 5).toString("latin1") === "%PDF-";
    if (isPdf) {
      const read = await readPdf(new Uint8Array(res.body));
      if (!read) return { ...result("unreadable", "the PDF has no text to read", host), pdf: res.body };
      return { outcome: "saved", detail: "", host, retry: false, pdf: res.body, text: read.text, pages: read.pages };
    }
    if (type.includes("html")) {
      const html = res.body.toString("utf8");
      return SIGN_IN.test(html) ? result("sign-in", "it leads to a sign-in page", host) : result("not-pdf", "it leads to a web page, not a PDF", host);
    }
    return result("not-pdf", `it gave ${type.split(";")[0] || "something"} instead of a PDF`, host);
  }
}

// ---- Keeping it -----------------------------------------------------------

/** The reason sentence the household sees. */
export function invoiceReason(outcome: InvoiceOutcome, linkText: string, host: string | null, detail: string, pages: number | null, attempts: number): string {
  const link = `the email's "${linkText}" link`;
  const at = host ? ` at ${host}` : "";
  switch (outcome) {
    case "saved":
      return `Got the invoice (${pages === 1 ? "a 1-page" : `a ${pages}-page`} PDF) from ${link}${at}.`;
    case "sign-in":
      return `${link[0]!.toUpperCase()}${link.slice(1)} leads to a sign-in page${at}, so the invoice cannot be got without your password. You can turn this off for this biller.`;
    case "not-pdf":
      return `${link[0]!.toUpperCase()}${link.slice(1)} did not give a PDF${at}: ${detail}. OurHomeInbox reads only PDF invoices so far.`;
    case "unreadable":
      return `The PDF from ${link}${at} has no text OurHomeInbox can read, so it is kept but nothing is picked out of it.`;
    case "blocked":
      return `${link[0]!.toUpperCase()}${link.slice(1)} was not opened, for safety: ${detail}.`;
    case "failed":
      return attempts < MAX_ATTEMPTS
        ? `${link[0]!.toUpperCase()}${link.slice(1)} did not work: ${detail}. It is tried again later (tried ${attempts} of ${MAX_ATTEMPTS} times).`
        : `${link[0]!.toUpperCase()}${link.slice(1)} did not work: ${detail}. It was tried ${attempts} times.`;
  }
}

/** Writes the PDF (when there is one) and then the record, each in one step. */
async function writeInvoice(dir: string, record: InvoiceRecord, pdf: Buffer | null): Promise<void> {
  if (pdf) {
    const file = join(dir, INVOICE_FILE);
    await writeFile(`${file}.tmp`, pdf);
    await rename(`${file}.tmp`, file);
  }
  const json = join(dir, INVOICE_RECORD);
  await writeFile(`${json}.tmp`, `${JSON.stringify(record)}\n`);
  await rename(`${json}.tmp`, json);
}

/** True when an email's invoice has been settled, or tried as often as it will be. */
function settled(record: InvoiceRecord | null): boolean {
  return record !== null && (record.outcome !== "failed" || record.attempts >= MAX_ATTEMPTS);
}

export interface InvoicePassDeps {
  store: CaptureStore;
  db: Database;
  mailboxes: Mailboxes;
  now?: () => Date;
  /** For tests. */
  fetch?: (link: string) => Promise<FetchResult>;
}

/**
 * Gets the invoice for every captured email that can have one and has not
 * been settled yet: a confirmed sender, a biller of its own household with the
 * switch on, and an invoice link. Each email's link is opened at most
 * MAX_ATTEMPTS times, ever.
 */
export async function invoicePass(deps: InvoicePassDeps): Promise<{ tried: number; saved: number }> {
  const now = deps.now ?? (() => new Date());
  const fetch = deps.fetch ?? ((link: string) => fetchInvoice(link));
  let tried = 0;
  let saved = 0;
  households: for (const householdId of deps.mailboxes.households()) {
    const billers = listBillers(deps.db, householdId);
    const matcher = new BillerMatcher(billers);
    const byId = new Map(billers.map((b) => [b.id, b]));
    for await (const stored of eachCapture(deps.mailboxes.places(householdId).values(), deps.store)) {
      if (tried >= MAX_PER_PASS) {
        log.info(`Invoices: stopping at ${MAX_PER_PASS} links for now; the rest follow on the next pass`);
        break households;
      }
      const previous = stored.invoice;
      if (settled(previous)) continue;
      const { capture } = stored;
      const link = invoiceLink(capture.links);
      if (!link || !checkSender(capture).verified) continue;
      const match = matcher.match(capture.from);
      const biller = match ? byId.get(match.id) : undefined;
      if (!biller?.fetchInvoices) continue;

      tried += 1;
      const linkText = (link.text ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
      const got = await fetch(link.url);
      const attempts = (previous?.attempts ?? 0) + 1;
      const record: InvoiceRecord = {
        version: 1,
        outcome: got.outcome,
        reason: invoiceReason(got.outcome, linkText, got.host, got.detail, got.pages, got.retry ? attempts : MAX_ATTEMPTS),
        linkText,
        url: link.url,
        host: got.host,
        triedAt: now().toISOString(),
        attempts: got.retry ? attempts : Math.max(attempts, MAX_ATTEMPTS),
        file: got.pdf ? INVOICE_FILE : null,
        size: got.pdf ? got.pdf.length : null,
        sha256: got.pdf ? createHash("sha256").update(got.pdf).digest("hex") : null,
        pages: got.pages,
        text: got.text,
      };
      await writeInvoice(stored.dir, record, got.pdf);
      if (got.outcome === "saved") saved += 1;
      log.info(`Invoice for ${stored.id} (${biller.name}): ${got.outcome}${got.host ? ` at ${got.host}` : ""}${got.detail ? `, ${got.detail}` : ""}`);
    }
  }
  return { tried, saved };
}
