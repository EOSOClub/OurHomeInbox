// @vitest-environment jsdom
// Review on the pages: marking an email checked or not a bill on its page,
// marking several from the list, the shortcut and filter for what is still to
// review, and "Needs a check" going away once a person has looked.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extract } from "../../../src/server/extraction";
import { checkSender } from "../../../src/server/sender";
import type { CaptureDetailResponse, CaptureListItem, CaptureReview, CaptureReviewRequest } from "../../../src/shared/api";
import type { Capture } from "../../../src/shared/capture";
import { CaptureDetailPage } from "../pages/CaptureDetailPage";
import { CaptureListPage } from "../pages/CaptureListPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function makeCapture(uid: number, subject: string): Capture {
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
    date: `2026-10-${String(10 + uid).padStart(2, "0")}T12:00:00`,
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
// Newest first, as the server sends them. The reminder's values need a check.
const CAPTURES = [makeCapture(3, "Water bill"), makeCapture(2, "Payment reminder"), makeCapture(1, "Newsletter")];

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A stand-in server that remembers marks; `failWith` makes the next mark fail with that message. */
function stubServer(options: { failWith?: string } = {}) {
  const reviews = new Map<string, CaptureReview>();
  const sent: CaptureReviewRequest[] = [];
  let failWith = options.failWith;
  const item = (capture: Capture): CaptureListItem => ({
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
    senderVerified: true,
    picked: { kind: "bill", amount: "42.10", dueDate: null, paidDate: null, dueNow: false, needsCheck: capture.uid === 2 },
    tags: [],
    review: reviews.get(idOf(capture)) ?? null,
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
    review: reviews.get(idOf(capture)) ?? null,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/tags") return reply(200, { tags: [] });
      if (path === "/api/billers") return reply(200, { billers: [] });
      if (path === "/api/captures") return reply(200, { captures: CAPTURES.map(item) });
      if (path === "/api/captures/review" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as CaptureReviewRequest;
        sent.push(body);
        if (failWith) {
          const message = failWith;
          failWith = undefined;
          return reply(404, { error: message });
        }
        for (const id of body.captureIds) {
          if (body.state === null) reviews.delete(id);
          else if (reviews.get(id)?.state !== body.state) reviews.set(id, { state: body.state, by: "Sam Smith", at: "2026-10-30T12:00:00Z" });
        }
        return reply(200, { captures: body.captureIds.map((id) => ({ id, review: reviews.get(id) ?? null })) });
      }
      const one = CAPTURES.find((c) => path === `/api/captures/${idOf(c)}`);
      if (one) return reply(200, detail(one));
      return reply(404, { error: "There is nothing here." });
    }),
  );
  return { sent };
}

function show(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
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

/** The row (list item) for a subject. */
function rowOf(subject: string): HTMLElement {
  return screen.getByText(subject).closest("li")!;
}

describe("review on an email's page", () => {
  it("marks it checked, not a bill, and back to review", async () => {
    const { sent } = stubServer();
    show("/mail/proton-bills/1/2");
    expect(await screen.findByText("Not reviewed yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark to review" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Mark checked" }));
    expect(await screen.findByText(/^Checked by Sam Smith, /)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark checked" })).toBeNull();
    expect(screen.getAllByRole("status").some((el) => el.textContent === "Marked checked.")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Mark not a bill" }));
    expect(await screen.findByText(/^Not a bill by Sam Smith, .+\. It will not be sent to OurHome\.$/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Mark to review" }));
    expect(await screen.findByText("Not reviewed yet")).toBeTruthy();
    expect(sent).toEqual([
      { captureIds: ["proton-bills/1/2"], state: "checked" },
      { captureIds: ["proton-bills/1/2"], state: "not-bill" },
      { captureIds: ["proton-bills/1/2"], state: null },
    ]);
  });

  it("says why when a mark could not be saved", async () => {
    stubServer({ failWith: "That email was not found." });
    show("/mail/proton-bills/1/3");
    fireEvent.click(await screen.findByRole("button", { name: "Mark checked" }));
    expect(await screen.findByText("Could not change the review: That email was not found.")).toBeTruthy();
    expect(screen.getByText("Not reviewed yet")).toBeTruthy();
  });
});

describe("review on the list", () => {
  it("marks several emails at once from Select, and shows each one's mark", async () => {
    const { sent } = stubServer();
    show("/");
    await screen.findByText("Newsletter");
    // The reminder's values need a check until someone reviews it.
    expect(within(rowOf("Payment reminder")).getByText("Needs a check")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    const bar = screen.getByRole("region", { name: "Selected emails" });
    expect(within(bar).getByText("None selected. Tick the emails to tag or mark.")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /^Select: Payment reminder/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^Select: Water bill/ }));
    fireEvent.click(within(bar).getByRole("button", { name: "Mark checked" }));
    expect(await within(bar).findByText("Marked 2 emails checked.")).toBeTruthy();
    expect(sent).toEqual([{ captureIds: ["proton-bills/1/3", "proton-bills/1/2"], state: "checked" }]);
    expect(within(rowOf("Payment reminder")).getByText("Checked")).toBeTruthy();
    expect(within(rowOf("Payment reminder")).queryByText("Needs a check")).toBeNull();

    fireEvent.click(within(bar).getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^Select: Newsletter/ }));
    fireEvent.click(within(bar).getByRole("button", { name: "Mark not a bill" }));
    expect(await within(bar).findByText("Marked 1 email not a bill.")).toBeTruthy();
    expect(within(rowOf("Newsletter")).getByText("Not a bill")).toBeTruthy();
  });

  it("narrows to what is still to review with the shortcut and the Review filter", async () => {
    stubServer();
    show("/");
    await screen.findByText("Newsletter");
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^Select: Newsletter/ }));
    fireEvent.click(screen.getByRole("button", { name: "Mark not a bill" }));
    await screen.findByText("Marked 1 email not a bill.");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    fireEvent.click(await screen.findByRole("button", { name: "Show 2 to review" }));
    expect(rows()).toEqual(["Water bill", "Payment reminder"]);
    expect(screen.queryByRole("button", { name: /to review$/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    const review = within(screen.getByRole("region", { name: "More filters" })).getByLabelText("Review") as HTMLSelectElement;
    expect(review.value).toBe("todo");
    fireEvent.change(review, { target: { value: "not-bill" } });
    expect(rows()).toEqual(["Newsletter"]);
  });

  it("says so when everything has been reviewed", async () => {
    stubServer();
    show("/?review=todo");
    await screen.findByText("Water bill");
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all shown" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark checked" }));
    expect(await screen.findByText("Every captured email has been reviewed.")).toBeTruthy();
  });
});
