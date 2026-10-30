// Turns an email's HTML (written by a stranger) into a document that is safe
// to show in a sandboxed iframe. The iframe's empty sandbox is the main guard:
// no scripts, no forms, no popups, no same-origin access. This document adds:
//   - a Content-Security-Policy as the very first element, so remote images,
//     fonts, stylesheets and trackers never load (only inline styles and
//     data: images and fonts do);
//   - a no-referrer policy;
//   - links that cannot be followed (href moved to data-ohi-href), because a
//     bill email can carry payment or unsubscribe links and the frame could
//     otherwise be navigated to a look-alike page;
//   - no <meta http-equiv> (a refresh could navigate the frame), no <base>,
//     no <script>, no on* attributes (inert in the sandbox anyway), and no
//     <link> (the policy blocks outside stylesheets anyway).
// It also reports whether the email asked for remote images, so the page can
// say they were blocked.
//
// Given the reader's picks, it marks each label and value in the email
// (marks are plain elements with a stylesheet, nothing that runs). A mark is
// placed only where the browser's reading of the email gives the same text
// as the server's; any data-ohi-* attributes the email brought are removed
// first, so an email cannot fake a mark.

import { readTree, type ReadingTree } from "../../../src/shared/reading";
import type { PieceMark } from "./picked";

export const EMAIL_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

/** Where a link's address is kept once it can no longer be followed. */
export const LINK_ADDRESS_ATTRIBUTE = "data-ohi-href";

// Plain defaults so an email without styling reads well. Placed before the
// email's own styles, so the email's design wins.
const BASE_STYLE = [
  "html{background:#ffffff;color:#1c1f1d;color-scheme:light}",
  "body{margin:16px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;line-height:1.5;overflow-wrap:anywhere}",
  "img{max-width:100%;height:auto}",
  `a[${LINK_ADDRESS_ATTRIBUTE}]{color:#0b57d0;text-decoration:underline;cursor:default}`,
].join("");

/** Where a mark's role and field name are kept. */
export const MARK_LABEL_ATTRIBUTE = "data-ohi-label";
export const MARK_VALUE_ATTRIBUTE = "data-ohi-value";

// Placed after the email's own styles, and firm, so an email's styling does
// not hide the marks. The field's name shows after each value.
const MARK_STYLE = [
  `mark[${MARK_LABEL_ATTRIBUTE}]{background:#dbeafe!important;color:inherit!important;border-radius:2px}`,
  `mark[${MARK_VALUE_ATTRIBUTE}]{background:#fde68a!important;color:inherit!important;border-radius:2px;box-shadow:0 0 0 2px #fde68a}`,
  `mark[${MARK_VALUE_ATTRIBUTE}]::after{content:attr(${MARK_VALUE_ATTRIBUTE});display:inline-block;margin-left:6px;padding:0 5px;border-radius:3px;background:#7c2d12;color:#ffffff;font:600 11px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;letter-spacing:0;text-transform:none;vertical-align:middle;white-space:nowrap}`,
].join("");

export interface SafeEmail {
  /** The document for the iframe's srcdoc. */
  document: string;
  /** True when the email tried to load images (or CSS backgrounds) from the internet. */
  remoteImages: boolean;
  /** How many of the requested marks were placed, and how many could not be. */
  marked: number;
  unmarked: number;
}

/** The reader's text of the email (from the API) and the marks to place in it. */
export interface EmailMarks {
  pieces: readonly string[];
  marks: readonly PieceMark[];
}

