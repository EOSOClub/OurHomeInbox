// @vitest-environment jsdom
// Renders one captured email with a made-up capture and checks the top
// section, the tabs (roles and arrow keys), each panel, and that the HTML
// only ever appears inside an iframe with an empty sandbox.

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BillerMatch, CaptureDetailResponse } from "../../../src/shared/api";
import type { Capture } from "../../../src/shared/capture";
import { extract } from "../../../src/server/extraction";
import { checkSender } from "../../../src/server/sender";
import { CaptureDetailView } from "./CaptureDetailView";
import { SafeEmailFrame } from "./SafeEmailFrame";

afterEach(cleanup);

const SHA = "a".repeat(64);

function makeCapture(overrides: Partial<Capture> = {}): Capture {
  return {
    version: 1,
    mailbox: "Proton bills",
    folder: "Folders/Bills",
    uidValidity: "123",
    uid: 45,
    capturedAt: "2026-10-29T15:00:00Z",
    raw: { file: "message.eml", size: 2048, sha256: SHA },
    messageId: "<abc@water.example>",
    subject: "Your water bill",
    date: "2026-10-28T09:30:00Z",
    from: [{ name: "City Water", address: "bills@water.example" }],
    to: [{ name: "", address: "home@proton.example" }],
    cc: [],
    replyTo: [{ name: "Help", address: "help@water.example" }],
    headers: [
      { name: "from", line: "From: City Water <bills@water.example>" },
      { name: "subject", line: "Subject: Your water bill" },
      { name: "received", line: "Received: from mx\r\n\tby proton" },
    ],
    text: "Amount due: $42.10\nDue: Nov 5",
    html: '<p>Amount due: <b>$42.10</b></p><img src="https://t.example/pixel.gif"><script>parent.hacked = true</script>',
    attachments: [
      { file: "attachments/1.pdf", filename: "bill.pdf", contentType: "application/pdf", disposition: "attachment", contentId: null, size: 1536, sha256: "b".repeat(64) },
      { file: "attachments/2.bin", filename: null, contentType: "image/png", disposition: "inline", contentId: "logo", size: 10, sha256: "c".repeat(64) },
    ],
    links: [
      { url: "https://pay.water.example/now", text: "Pay now", source: "html" },
      { url: "https://water.example/unsubscribe", text: null, source: "text" },
    ],
    ...overrides,
  };
}

function detail(capture: Capture, biller: BillerMatch | null = null): CaptureDetailResponse {
  // The server's own reader, so the picks match what the API would send.
  return { id: "proton-bills/123/45", mailboxSlug: "proton-bills", capture, biller, sender: checkSender(capture), invoice: null, extraction: extract(capture) };
}

