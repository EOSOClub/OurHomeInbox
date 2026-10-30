// @vitest-environment jsdom
// Tests for the safe email document: CSP first, links and refreshes made
// harmless, scripts dropped, and remote images detected.

import { describe, expect, it } from "vitest";
import { extract } from "../../../src/server/extraction";
import { marksFor } from "./picked";
import {
  buildSafeEmailDocument,
  EMAIL_CSP,
  hasRemoteImages,
  LINK_ADDRESS_ATTRIBUTE,
  MARK_LABEL_ATTRIBUTE,
  MARK_VALUE_ATTRIBUTE,
  prepareEmailHtml,
  renameEventHandlers,
  renameStylesheetLinks,
} from "./safeEmail";

describe("renameStylesheetLinks", () => {
  it("renames rel on link tags only, before the HTML is parsed", () => {
    // WM's invoices carry links like this one, broken and blocked anyway.
    const html = '<link href="font-family:" arial black; rel="stylesheet"><LINK REL=stylesheet href=x.css><p rel="x">rel=1</p>';
    expect(renameStylesheetLinks(html)).toBe(
      '<link href="font-family:" arial black; data-ohi-removed-rel="stylesheet"><LINK data-ohi-removed-rel=stylesheet href=x.css><p rel="x">rel=1</p>',
    );
  });

  it("leaves no link in the frame's document", () => {
    const result = prepareEmailHtml('<head><link rel="stylesheet" href="https://t.example/a.css"></head><p>Hi</p>');
    expect(result.document).not.toMatch(/<link|a\.css|removed-rel/i);
    expect(result.document).toContain("<p>Hi</p>");
  });
});