const REMOTE_URL = /^\s*(?:https?:)?\/\//i;
const REMOTE_CSS_URL = /url\(\s*['"]?\s*(?:https?:)?\/\//i;

function isRemote(url: string | null): boolean {
  return url !== null && REMOTE_URL.test(url);
}

function srcsetIsRemote(srcset: string | null): boolean {
  if (!srcset) return false;
  return srcset.split(",").some((candidate) => isRemote(candidate.trim()));
}

function findRemoteImages(doc: Document): boolean {
  for (const el of doc.querySelectorAll("img, source, input, video, image")) {
    if (isRemote(el.getAttribute("src")) || srcsetIsRemote(el.getAttribute("srcset"))) return true;
    if (isRemote(el.getAttribute("poster")) || isRemote(el.getAttribute("href")) || isRemote(el.getAttribute("xlink:href"))) {
      return true;
    }
  }
  for (const el of doc.querySelectorAll("[background]")) {
    if (isRemote(el.getAttribute("background"))) return true;
  }
  for (const el of doc.querySelectorAll("[style]")) {
    if (REMOTE_CSS_URL.test(el.getAttribute("style") ?? "")) return true;
  }
  for (const el of doc.querySelectorAll("style")) {
    if (REMOTE_CSS_URL.test(el.textContent ?? "")) return true;
  }
  return false;
}

const OWN_ATTRIBUTE_PREFIX = "data-ohi-";

/** Remote image addresses move here, so the frame never even asks for them. */
const BLOCKED_PREFIX = "data-ohi-blocked-";

function neutralize(doc: Document): void {
  // Attributes named like this app's own are this app's alone.
  for (const el of doc.querySelectorAll("*")) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith(OWN_ATTRIBUTE_PREFIX)) el.removeAttribute(attr.name);
    }
  }
  for (const el of doc.querySelectorAll("script, base, meta[http-equiv], link")) el.remove();

  // The frame's policy blocks remote images too; taking the addresses out
  // first means nothing depends on that alone, and nothing is even attempted.
  for (const el of doc.querySelectorAll("img, source, input, video, image, [background]")) {
    for (const name of ["src", "poster", "background", "href", "xlink:href"]) {
      const value = el.getAttribute(name);
      if (isRemote(value)) {
        el.removeAttribute(name);
        el.setAttribute(`${BLOCKED_PREFIX}${name.replace(":", "-")}`, value ?? "");
      }
    }
    const srcset = el.getAttribute("srcset");
    if (srcsetIsRemote(srcset)) {
      el.removeAttribute("srcset");
      el.setAttribute(`${BLOCKED_PREFIX}srcset`, srcset ?? "");
    }
  }

  for (const el of doc.querySelectorAll("*")) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name.startsWith(RENAMED_HANDLER_PREFIX)) el.removeAttribute(attr.name);
    }
  }

  for (const el of doc.querySelectorAll("a[href], area[href]")) {
    const href = el.getAttribute("href") ?? "";
    el.removeAttribute("href");
    el.setAttribute(LINK_ADDRESS_ATTRIBUTE, href);
    if (!el.hasAttribute("title") && href) el.setAttribute("title", href);
  }
}

function meta(doc: Document, attributes: Record<string, string>): HTMLMetaElement {
  const el = doc.createElement("meta");
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
  return el;
}

const RENAMED_HANDLER_PREFIX = "data-ohi-removed-on";
const TAG = /<[a-zA-Z][^>]*>/g;
const HANDLER_ATTRIBUTE = /(\s)on([a-z]+)(\s*=)/gi;

/**
 * Renames on* attributes inside tags before parsing. Chrome checks every on*
 * attribute it parses against this page's security policy, even in an inert
 * DOMParser document, and logs a "blocked" error for each (nothing runs).
 * Renaming first keeps the console clean. This is not the protection:
 * neutralize() still removes every on* attribute this misses, and the frame's
 * sandbox and policy stop anything that gets past both.
 */
export function renameEventHandlers(html: string): string {
  return html.replace(TAG, (tag) => tag.replace(HANDLER_ATTRIBUTE, `$1${RENAMED_HANDLER_PREFIX}$2$3`));
}

const LINK_TAG = /<link\b[^>]*>/gi;
const REL_ATTRIBUTE = /(\s)rel(\s*=)/gi;

/**
 * Renames rel on <link> tags before parsing, for the same reason: Chrome
 * checks every stylesheet link it parses against this page's policy and
 * logs an error for each (seen 2026-10-30 on WM invoices, which carry 96
 * broken stylesheet links each). neutralize() removes the links after.
 */
