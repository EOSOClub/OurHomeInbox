// @vitest-environment jsdom
// The Status page against a stand-in server: all well, something that needs
// someone, invoice links, the counts' links, and the read-only view kept for
// when the server says canEdit is false.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureListResponse, MailboxInfo, StatusResponse } from "../../../src/shared/api";
import { exportItem } from "../mail/exportFixtures";
import { StatusPage } from "./StatusPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const MAILBOX: MailboxInfo = {
  id: 4,
  name: "Proton bill label",
  slug: "proton-bill-label",
  provider: "proton-bridge",
  folder: "Labels/Bill",
  imap: { host: "host.docker.internal", port: 1144, security: "none", username: "bills@example.com", passwordSet: true, passwordProblem: null },
  enabled: true,
  lastCheck: { at: new Date(Date.now() - 60_000).toISOString(), ok: true, message: "0 new, 36 captured before", captured: 0 },
  lastOkAt: new Date(Date.now() - 60_000).toISOString(),
  failingSince: null,
  createdAt: "2026-10-30T00:00:00Z",
  updatedAt: "2026-10-30T00:00:00Z",
};

function statusWith(change: Partial<StatusResponse> = {}): StatusResponse {
  return {
    version: "0.1.0",
    startedAt: "2026-10-30T09:00:00Z",
    checking: { everyMinutes: 15, running: false, lastStartedAt: null, lastFinishedAt: new Date(Date.now() - 60_000).toISOString(), nextAt: null },
    mailboxes: [MAILBOX],
    invoices: {
      counts: { saved: 4, "sign-in": 11, "not-pdf": 0, unreadable: 0, failed: 0, blocked: 0 },
      retrying: 0,
      recent: [
        {
          captureId: "proton-bill-label/1/16",
          subject: "Your invoice is now available",
          sender: "WM",
          outcome: "saved",
          reason: 'Got the invoice (a 4-page PDF) from the email\'s "View Invoice" link at wmezpay.wm.com.',
          triedAt: "2026-10-30T19:14:00Z",
          retrying: false,
        },
      ],
    },
    problems: [],
    canEdit: true,
    ...change,
  };
}

function show(status: StatusResponse, captures: CaptureListResponse = { captures: [] }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      const body = path === "/api/status" ? status : path === "/api/captures" ? captures : { error: "There is nothing here." };
      return new Response(JSON.stringify(body), { status: path === "/api/status" || path === "/api/captures" ? 200 : 404, headers: { "Content-Type": "application/json" } });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StatusPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the Status page", () => {
  it("says everything is working, and what the invoice links gave", async () => {
    show(statusWith());
    expect(await screen.findByText("Everything is working.")).toBeTruthy();
    const invoices = (await screen.findByRole("heading", { name: "Invoice links" })).closest("section")!;
    expect(invoices.textContent).toContain("Invoice saved4");
    expect(invoices.textContent).toContain("Needs a sign-in11");
    expect(invoices.textContent).not.toContain("Not a PDF");
    expect(within(invoices).getByRole("link", { name: "Your invoice is now available" }).getAttribute("href")).toBe("/mail/proton-bill-label/1/16");
    expect((await screen.findByRole("heading", { name: "Recent problems" })).closest("section")!.textContent).toContain("None since");
    expect(screen.getByText("Working")).toBeTruthy();
  });

  it("puts what needs someone first", async () => {
    const failing: MailboxInfo = {
      ...MAILBOX,
      lastCheck: { at: "2026-10-30T12:00:00Z", ok: false, message: "host.docker.internal:1144 refused the connection. Check the port.", captured: 0 },
      failingSince: "2026-10-30T09:00:00Z",
    };
    show(statusWith({ mailboxes: [failing] }));
    const alert = await screen.findByText("1 thing needs you:");
    expect(alert.closest("div")!.textContent).toContain("refused the connection");
    expect(screen.getByText("Needs you")).toBeTruthy();
    expect(screen.getByText(/^Failing since/)).toBeTruthy();
  });

  it("links each email count to the list narrowed that way, named in full for screen readers", async () => {
    show(statusWith(), { captures: [exportItem("1"), exportItem("2", { review: { state: "checked", by: "Sam", at: "2026-10-30T12:00:00Z" } })] });
    // Once ran together as "Showto review": a space inside a hidden span is dropped from the name.
    const link = await screen.findByRole("link", { name: "Show to review" });
    expect(link.getAttribute("href")).toBe("/?review=todo");
    expect(link.textContent).toBe("Show");
  });

  it("shows a member no log problems and no settings links", async () => {
    show(statusWith({ problems: null, canEdit: false }));
    await screen.findByText("Everything is working.");
    expect(screen.queryByRole("heading", { name: "Recent problems" })).toBeNull();
    expect(screen.queryByRole("link", { name: /^Settings/ })).toBeNull();
  });
});