describe("renameEventHandlers", () => {
  it("renames on* attributes inside tags before the HTML is parsed", () => {
    expect(renameEventHandlers('<body onload="x()"><button ONCLICK = "y()">b</button>')).toBe(
      '<body data-ohi-removed-onload="x()"><button data-ohi-removed-onCLICK = "y()">b</button>',
    );
  });

  it("leaves text outside tags alone", () => {
    expect(renameEventHandlers("<p>Pay on=time, carry on=on</p>")).toBe("<p>Pay on=time, carry on=on</p>");
  });

  it("takes remote image addresses out, keeping data: images and the notice", () => {
    const safe = prepareEmailHtml(
      '<img src="https://t.example/p.gif"><img srcset="https://t.example/a.png 2x"><td background="http://t.example/bg.png">x</td><img src="data:image/gif;base64,R0lGOD">',
    );
    expect(safe.remoteImages).toBe(true);
    expect(safe.document).not.toMatch(/\s(src|srcset|background)="https?:/);
    expect(safe.document).toContain('data-ohi-blocked-src="https://t.example/p.gif"');
    expect(safe.document).toContain('src="data:image/gif;base64,R0lGOD"');
  });

  it("leaves no renamed or original handler in the frame's document", () => {
    const doc = buildSafeEmailDocument('<body onload="x()"><img src="data:," onerror="y()"><a href="#" onclick="z()">a</a></body>');
    expect(doc).not.toMatch(/\son[a-z]+=/i);
    expect(doc).not.toContain("data-ohi-removed-on");
  });
});

describe("buildSafeEmailDocument", () => {
  it("puts the Content-Security-Policy first, then no-referrer", () => {
    const doc = buildSafeEmailDocument("<p>Hello</p>");
    expect(doc.startsWith(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${EMAIL_CSP}">`)).toBe(true);
    expect(doc).toContain('<meta name="referrer" content="no-referrer">');
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf('name="referrer"'));
    expect(doc).toContain("<p>Hello</p>");
  });

  it("keeps the CSP ahead of the email's own head content", () => {
    const html = '<html lang="fr"><head><style>p{color:red}</style><link rel="stylesheet" href="https://x.example/a.css"></head><body><p>Bonjour</p></body></html>';
    const doc = buildSafeEmailDocument(html);
    const csp = doc.indexOf("Content-Security-Policy");
    expect(csp).toBeGreaterThan(0);
    expect(csp).toBeLessThan(doc.indexOf("p{color:red}"));
    // The email's stylesheet link is gone altogether (see renameStylesheetLinks).
    expect(doc).not.toContain("https://x.example/a.css");
    expect(doc).toMatch(/^<!doctype html><html lang="fr"><head><meta http-equiv="Content-Security-Policy"/);
  });

  it("blocks everything remote in its policy", () => {
    expect(EMAIL_CSP).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:");
  });

  it("drops the email's own http-equiv meta tags (refresh, policy) and base", () => {
    const html =
      '<head><meta http-equiv="refresh" content="0;url=https://evil.example"><META HTTP-EQUIV="Content-Security-Policy" content="default-src *"><base href="https://evil.example/"></head><body>Hi</body>';
    const doc = buildSafeEmailDocument(html);
    expect(doc).not.toMatch(/refresh/i);
    expect(doc).not.toContain("default-src *");
    expect(doc).not.toMatch(/<base/i);
    expect(doc.match(/http-equiv/gi)).toHaveLength(1);
  });

  it("drops scripts and event handlers", () => {
    const doc = buildSafeEmailDocument('<p onclick="steal()">Pay</p><script>parent.stolen = 1</script><img src="data:image/png;base64,AA" onerror="steal()">');
    expect(doc).not.toMatch(/<script/i);
    expect(doc).not.toContain("parent.stolen");
    expect(doc).not.toMatch(/onclick|onerror/i);
    expect(doc).toContain("<p>Pay</p>");
  });

  it("turns links into text that cannot be followed", () => {
    const doc = buildSafeEmailDocument('<a href="https://pay.example/now">Pay now</a><map><area href="https://x.example"></map>');
    const parsed = new DOMParser().parseFromString(doc, "text/html");
    expect(parsed.querySelectorAll("[href]")).toHaveLength(0);
    const link = parsed.querySelector("a");
    expect(link?.getAttribute(LINK_ADDRESS_ATTRIBUTE)).toBe("https://pay.example/now");
    expect(link?.getAttribute("title")).toBe("https://pay.example/now");
    expect(link?.textContent).toBe("Pay now");
  });
});

describe("remote image detection", () => {
  it.each([
    ['<img src="https://t.example/pixel.gif">', "https img"],
    ['<img src="http://t.example/pixel.gif">', "http img"],
    ['<img src="//t.example/pixel.gif">', "protocol-relative img"],
    ['<img srcset="data:image/png;base64,AA 1x, https://t.example/2x.png 2x">', "srcset"],
    ['<table background="https://t.example/bg.png"><tr><td>x</td></tr></table>', "background attribute"],
    ['<div style="background-image: url(\'https://t.example/bg.png\')">x</div>', "inline style url"],
    ["<style>.a{background:url(https://t.example/bg.png)}</style>", "style sheet url"],
  ])("finds %s (%s)", (html) => {
    expect(hasRemoteImages(html)).toBe(true);
  });

  it.each([
    ['<img src="data:image/png;base64,AA">', "data image"],
    ['<img src="cid:logo@bill">', "inline attachment"],
    ['<a href="https://pay.example">Pay</a>', "a plain link"],
    ["<p>See https://example.com/x.png</p>", "a URL in text"],
  ])("ignores %s (%s)", (html) => {
    expect(hasRemoteImages(html)).toBe(false);
  });

  it("returns the document and the flag together", () => {
    const result = prepareEmailHtml('<img src="https://t.example/a.png">');
    expect(result.remoteImages).toBe(true);
    expect(result.document).toContain("https://t.example/a.png");
    expect(result.document.indexOf("Content-Security-Policy")).toBeLessThan(result.document.indexOf("https://t.example/a.png"));
  });
});

describe("marking picked-out values", () => {
  /** The marks the server's reader would ask for in this HTML. */
  function marksOf(html: string) {
    const extraction = extract({ subject: "Bill", html, text: null });
    return { pieces: extraction.pieces, marks: marksFor(extraction) };
  }

  it("marks each label and value, across the email's own elements, without changing its text", () => {
    const html = "<table><tr><td>Amount   Billed:</td><td><b>$</b>4.13</td></tr><tr><td>Due Date: 11/04/2026</td></tr></table>";
    const result = prepareEmailHtml(html, marksOf(html));
    expect([result.marked, result.unmarked]).toEqual([4, 0]);
    const doc = new DOMParser().parseFromString(result.document, "text/html");
    const marks = [...doc.querySelectorAll("mark")].map((m) => [m.getAttribute(MARK_LABEL_ATTRIBUTE) ?? m.getAttribute(MARK_VALUE_ATTRIBUTE), m.textContent]);
    expect(marks).toEqual([
      ["Amount", "Amount   Billed"],
      ["Amount", "$"],
      ["Amount", "4.13"],
      ["Due date", "Due Date"],
      ["Due date", "11/04/2026"],
    ]);
    // The marks' style comes after everything of the email's; the email's text is unchanged.
    const style = doc.body.lastElementChild;
    expect(style?.tagName).toBe("STYLE");
    style?.remove();
    expect(doc.body.textContent).toBe("Amount   Billed:$4.13Due Date: 11/04/2026");
  });

  it("marks every copy of a repeated block", () => {
    const block = "<table><tr><td>Invoice Amount</td><td>$49.28</td></tr></table>";
    const html = block + block;
    const doc = new DOMParser().parseFromString(prepareEmailHtml(html, marksOf(html)).document, "text/html");
    expect([...doc.querySelectorAll(`mark[${MARK_VALUE_ATTRIBUTE}]`)].map((m) => m.textContent)).toEqual(["$49.28", "$49.28"]);
  });

  it("places no mark where its piece reads differently, and says so", () => {
    const html = "<p>Amount Due: $10.00</p>";
    const marks = marksOf(html);
    const result = prepareEmailHtml(html, { pieces: ["Amount Due: $99.00"], marks: marks.marks });
    expect([result.marked, result.unmarked]).toEqual([0, 2]);
    expect(result.document).not.toContain("<mark");
  });

  it("removes marks the email brought itself, so none can be faked", () => {
    const html = `<p><mark data-ohi-value="Amount">$1.00</mark> <span DATA-OHI-LABEL="x">hi</span></p>`;
    const result = prepareEmailHtml(html);
    expect(result.document).not.toMatch(/data-ohi-(value|label)/i);
    expect(result.document).not.toContain("::after");
  });

  it("adds nothing when asked for no marks", () => {
    const html = "<p>Amount Due: $10.00</p>";
    expect(prepareEmailHtml(html, { pieces: ["Amount Due: $10.00"], marks: [] })).toEqual(prepareEmailHtml(html));
  });
});