export function renameStylesheetLinks(html: string): string {
  return html.replace(LINK_TAG, (tag) => tag.replace(REL_ATTRIBUTE, `$1${OWN_ATTRIBUTE_PREFIX}removed-rel$2`));
}

const domTree: ReadingTree<Node> = {
  text: (node) => (node.nodeType === 3 ? (node as Text).data : null),
  tag: (node) => (node.nodeType === 1 ? (node as Element).localName : null),
  children: (node) => node.childNodes,
};

/** Wraps each requested label and value in a <mark>. Returns how many were placed and how many were not. */
function placeMarks(doc: Document, request: EmailMarks): { marked: number; unmarked: number } {
  if (request.marks.length === 0) return { marked: 0, unmarked: 0 };
  const reading = readTree<Node>(doc, domTree);
  interface Wrap {
    node: Text;
    start: number;
    end: number;
    mark: PieceMark;
  }
  const wraps: Wrap[] = [];
  let marked = 0;
  let unmarked = 0;
  for (const mark of request.marks) {
    const piece = reading.pieces[mark.piece];
    if (piece === undefined || piece !== request.pieces[mark.piece] || mark.end > piece.length || mark.start >= mark.end) {
      unmarked++;
      continue;
    }
    marked++;
    for (const range of reading.locate(mark.piece, mark.start, mark.end)) {
      wraps.push({ node: reading.textNodes[range.node] as Text, start: range.start, end: range.end, mark });
    }
  }

  // Within each text node, last first, so the earlier offsets stay right as the node is split.
  // A range overlapping one already placed is left out.
  const byNode = new Map<Text, Wrap[]>();
  for (const wrap of wraps) byNode.set(wrap.node, [...(byNode.get(wrap.node) ?? []), wrap]);
  for (const [node, list] of byNode) {
    list.sort((a, b) => b.start - a.start);
    let limit = Infinity;
    for (const wrap of list) {
      if (wrap.end > limit) continue;
      const range = doc.createRange();
      range.setStart(node, wrap.start);
      range.setEnd(node, wrap.end);
      const el = doc.createElement("mark");
      el.setAttribute(wrap.mark.role === "value" ? MARK_VALUE_ATTRIBUTE : MARK_LABEL_ATTRIBUTE, wrap.mark.name);
      range.surroundContents(el);
      limit = wrap.start;
    }
  }
  return { marked, unmarked };
}

/**
 * Prepares an email's HTML for the sandboxed frame, with the reader's marks
 * when given. Pure: the same input always gives the same result.
 */
export function prepareEmailHtml(html: string, marks?: EmailMarks): SafeEmail {
  const doc = new DOMParser().parseFromString(renameStylesheetLinks(renameEventHandlers(html)), "text/html");
  const remoteImages = findRemoteImages(doc);
  neutralize(doc);
  const counts = marks ? placeMarks(doc, marks) : { marked: 0, unmarked: 0 };

  const style = doc.createElement("style");
  style.textContent = BASE_STYLE;
  doc.head.prepend(
    meta(doc, { "http-equiv": "Content-Security-Policy", content: EMAIL_CSP }),
    meta(doc, { name: "referrer", content: "no-referrer" }),
    style,
  );
  if (counts.marked > 0) {
    const markStyle = doc.createElement("style");
    markStyle.textContent = MARK_STYLE;
    (doc.body ?? doc.documentElement).append(markStyle);
  }

  return { document: `<!doctype html>${doc.documentElement.outerHTML}`, remoteImages, ...counts };
}

/** The srcdoc for the email frame. See prepareEmailHtml. */
export function buildSafeEmailDocument(html: string): string {
  return prepareEmailHtml(html).document;
}

/** Whether the email references images or backgrounds on the internet. */
export function hasRemoteImages(html: string): boolean {
  return prepareEmailHtml(html).remoteImages;
}
