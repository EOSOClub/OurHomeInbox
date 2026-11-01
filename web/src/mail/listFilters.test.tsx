// @vitest-environment jsdom
// The captured-mail list's search and filters on the page: the Filters panel,
// filters read from the page address, Clear filters, and coming back from an
// email to the list as it was left.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extract } from "../../../src/server/extraction";
import { checkSender } from "../../../src/server/sender";
import type { CaptureDetailResponse, CaptureListItem } from "../../../src/shared/api";
import type { Capture } from "../../../src/shared/capture";
import type { ExtractionSummary } from "../../../src/shared/extraction";
import { CaptureDetailPage } from "../pages/CaptureDetailPage";
import { CaptureListPage } from "../pages/CaptureListPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function makeCapture(uid: number, subject: string, day: string): Capture {
  return {
    version: 1,
    mailbox: "Proton bills",
    folder: "Folders/Bills",
    uidValidity: "1",
    uid,
    capturedAt: "2026-10-29T15:00:00Z",
    raw: { file: "message.eml", size: 100, sha256: "a".repeat(64) },
    messageId: null,
    subject,
    // Local noon, so the day holds in any time zone.
    date: `${day}T12:00:00`,
    from: [{ name: "City Water", address: "bills@water.example" }],
    to: [],
    cc: [],
    replyTo: [],
    headers: [],
    text: "Amount due: $42.10",
    html: null,
    attachments: [],
    links: [],
  };
}

const idOf = (capture: Capture) => `proton-bills/1/${capture.uid}`;
const summary = (more: Partial<ExtractionSummary>): ExtractionSummary => ({
  kind: "bill",
  amount: "42.10",
  dueDate: null,
  paidDate: null,
  dueNow: false,
  needsCheck: false,
  values: { amount: ["42.10"] },
  ...more,
});

// Newest first, as the server sends them.
const EMAILS: Array<{ capture: Capture; picked: ExtractionSummary; senderVerified: boolean }> = [
  { capture: makeCapture(3, "Final notice", "2026-10-20"), picked: summary({ dueNow: true }), senderVerified: true },
  { capture: makeCapture(2, "Payment reminder", "2026-10-10"), picked: summary({ kind: "reminder", needsCheck: true }), senderVerified: true },
  { capture: makeCapture(1, "Water bill", "2026-10-01"), picked: summary({}), senderVerified: false },
];

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubServer() {
  const item = ({ capture, picked, senderVerified }: (typeof EMAILS)[number]): CaptureListItem => ({
    id: idOf(capture),
    mailbox: "Proton bills",
    mailboxSlug: "proton-bills",
    folder: "Folders/Bills",
    uidValidity: "1",
    uid: capture.uid,
    subject: capture.subject,
    from: capture.from,
    date: capture.date,
    capturedAt: capture.capturedAt,
    attachmentCount: 0,
    linkCount: 0,
    hasText: true,
    hasHtml: false,
    biller: null,
    senderVerified,
    picked,
    tags: [],
    review: null,
  });
  const detail = (capture: Capture): CaptureDetailResponse => ({
    id: idOf(capture),
    mailboxSlug: "proton-bills",
    capture,
    biller: null,
    sender: checkSender(capture),
    invoice: null,
    extraction: extract(capture),
    tags: [],
    review: null,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      if (path === "/api/tags") return reply(200, { tags: [] });
      if (path === "/api/billers") return reply(200, { billers: [] });
      if (path === "/api/captures") return reply(200, { captures: EMAILS.map(item) });
      const one = EMAILS.find((e) => path === `/api/captures/${idOf(e.capture)}`);
      if (one) return reply(200, detail(one.capture));
      return reply(404, { error: "There is nothing here." });
    }),
  );
}

