// Getting the invoice behind an email's "View Invoice" link: which links,
// where a link may go, what comes back, the pass over captured mail, and the
// invoice in the API. The network is never used: `get` and `fetch` stand in.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extract } from "../../src/server/extraction.js";
import { fetchInvoice, guardedLookup, invoiceLink, invoicePass, isPublicAddress, linkProblem, MAX_ATTEMPTS, type FetchResult, type RawResponse } from "../../src/server/invoices.js";
import { readPdf } from "../../src/server/pdf.js";
import type { CaptureDetailResponse, CaptureListResponse } from "../../src/shared/api.js";
import type { InvoiceRecord } from "../../src/shared/invoice.js";
import { call, json, makeServer, saveEmail, setUp, testConfig, type TestServer } from "./helpers.js";

/** A one-page PDF with each text at its place (x, y from the bottom left), like a real invoice's layout. */
function pdfWith(texts: Array<[number, number, string]>): Buffer {
  const content = texts.map(([x, y, text]) => `BT /F1 10 Tf ${x} ${y} Td (${text}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Laid out like WM's invoice: labels above their values at the top, a label beside its value lower down. */
const INVOICE = pdfWith([
  [334, 743, "Customer ID:"],
  [495, 743, "12-34567-89012"],
  [272, 670, "Your Payment is Due"],
  [468, 670, "Your Total Due"],
  [269, 636, "Nov 4, 2026"],
  [473, 636, "$60.00"],
  [257, 193, "Total Due by"],
  // The real invoice leaves a wide gap here, so the date is a cell of its own.
  [330, 193, "11/04/2026"],
  [411, 193, "$60.00"],
]);

describe("reading a PDF", () => {
  it("cuts each line into cells and knows what is below each one", async () => {
    const read = await readPdf(new Uint8Array(INVOICE));
    expect(read?.pages).toBe(1);
    const { pieces, below, places } = read!.text;
    expect(pieces).toEqual([
      "Customer ID:",
      "12-34567-89012",
      "Your Payment is Due",
      "Your Total Due",
      "Nov 4, 2026",
      "$60.00",
      "Total Due by",
      "11/04/2026",
      "$60.00",
    ]);
    const under = (label: string) => pieces[below[pieces.indexOf(label)] ?? -1];
    expect([under("Your Payment is Due"), under("Your Total Due"), under("Total Due by")]).toEqual(["Nov 4, 2026", "$60.00", undefined]);
    expect(places[0]).toEqual({ page: 1, line: 0 });
    expect(places.at(-1)).toEqual({ page: 1, line: 3 });
  });

  it("keeps words a narrow gap apart in one cell", async () => {
    const read = await readPdf(new Uint8Array(pdfWith([[257, 193, "Total Due by"], [319, 193, "11/04/2026"]])));
    expect(read?.text.pieces).toEqual(["Total Due by 11/04/2026"]);
  });

  it("gives null for something that is not a PDF", async () => {
    expect(await readPdf(new Uint8Array(Buffer.from("%PDF-1.4 but not really")))).toBeNull();
  });

  it("lets the reader find values beside and below their labels", async () => {
    const { text } = (await readPdf(new Uint8Array(INVOICE)))!;
    const email = { subject: "Your invoice is ready", html: "<p>Invoice Amount: $60.00</p>", text: null };
    const plain = extract(email, [], text);
    expect(plain.fields.map((f) => [f.field, f.from, f.values.map((v) => v.value)])).toEqual([
      ["amount", "email", ["60.00"]],
      ["dueDate", "invoice", ["2026-11-04"]],
      ["accountNo", "invoice", ["12-34567-89012"]],
    ]);
    expect(plain.invoice?.pieces).toEqual(text.pieces);
    // A rule on the label above its value finds it there.
    const ruled = extract(email, [{ field: "dueDate", label: "Your Payment is Due" }], text);
    expect(ruled.fields.find((f) => f.field === "dueDate")).toMatchObject({ from: "invoice", by: "rule", values: [{ value: "2026-11-04", shown: "Nov 4, 2026" }] });
  });
});

describe("which link", () => {
  it("takes the first link whose words say it views an invoice, bill or statement", () => {
    const link = (text: string | null, url = "https://pay.example/x", source: "html" | "text" = "html") => ({ url, text, source });
    expect(invoiceLink([link("Pay now"), link("View Invoice", "https://a.example/1"), link("View bill")])?.url).toBe("https://a.example/1");
    for (const words of ["VIEW STATEMENT", "View Invoice or Pay Now", "Download your bill", "See your statements"]) {
      expect(invoiceLink([link(words)]), words).not.toBeNull();
    }
    expect(invoiceLink([link("Unsubscribe"), link("Billing questions"), link(null)])).toBeNull();
    expect(invoiceLink([link("View Invoice", "http://a.example/1")])).toBeNull();
    expect(invoiceLink([link("View Invoice", "https://a.example/1", "text")])).toBeNull();
  });
});

describe("where a link may go", () => {
  it.each([
    ["8.8.8.8", true],
    ["2606:4700::1111", true],
    ["10.1.2.3", false],
    ["172.20.0.1", false],
    ["192.168.1.1", false],
    ["127.0.0.1", false],
    ["169.254.169.254", false],
    ["100.64.0.1", false],
    ["0.0.0.0", false],
    ["::1", false],
    ["fd00::1", false],
    ["fe80::1", false],
    ["::ffff:192.168.1.1", false],
    ["::ffff:c0a8:101", false],
    ["::ffff:8.8.8.8", true],
    ["not an address", false],
  ])("%s is public: %s", (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });

  it.each([
    ["https://wmezpay.wm.com/invoice", null],
    ["http://wmezpay.wm.com/invoice", "it is not a secure (https) link"],
    ["https://user:pw@wm.com/", "it has a name or password in it"],
    ["https://wm.com:8443/", "it uses an unusual port"],
    ["https://192.168.1.10/", "it leads to an address on a private network"],
    ["https://[::1]/", "it leads to an address on a private network"],
    ["https://localhost/", "it leads to this computer or the home network"],
    ["https://nas.local/", "it leads to this computer or the home network"],
  ])("%s", (url, problem) => {
    expect(linkProblem(new URL(url))).toBe(problem);
  });

  it("refuses a name that leads to this computer when connecting", async () => {
    const error = await new Promise<Error | null>((done) => guardedLookup("localhost", {}, (err) => done(err)));
    expect(error?.message).toMatch(/private network/);
  });
});

describe("opening a link", () => {
  const reply = (status: number, headers: Record<string, string> = {}, body: Buffer | string = ""): RawResponse => ({
    status,
    headers,
    body: Buffer.isBuffer(body) ? body : Buffer.from(body),
  });

  it("follows the click tracker's redirect to the PDF and reads it", async () => {
    const get = vi.fn(async (url: URL) =>
      url.hostname === "u1.ct.sendgrid.example" ? reply(302, { location: "https://wmezpay.wm.example/pdf?id=1" }) : reply(200, { "content-type": "application/pdf" }, INVOICE),
    );
    const got = await fetchInvoice("https://u1.ct.sendgrid.example/ss/c/abc", get);
    expect(got).toMatchObject({ outcome: "saved", host: "wmezpay.wm.example", pages: 1, retry: false });
    expect(got.pdf?.equals(INVOICE)).toBe(true);
    expect(got.text?.pieces).toContain("Total Due by");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["to a plain http address", { location: "http://wm.example/pdf" }, "it is not a secure (https) link"],
    ["to the home network", { location: "https://192.168.1.1/admin" }, "it leads to an address on a private network"],
    ["to this computer", { location: "https://localhost/" }, "it leads to this computer or the home network"],
  ])("will not be sent on %s", async (_label, headers, detail) => {
    const get = vi.fn(async (url: URL) => (url.hostname === "start.example" ? reply(302, headers) : reply(200, {}, INVOICE)));
    expect(await fetchInvoice("https://start.example/", get)).toMatchObject({ outcome: "blocked", detail });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("stops after a few redirects", async () => {
    let n = 0;
    const get = vi.fn(async () => reply(302, { location: `https://hop${++n}.example/` }));
    expect(await fetchInvoice("https://start.example/", get)).toMatchObject({ outcome: "blocked", detail: "it sent the request on too many times" });
    expect(get).toHaveBeenCalledTimes(6);
  });

  it.each([
    ["a sign-in page", reply(200, { "content-type": "text/html" }, '<form><input type="password" name="pw"></form>'), "sign-in", false],
    ["a sign-in title", reply(200, { "content-type": "text/html; charset=utf-8" }, "<title>Sign In | Midco</title>"), "sign-in", false],
    ["another web page", reply(200, { "content-type": "text/html" }, "<p>Your bill</p>"), "not-pdf", false],
    ["an image", reply(200, { "content-type": "image/png" }, "png"), "not-pdf", false],
    ["a broken PDF", reply(200, { "content-type": "application/pdf" }, "%PDF-1.4 nothing"), "unreadable", false],
    ["a gone link", reply(404), "failed", false],
    ["a server error", reply(503), "failed", true],
  ])("says what it got for %s", async (_label, response, outcome, retry) => {
    expect(await fetchInvoice("https://start.example/", async () => response)).toMatchObject({ outcome, retry });
  });

  it("says when the site could not be reached, and tries again later", async () => {
    const get = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    };
    expect(await fetchInvoice("https://gone.example/", get)).toMatchObject({ outcome: "failed", detail: "gone.example could not be found", retry: true });
  });
});