function openTab(name: string) {
  fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${name}`) }));
  return screen.getByRole("tabpanel");
}

describe("CaptureDetailView", () => {
  it("shows the top section", () => {
    render(<CaptureDetailView detail={detail(makeCapture())} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Your water bill");
    const text = document.querySelector("dl")?.textContent ?? "";
    expect(text).toContain("City Water <bills@water.example>");
    expect(text).toContain("home@proton.example");
    expect(text).toContain("Help <help@water.example>");
    expect(text).toContain("Proton bills, folder Folders/Bills");
    expect(text).toContain("<abc@water.example>");
    expect(text).not.toContain("Cc");
    expect(text).toContain("No biller matches this sender yet");
  });

  it("shows the matched biller and what it matched on", () => {
    render(<CaptureDetailView detail={detail(makeCapture(), { id: 3, name: "City Water", kind: "bill", matchedOn: "water.example" })} />);
    const text = document.querySelector("dl")?.textContent ?? "";
    expect(text).toContain("BillerCity WaterMatched on water.example");
  });

  it("uses tab roles and moves with the arrow keys", () => {
    render(<CaptureDetailView detail={detail(makeCapture())} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Email", "Text", "HTML source", "Headers3", "Attachments2", "Links2", "Raw email"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.getAttribute("tabindex")).toBe("-1");

    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[1]);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(tabs[1]?.id);

    fireEvent.keyDown(tabs[1]!, { key: "ArrowLeft" });
    fireEvent.keyDown(tabs[0]!, { key: "ArrowLeft" });
    expect(tabs[6]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tabs[6]!, { key: "Home" });
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("shows the HTML only in an empty-sandbox iframe, with remote images blocked", () => {
    render(<CaptureDetailView detail={detail(makeCapture())} />);
    const panel = screen.getByRole("tabpanel");
    const frame = panel.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame?.getAttribute("srcdoc")).toContain("Content-Security-Policy");
    expect(frame?.getAttribute("srcdoc")).not.toContain("parent.hacked");
    expect(panel.textContent).toContain("Remote images are blocked to protect your privacy.");
    // Nothing from the email is put into the page itself.
    expect(document.body.querySelector("b")).toBeNull();
  });

  it("falls back to the text body when there is no HTML", () => {
    render(<CaptureDetailView detail={detail(makeCapture({ html: null }))} />);
    const panel = screen.getByRole("tabpanel");
    expect(panel.querySelector("iframe")).toBeNull();
    expect(panel.querySelector("pre")?.textContent).toBe("Amount due: $42.10\nDue: Nov 5");
    // The picked-out amount and its label are marked in the text.
    expect([...panel.querySelectorAll("pre mark")].map((m) => m.textContent)).toEqual(["Amount due", "$42.10"]);
    fireEvent.click(within(panel).getByRole("checkbox", { name: "Mark the picked-out values" }));
    expect(panel.querySelectorAll("pre mark")).toHaveLength(0);
  });

  it("says what was picked out, where, and marks it in the email", () => {
    render(<CaptureDetailView detail={detail(makeCapture())} />);
    const picked = screen.getByRole("region", { name: "Picked out" });
    expect(picked.textContent).toContain("Bill");
    expect(picked.textContent).toContain("It has an amount to pay.");
    const rows = [...picked.querySelectorAll("dl > div")].map((row) => row.textContent);
    expect(rows[0]).toContain("Amount$42.10");
    expect(rows[0]).toContain('Found after "Amount due"');
    // A bill is expected to have a due date; the email's "Due: Nov 5" has no year, so it is not one.
    expect(rows[1]).toBe("Due dateNot found in this email");
    expect([...picked.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["Amount due", "$42.10"]);

    const panel = screen.getByRole("tabpanel");
    const srcdoc = () => panel.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
    expect(srcdoc()).toContain('<mark data-ohi-label="Amount">Amount due</mark>');
    expect(srcdoc()).toContain('<mark data-ohi-value="Amount">$42.10</mark>');
    fireEvent.click(within(panel).getByRole("checkbox", { name: "Mark the picked-out values" }));
    expect(srcdoc()).not.toContain("<mark");
  });

  it("points out a reminder, a credit and a value the email disagrees with itself on", () => {
    const html = "<p>Second Notice</p><p>Amount Due: ($5.00)</p><p>Due Date: 11/04/2026</p><p>Due Date: 11/05/2026</p>";
    render(<CaptureDetailView detail={detail(makeCapture({ html, text: null }))} />);
    const picked = screen.getByRole("region", { name: "Picked out" });
    expect(picked.textContent).toContain('The email says "Second Notice".');
    expect(picked.textContent).toContain("A reminder of a bill already sent.");
    expect(picked.textContent).toContain("This is a credit: nothing is owed.");
    expect(picked.textContent).toContain("This email gives more than one due date: Nov 4, 2026 and Nov 5, 2026.");
  });

  it("shows the invoice its link gave, with the values picked from it marked there and not in the email", () => {
    const invoiceText = {
      pieces: ["Customer ID:", "12-34567-89012", "Total Due by", "11/04/2026"],
      places: [
        { page: 1, line: 0 },
        { page: 1, line: 0 },
        { page: 1, line: 1 },
        { page: 1, line: 1 },
      ],
      below: [null, null, null, null],
    };
    const capture = makeCapture();
    const view: CaptureDetailResponse = {
      ...detail(capture),
      extraction: extract(capture, [], invoiceText),
      invoice: {
        outcome: "saved",
        reason: 'Got the invoice (a 1-page PDF) from the email\'s "View Invoice" link at wmezpay.wm.example.',
        linkText: "View Invoice",
        host: "wmezpay.wm.example",
        triedAt: "2026-10-30T12:00:00Z",
        attempts: 3,
        file: "invoice.pdf",
        size: 2048,
        sha256: "d".repeat(64),
        pages: 1,
      },
    };
    render(<CaptureDetailView detail={view} />);
    const picked = screen.getByRole("region", { name: "Picked out" });
    const rows = [...picked.querySelectorAll("dl > div")].map((row) => row.textContent);
    expect(rows[1]).toContain('Due dateNov 4, 2026Found after "Total Due by" in the invoiceIn the invoice: Total Due by|11/04/2026');
    expect(picked.textContent).toContain("Values found in the invoice are marked in the Invoice tab.");
    const srcdoc = screen.getByRole("tabpanel").querySelector("iframe")?.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain('data-ohi-value="Amount"');
    expect(srcdoc).not.toContain('data-ohi-value="Due date"');

    const panel = openTab("Invoice");
    expect(panel.textContent).toContain('Got the invoice (a 1-page PDF) from the email\'s "View Invoice" link at wmezpay.wm.example.');
    expect(within(panel).getByRole("link", { name: /Download the invoice/ }).getAttribute("href")).toBe("/api/captures/proton-bills/123/45/invoice");
    const text = within(panel).getByLabelText("The invoice's text");
    expect(text.textContent).toBe("Page 1\nCustomer ID:    12-34567-89012\nTotal Due by    11/04/2026");
    expect([...text.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["Customer ID", "12-34567-89012", "Total Due by", "11/04/2026"]);
  });

  it("says a past due bill is due now, keeps the printed date, and marks the words in the email", () => {
    const html = "<p>Your account is Past Due. Please pay immediately.</p><p>Amount Due: $62.00</p><p>Due Date: 11/04/2026</p>";
    render(<CaptureDetailView detail={detail(makeCapture({ html, text: null }))} />);
    const picked = screen.getByRole("region", { name: "Picked out" });
    expect(picked.textContent).toContain('This bill is past due: the email says "Your account is Past Due". It is due now.');
    const due = [...picked.querySelectorAll("dl > div")].find((r) => r.querySelector("dt")?.textContent === "Due date")!.textContent;
    expect(due).toContain('Due dateDue now (past due)The email says "Your account is Past Due".');
    expect(due).toContain("It also gives a date:Nov 4, 2026");
    const srcdoc = screen.getByRole("tabpanel").querySelector("iframe")?.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain('<mark data-ohi-value="Past due">Your account is Past Due</mark>');
  });

  it("does not call a past due bill's missing due date missing", () => {
    render(<CaptureDetailView detail={detail(makeCapture({ html: "<p>Past Due</p><p>Amount Due: $62.00</p>", text: null }))} />);
    const picked = screen.getByRole("region", { name: "Picked out" });
    expect(picked.textContent).not.toContain("Not found in this email");
    expect(picked.textContent).toContain('Due now (past due)The email says "Past Due".');
  });

  it("has no Invoice tab when no invoice was got", () => {
    render(<CaptureDetailView detail={detail(makeCapture())} />);
    expect(screen.queryByRole("tab", { name: /^Invoice/ })).toBeNull();
  });

  it("says whether the mail provider confirmed the sender", () => {
    render(<CaptureDetailView detail={detail(makeCapture())} />);
    const row = () => [...document.querySelectorAll("dl > div")].find((r) => r.querySelector("dt")?.textContent === "Sender check")!.textContent;
    expect(row()).toBe("Sender checkNot verifiedProton left no verdict on this email, so who sent it cannot be checked.");
    cleanup();

    const headers = [
      { name: "received", line: "Received: by mailin.protonmail.ch" },
      { name: "authentication-results", line: "Authentication-Results: mail.protonmail.ch; dmarc=pass (p=reject dis=none) header.from=water.example" },
    ];
    render(<CaptureDetailView detail={detail(makeCapture({ headers }))} />);
    expect(row()).toBe("Sender checkReally from water.exampleProton checked that this email really comes from water.example.");
  });

  it("says when nothing was picked out", () => {
    render(<CaptureDetailView detail={detail(makeCapture({ html: "<p>Hello</p>", text: null, subject: "Hi" }))} />);
    const picked = screen.getByRole("region", { name: "Picked out" });
    expect(picked.textContent).toContain("Statement");
    expect(picked.textContent).toContain("Nothing was picked out of this email.");
    expect(within(screen.getByRole("tabpanel")).queryByRole("checkbox")).toBeNull();
  });

  it("shows the text body, or says there is none", () => {
    render(<CaptureDetailView detail={detail(makeCapture())} />);
    expect(openTab("Text").querySelector("pre")?.textContent).toBe("Amount due: $42.10\nDue: Nov 5");
    cleanup();
    render(<CaptureDetailView detail={detail(makeCapture({ text: null }))} />);
    expect(openTab("Text").textContent).toContain("This email has no plain text part.");
  });

  it("shows the HTML source as text, never rendered", () => {
    render(<CaptureDetailView detail={detail(makeCapture())} />);
    const panel = openTab("HTML source");
    expect(panel.querySelector("pre")?.textContent).toContain("<script>parent.hacked = true</script>");
    expect(panel.querySelector("b")).toBeNull();
    expect(panel.querySelector("script")).toBeNull();
  });

  it("lists every header line in order", () => {
    render(<CaptureDetailView detail={detail(makeCapture())} />);
    const lines = Array.from(openTab("Headers").querySelectorAll("li pre")).map((el) => el.textContent);
    expect(lines).toEqual(["From: City Water <bills@water.example>", "Subject: Your water bill", "Received: from mx\r\n\tby proton"]);
  });

  it("lists attachments with sizes, short fingerprints and download links", () => {
    render(<CaptureDetailView detail={detail(makeCapture())} />);
    const panel = openTab("Attachments");
    const items = within(panel).getAllByRole("listitem");
    expect(items[0]?.textContent).toContain("bill.pdf");
    expect(items[0]?.textContent).toContain("application/pdf, 1.5 KB");
    expect(items[0]?.querySelector("code")?.textContent).toBe("b".repeat(12));
    expect(items[0]?.querySelector("code")?.getAttribute("title")).toBe("b".repeat(64));
    expect(items[1]?.textContent).toContain("(no name)");
    const downloads = within(panel).getAllByRole("link");
    expect(downloads.map((a) => a.getAttribute("href"))).toEqual([
      "/api/captures/proton-bills/123/45/attachments/1",
      "/api/captures/proton-bills/123/45/attachments/2",
    ]);
  });

  it("shows links as text that cannot be clicked", () => {
    render(<CaptureDetailView detail={detail(makeCapture())} />);
    const panel = openTab("Links");
    expect(within(panel).queryAllByRole("link")).toHaveLength(0);
    expect(panel.querySelector("a")).toBeNull();
    expect(panel.textContent).toContain("https://pay.water.example/now");
    expect(panel.textContent).toContain("Link text: Pay now");
    expect(panel.textContent).toContain("Found in the HTML version");
    expect(panel.textContent).toContain("Found in the plain text version");
    expect(within(panel).getAllByRole("button", { name: /^Copy link/ })).toHaveLength(2);
  });

  it("offers the raw email with its size and fingerprint", () => {
    render(<CaptureDetailView detail={detail(makeCapture())} />);
    const panel = openTab("Raw email");
    expect(panel.textContent).toContain("2 KB");
    expect(panel.textContent).toContain(SHA);
    expect(within(panel).getByRole("link").getAttribute("href")).toBe("/api/captures/proton-bills/123/45/raw");
  });
});

describe("SafeEmailFrame", () => {
  it("has no remote-image notice when the email loads nothing remote", () => {
    render(<SafeEmailFrame html="<p>Plain</p>" title="Email: test" />);
    const frame = screen.getByTitle("Email: test");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(screen.queryByText(/Remote images are blocked/)).toBeNull();
  });
});