function show(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        {/* Stands in for the menu's Captured mail tab. */}
        <Link to="/">Menu: captured mail</Link>
        <Routes>
          <Route path="/" element={<CaptureListPage />} />
          <Route path="/mail/:mailbox/:uidValidity/:uid" element={<CaptureDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The subjects of the rows shown, top to bottom. */
function rows(): string[] {
  return within(screen.getByRole("list")).getAllByRole("listitem").map((li) => li.querySelector("p")?.textContent ?? "");
}

const count = () => screen.getAllByRole("status")[0]!.textContent;

describe("the captured-mail list's filters", () => {
  it("narrows by kind and the ticks behind Filters, and Clear filters shows everything again", async () => {
    stubServer();
    show("/");
    await screen.findByText("Water bill");
    expect(screen.queryByRole("region", { name: "More filters" })).toBeNull();

    const button = screen.getByRole("button", { name: /^Filters/ });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const panel = screen.getByRole("region", { name: "More filters" });

    fireEvent.change(within(panel).getByLabelText("Kind"), { target: { value: "bill" } });
    expect(rows()).toEqual(["Final notice", "Water bill"]);
    fireEvent.click(within(panel).getByRole("checkbox", { name: "Past due" }));
    expect(rows()).toEqual(["Final notice"]);
    expect(count()).toBe("Showing 1 of 3 emails");
    expect(button.textContent).toContain("2 on");

    fireEvent.click(within(panel).getByRole("checkbox", { name: "Needs a check" }));
    expect(screen.getByText("No captured email matches these filters.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(rows()).toEqual(["Final notice", "Payment reminder", "Water bill"]);
    expect(count()).toBe("3 emails");
    expect((within(panel).getByLabelText("Kind") as HTMLSelectElement).value).toBe("all");
    expect((within(panel).getByRole("checkbox", { name: "Past due" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("narrows to an unverified sender and to a range of days, and warns when the days are backwards", async () => {
    stubServer();
    show("/");
    await screen.findByText("Water bill");
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    const panel = screen.getByRole("region", { name: "More filters" });

    fireEvent.click(within(panel).getByRole("checkbox", { name: "Sender not verified" }));
    expect(rows()).toEqual(["Water bill"]);
    fireEvent.click(within(panel).getByRole("checkbox", { name: "Sender not verified" }));

    fireEvent.change(within(panel).getByLabelText("From"), { target: { value: "2026-10-05" } });
    fireEvent.change(within(panel).getByLabelText("To"), { target: { value: "2026-10-15" } });
    expect(rows()).toEqual(["Payment reminder"]);
    expect(within(panel).queryByText(/after the To day/)).toBeNull();

    fireEvent.change(within(panel).getByLabelText("From"), { target: { value: "2026-10-25" } });
    expect(within(panel).getByText("The From day is after the To day, so nothing can match.")).toBeTruthy();
  });

  it("opens with the filters a link asks for, the panel already open", async () => {
    stubServer();
    show("/?kind=reminder&check=1&q=payment");
    await screen.findByText("Payment reminder");
    const panel = screen.getByRole("region", { name: "More filters" });
    expect((within(panel).getByLabelText("Kind") as HTMLSelectElement).value).toBe("reminder");
    expect((within(panel).getByRole("checkbox", { name: "Needs a check" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("searchbox", { name: "Search captured mail" }) as HTMLInputElement).value).toBe("payment");
    expect(rows()).toEqual(["Payment reminder"]);
  });

  it("comes back from an email to the list with the same search and filters", async () => {
    stubServer();
    show("/");
    await screen.findByText("Water bill");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search captured mail" }), { target: { value: "notice" } });
    fireEvent.click(screen.getByRole("button", { name: "No biller" }));
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Past due" }));
    expect(rows()).toEqual(["Final notice"]);

    fireEvent.click(screen.getByText("Final notice"));
    fireEvent.click(await screen.findByRole("link", { name: "Back to captured mail" }));

    await screen.findByRole("searchbox", { name: "Search captured mail" });
    expect((screen.getByRole("searchbox", { name: "Search captured mail" }) as HTMLInputElement).value).toBe("notice");
    expect(screen.getByRole("button", { name: "No biller" }).getAttribute("aria-pressed")).toBe("true");
    // The panel opens again by itself, since one of its filters is on.
    expect((screen.getByRole("checkbox", { name: "Past due" }) as HTMLInputElement).checked).toBe(true);
    expect(rows()).toEqual(["Final notice"]);
  });

  it("shows the whole list again when the menu opens it while it is filtered", async () => {
    stubServer();
    show("/?q=notice&pastdue=1");
    await screen.findByText("Final notice");
    expect(rows()).toEqual(["Final notice"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search captured mail" }), { target: { value: "final" } });

    fireEvent.click(screen.getByRole("link", { name: "Menu: captured mail" }));
    expect((await screen.findByText("Water bill")).textContent).toBe("Water bill");
    expect(rows()).toEqual(["Final notice", "Payment reminder", "Water bill"]);
    expect((screen.getByRole("searchbox", { name: "Search captured mail" }) as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("checkbox", { name: "Past due" }) as HTMLInputElement).checked).toBe(false);
  });

  it("goes back to the whole list from an email opened some other way", async () => {
    stubServer();
    show("/mail/proton-bills/1/2");
    fireEvent.click(await screen.findByRole("link", { name: "Back to captured mail" }));
    await screen.findByText("Water bill");
    expect(rows()).toEqual(["Final notice", "Payment reminder", "Water bill"]);
  });
});
