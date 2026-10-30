import { describe, expect, it } from "vitest";
import { buildCapture, htmlLinks, safeFileName, textLinks, type CaptureSource } from "../src/capture.js";

const SOURCE: CaptureSource = {
  mailbox: "Proton bills",
  folder: "Folders/Bills",
  uidValidity: "1700000000",
  uid: 42,
  capturedAt: new Date("2026-10-29T12:00:00Z"),
};

/** A made-up bill: text and HTML bodies, links, and a PDF whose name tries to escape its folder. */
const BILL = [
  "Message-ID: <bill-42@electric.example>",
  "Date: Tue, 27 Oct 2026 09:30:00 -0500",
  'From: "City Electric" <billing@electric.example>',
  "To: bills@home.example",
  "Subject: Your October bill is ready",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="mixed"',
  "",
  "--mixed",
  'Content-Type: multipart/alternative; boundary="alt"',
  "",
  "--alt",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Amount due: $84.20",
  "Pay at https://pay.electric.example/account/42 or see https://electric.example/bill.",
  "--alt",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<p>Amount due: <b>$84.20</b></p><a href="https://electric.example/bill?id=42&amp;v=1">View   your',
  'bill</a> <a href="mailto:help@electric.example">Help</a>',
  '<a href=" https://electric.example/bill?id=42&amp;v=1 ">View your bill</a>',
  "--alt--",
  "--mixed",
  'Content-Type: application/pdf; name="bill.pdf"',
  'Content-Disposition: attachment; filename="../../etc/October bill.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0xLjQKJcOkw7zDtsOfCg==",
  "--mixed--",
  "",
].join("\r\n");

describe("buildCapture", () => {
  it("keeps where the message came from and the raw email's size and hash", async () => {
    const raw = Buffer.from(BILL);
    const { capture } = await buildCapture(raw, SOURCE);
    expect(capture).toMatchObject({
      version: 1,
      mailbox: "Proton bills",
      folder: "Folders/Bills",
      uidValidity: "1700000000",
      uid: 42,
      capturedAt: "2026-10-29T12:00:00.000Z",
      raw: { file: "message.eml", size: raw.length },
    });
    expect(capture.raw.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reads the envelope fields", async () => {
    const { capture } = await buildCapture(Buffer.from(BILL), SOURCE);
    expect(capture.messageId).toBe("<bill-42@electric.example>");
    expect(capture.subject).toBe("Your October bill is ready");
    expect(capture.date).toBe("2026-10-27T14:30:00.000Z");
    expect(capture.from).toEqual([{ name: "City Electric", address: "billing@electric.example" }]);
    expect(capture.to).toEqual([{ name: "", address: "bills@home.example" }]);
    expect(capture.cc).toEqual([]);
  });

  it("keeps every header line as received, in order", async () => {
    const { capture } = await buildCapture(Buffer.from(BILL), SOURCE);
    expect(capture.headers.map((h) => h.name)).toEqual([
      "message-id",
      "date",
      "from",
      "to",
      "subject",
      "mime-version",
      "content-type",
    ]);
    expect(capture.headers[2]?.line).toBe('From: "City Electric" <billing@electric.example>');
  });

  it("keeps both bodies exactly as sent", async () => {
    const { capture } = await buildCapture(Buffer.from(BILL), SOURCE);
    expect(capture.text).toContain("Amount due: $84.20");
    expect(capture.html).toContain("<b>$84.20</b>");
  });

  it("saves the attachment under a safe name and records the name the sender gave", async () => {
    const { capture, attachments } = await buildCapture(Buffer.from(BILL), SOURCE);
    expect(capture.attachments).toEqual([
      {
        file: "attachments/1-October bill.pdf",
        filename: "../../etc/October bill.pdf",
        contentType: "application/pdf",
        disposition: "attachment",
        contentId: null,
        size: attachments[0]?.content.length,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    expect(attachments[0]?.content.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("finds every link once, with its text and the body it came from", async () => {
    const { capture } = await buildCapture(Buffer.from(BILL), SOURCE);
    expect(capture.links).toEqual([
      { url: "https://electric.example/bill?id=42&v=1", text: "View your bill", source: "html" },
      { url: "mailto:help@electric.example", text: "Help", source: "html" },
      { url: "https://pay.electric.example/account/42", text: null, source: "text" },
      { url: "https://electric.example/bill", text: null, source: "text" },
    ]);
  });

  it("does not make up an HTML body for a text-only email", async () => {
    const raw = "From: a@b.example\r\nSubject: Paid\r\nContent-Type: text/plain\r\n\r\nThanks for paying.\r\n";
    const { capture } = await buildCapture(Buffer.from(raw), SOURCE);
    expect(capture.text).toContain("Thanks for paying.");
    expect(capture.html).toBeNull();
  });

  it("does not make up a text body for an HTML-only email", async () => {
    const raw = "From: a@b.example\r\nSubject: Paid\r\nContent-Type: text/html\r\n\r\n<p>Thanks for paying.</p>\r\n";
    const { capture } = await buildCapture(Buffer.from(raw), SOURCE);
    expect(capture.html).toContain("<p>Thanks for paying.</p>");
    expect(capture.text).toBeNull();
  });

  it("copes with a message missing every optional header", async () => {
    const { capture } = await buildCapture(Buffer.from("\r\nhello\r\n"), SOURCE);
    expect(capture).toMatchObject({ messageId: null, subject: null, date: null, from: [], attachments: [] });
  });
});

describe("safeFileName", () => {
  it.each([
    ["../../etc/passwd", "passwd"],
    ["..\\..\\Windows\\bill.pdf", "bill.pdf"],
    ["bill:2026?.pdf", "bill_2026_.pdf"],
    ["...hidden", "hidden"],
    ["trailing. ", "trailing"],
    ["", "attachment"],
    [". . .", "attachment"],
    ["..", "attachment"],
  ])("%j becomes %j", (name, expected) => {
    expect(safeFileName(name)).toBe(expected);
  });

  it("keeps names to 100 characters", () => {
    expect(safeFileName(`${"a".repeat(200)}.pdf`)).toHaveLength(100);
  });
});

describe("link finding", () => {
  it("keeps an unclosed link at the end of the HTML", () => {
    expect(htmlLinks('<a href="https://x.example/pay">Pay now')).toEqual([
      { url: "https://x.example/pay", text: "Pay now", source: "html" },
    ]);
  });

  it("ignores anchors without an href", () => {
    expect(htmlLinks('<a name="top">Top</a>')).toEqual([]);
  });

  it("does not guess links from bare words in the text", () => {
    expect(textLinks("See invoice.pdf or example.com for details")).toEqual([]);
  });
});
