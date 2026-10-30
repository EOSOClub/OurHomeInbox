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
//     no <script>, no on* attributes (inert in the sandbox anyway).
// It also reports whether the email asked for remote images, so the page can
// say they were blocked.

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

export interface SafeEmail {
  /** The document for the iframe's srcdoc. */
  document: string;
  /** True when the email tried to load images (or CSS backgrounds) from the internet. */
  remoteImages: boolean;
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

/** Remote image addresses move here, so the frame never even asks for them. */
const BLOCKED_PREFIX = "data-ohi-blocked-";

function neutralize(doc: Document): void {
  for (const el of doc.querySelectorAll("script, base, meta[http-equiv]")) el.remove();

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

/** Prepares an email's HTML for the sandboxed frame. Pure: the same HTML always gives the same result. */
export function prepareEmailHtml(html: string): SafeEmail {
  const doc = new DOMParser().parseFromString(renameEventHandlers(html), "text/html");
  const remoteImages = findRemoteImages(doc);
  neutralize(doc);

  const style = doc.createElement("style");
  style.textContent = BASE_STYLE;
  doc.head.prepend(
    meta(doc, { "http-equiv": "Content-Security-Policy", content: EMAIL_CSP }),
    meta(doc, { name: "referrer", content: "no-referrer" }),
    style,
  );

  return { document: `<!doctype html>${doc.documentElement.outerHTML}`, remoteImages };
}

/** The srcdoc for the email frame. See prepareEmailHtml. */
export function buildSafeEmailDocument(html: string): string {
  return prepareEmailHtml(html).document;
}

/** Whether the email references images or backgrounds on the internet. */
export function hasRemoteImages(html: string): boolean {
  return prepareEmailHtml(html).remoteImages;
}
