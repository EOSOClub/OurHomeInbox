// Turns one raw email into the record OurHomeInbox keeps: every header line,
// the text and HTML bodies exactly as sent, each attachment, and every link.
// Nothing is worked out here (no biller, no amount); that is extraction, which
// reads this record later.
//
// Email comes from strangers: nothing here renders HTML or runs anything, and
// an attachment's name is never used as a file path as given.

import { createHash } from "node:crypto";
import { Parser } from "htmlparser2";
import { LinkifyIt } from "linkify-it";
import { simpleParser, type AddressObject, type EmailAddress } from "mailparser";
import {
  CAPTURE_VERSION,
  type Capture,
  type CapturedAddress,
  type CapturedAttachment,
  type CapturedLink,
} from "./shared/capture.js";

// The record's types live in shared/ so the web app can use them too.
export * from "./shared/capture.js";

/** Where a message came from. */
export interface CaptureSource {
  mailbox: string;
  folder: string;
  uidValidity: string;
  uid: number;
  capturedAt: Date;
}

export interface CaptureResult {
  capture: Capture;
  /** Attachment contents to save, by their `file` path. */
  attachments: { file: string; content: Buffer }[];
}

export async function buildCapture(raw: Buffer, source: CaptureSource): Promise<CaptureResult> {
  const parsed = await simpleParser(raw, {
    // Only what the email really contains: no text made from the HTML, no
    // HTML made from the text, no links added to the text, cid: links kept.
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipTextLinks: true,
    keepCidLinks: true,
  });

  const attachments = parsed.attachments.map((attachment, i) => {
    const file = `attachments/${i + 1}-${safeFileName(attachment.filename ?? "attachment")}`;
    const captured: CapturedAttachment = {
      file,
      filename: attachment.filename ?? null,
      contentType: attachment.contentType,
      disposition: attachment.contentDisposition ?? null,
      contentId: attachment.contentId ?? null,
      size: attachment.content.length,
      sha256: sha256(attachment.content),
    };
    return { captured, content: attachment.content };
  });

  // mailparser reports an HTML-only email's missing text body as "", so an
  // empty body counts as none (it carries nothing either way).
  const text = parsed.text ? parsed.text : null;
  const html = typeof parsed.html === "string" && parsed.html !== "" ? parsed.html : null;

  const capture: Capture = {
    version: CAPTURE_VERSION,
    mailbox: source.mailbox,
    folder: source.folder,
    uidValidity: source.uidValidity,
    uid: source.uid,
    capturedAt: source.capturedAt.toISOString(),
    raw: { file: "message.eml", size: raw.length, sha256: sha256(raw) },
    messageId: parsed.messageId ?? null,
    subject: parsed.subject ?? null,
    date: parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date.toISOString() : null,
    from: addresses(parsed.from),
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    replyTo: addresses(parsed.replyTo),
    headers: parsed.headerLines.map((header) => ({ name: header.key, line: header.line })),
    text,
    html,
    attachments: attachments.map((a) => a.captured),
    links: uniqueLinks([...(html === null ? [] : htmlLinks(html)), ...(text === null ? [] : textLinks(text))]),
  };

  return { capture, attachments: attachments.map((a) => ({ file: a.captured.file, content: a.content })) };
}

/**
 * A file name that is safe on every system, from a name a stranger chose:
 * no folders, no ".." tricks, no characters Windows or Linux object to.
 */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._ -]+/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 100);
  return cleaned === "" ? "attachment" : cleaned;
}

/** Every <a href> in the HTML, with its visible text. */
export function htmlLinks(html: string): CapturedLink[] {
  const links: CapturedLink[] = [];
  let open: { url: string; text: string } | null = null;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const href = attributes.href?.trim();
        if (name === "a" && href) open = { url: href, text: "" };
      },
      ontext(text) {
        if (open) open.text += text;
      },
      onclosetag(name) {
        if (name === "a" && open) {
          const text = open.text.replace(/\s+/g, " ").trim();
          links.push({ url: open.url, text: text === "" ? null : text, source: "html" });
          open = null;
        }
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return links;
}

// Only links written out with their scheme (https://...): guessing at bare
// words like "invoice.pdf" finds links that are not there.
const linkify = new LinkifyIt().set({ fuzzyLink: false, fuzzyEmail: false });

/** Every link written out in the plain text body. */
export function textLinks(text: string): CapturedLink[] {
  return (linkify.match(text) ?? []).map((match) => ({ url: match.url, text: null, source: "text" as const }));
}

function uniqueLinks(links: CapturedLink[]): CapturedLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.source}\n${link.url}\n${link.text ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function addresses(field: AddressObject | AddressObject[] | undefined): CapturedAddress[] {
  if (field === undefined) return [];
  const flatten = (list: EmailAddress[]): CapturedAddress[] =>
    list.flatMap((entry) =>
      entry.group ? flatten(entry.group) : entry.address ? [{ name: entry.name, address: entry.address }] : [],
    );
  return (Array.isArray(field) ? field : [field]).flatMap((object) => flatten(object.value));
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