// ---- The pass over captured mail, and the API -------------------------------

let server: TestServer;
let cookie: string;

beforeEach(async () => {
  server = makeServer();
  cookie = await setUp(server.app);
});

afterEach(() => {
  server.close();
});

/** A WM invoice email as the Bridge gives it: Proton's verdict under its Received lines, and a View Invoice link. */
function wmEmail(dmarc = "pass"): Buffer {
  return Buffer.from(
    [
      "From: WM <noreply@wm.example>",
      "To: sam@proton.me",
      "Subject: Your invoice is ready",
      "Date: Mon, 05 Oct 2026 09:00:00 +0000",
      "Received: by mailin.protonmail.ch",
      `Authentication-Results: mail.protonmail.ch; dmarc=${dmarc} (p=reject dis=none) header.from=wm.example`,
      "Content-Type: text/html",
      "",
      '<p>Invoice Amount: $60.00</p><p><a href="https://u1.ct.sendgrid.example/ss/c/abc">View Invoice</a></p>',
      "",
    ].join("\r\n"),
  );
}

async function addWm(fetchInvoices = true): Promise<number> {
  const res = await call(server.app, "/api/billers", { method: "POST", cookie, body: { name: "WM", kind: "bill", senders: ["wm.example"], fetchInvoices } });
  return ((await res.json()) as { id: number }).id;
}

const saved = async (): Promise<FetchResult> => {
  const read = (await readPdf(new Uint8Array(INVOICE)))!;
  return { outcome: "saved", detail: "", host: "wmezpay.wm.example", retry: false, pdf: INVOICE, text: read.text, pages: read.pages };
};

describe("the invoice pass", () => {
  const run = (fetch: (link: string) => Promise<FetchResult>) =>
    invoicePass({ config: testConfig(), store: server.store, db: server.db, fetch, now: () => new Date("2026-10-30T12:00:00Z") });

  it("gets the invoice once for a confirmed sender with the switch on, and shows it", async () => {
    await addWm();
    await saveEmail(server.store, wmEmail(), { uid: 1 });
    const fetch = vi.fn(saved);
    expect(await run(fetch)).toEqual({ tried: 1, saved: 1 });
    expect(fetch).toHaveBeenCalledWith("https://u1.ct.sendgrid.example/ss/c/abc");
    expect(await run(fetch)).toEqual({ tried: 0, saved: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);

    const dir = server.store.messageDir("Proton bills", "1700000000", 1);
    const record = JSON.parse(readFileSync(join(dir, "invoice.json"), "utf8")) as InvoiceRecord;
    expect(record).toMatchObject({ outcome: "saved", linkText: "View Invoice", host: "wmezpay.wm.example", attempts: 3, file: "invoice.pdf", pages: 1 });
    expect(record.reason).toBe('Got the invoice (a 1-page PDF) from the email\'s "View Invoice" link at wmezpay.wm.example.');
    expect(readFileSync(join(dir, "invoice.pdf")).equals(INVOICE)).toBe(true);

    const detail = await json<CaptureDetailResponse>(await call(server.app, "/api/captures/proton-bills/1700000000/1", { cookie }));
    expect(detail.invoice).toMatchObject({ outcome: "saved", file: "invoice.pdf" });
    expect(detail.invoice).not.toHaveProperty("text");
    expect(detail.invoice).not.toHaveProperty("url");
    expect(detail.extraction.fields.find((f) => f.field === "dueDate")).toMatchObject({ from: "invoice", values: [{ value: "2026-11-04" }] });
    const list = await json<CaptureListResponse>(await call(server.app, "/api/captures", { cookie }));
    expect(list.captures[0]!.picked).toMatchObject({ amount: "60.00", dueDate: "2026-11-04" });

    const pdf = await call(server.app, "/api/captures/proton-bills/1700000000/1/invoice", { cookie });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("Content-Disposition")).toBe(`attachment; filename="invoice-1.pdf"; filename*=UTF-8''invoice-1.pdf`);
    expect(Buffer.from(await pdf.arrayBuffer()).equals(INVOICE)).toBe(true);
  });

  it("does not open the link when the sender is not confirmed, the switch is off, or there is no biller", async () => {
    await saveEmail(server.store, wmEmail(), { uid: 1 });
    const fetch = vi.fn(saved);
    expect(await run(fetch)).toEqual({ tried: 0, saved: 0 });
    const id = await addWm(false);
    expect(await run(fetch)).toEqual({ tried: 0, saved: 0 });
    await call(server.app, `/api/billers/${id}`, { method: "PUT", cookie, body: { name: "WM", kind: "bill", senders: ["wm.example"], fetchInvoices: true } });
    await saveEmail(server.store, wmEmail("fail"), { uid: 2 });
    expect(await run(fetch)).toEqual({ tried: 1, saved: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await json<CaptureDetailResponse>(await call(server.app, "/api/captures/proton-bills/1700000000/2", { cookie }))).invoice).toBeNull();
    expect((await call(server.app, "/api/captures/proton-bills/1700000000/2/invoice", { cookie })).status).toBe(404);
  });

  it("tries a link that failed for a passing reason again, a few times in all", async () => {
    await addWm();
    await saveEmail(server.store, wmEmail(), { uid: 1 });
    const failing = vi.fn(async (): Promise<FetchResult> => ({ outcome: "failed", detail: "the site answered with error 503", host: "wm.example", retry: true, pdf: null, text: null, pages: null }));
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) await run(failing);
    expect(failing).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    const detail = await json<CaptureDetailResponse>(await call(server.app, "/api/captures/proton-bills/1700000000/1", { cookie }));
    expect(detail.invoice).toMatchObject({ outcome: "failed", attempts: 3, file: null });
    expect(detail.invoice?.reason).toBe('The email\'s "View Invoice" link did not work: the site answered with error 503. It was tried 3 times.');
  });
});
