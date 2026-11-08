// @vitest-environment jsdom
// The hand-off on the pages, against stand-in servers: an email's OurHome
// line, Settings' OurHome connection (token shown once, start date, new token,
// disconnect), the Send automatically popup after a biller's third clean
// check, and the biller page's setting.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Biller, CaptureDetailResponse } from "../../../src/shared/api";
import type { HandoffInfo, OurHomeConnection } from "../../../src/shared/handoff";
import { CaptureReviewEditor } from "../mail/CaptureReview";
import { BillerAutoSend } from "./BillerAutoSend";
import { HandoffSummary } from "./HandoffLine";
import { OurHomeCard } from "./OurHomeCard";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function reply(status: number, body?: unknown): Response {
  return body === undefined ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function show(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

/** A stand-in server: `routes` answers "METHOD path"; records what was sent. */
function stub(routes: Record<string, (body: unknown) => Response>) {
  const sent: Array<[string, string, unknown]> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      sent.push([method, path, body]);
      const route = routes[`${method} ${path}`];
      return route ? route(body) : reply(404, { error: "There is nothing here." });
    }),
  );
  return sent;
}

const line = (handoff: Partial<HandoffInfo>) => {
  render(<HandoffSummary handoff={{ state: "goes", reason: "Checked by Sam.", connected: true, offered: null, ...handoff }} />);
  return document.body.textContent ?? "";
};

describe("an email's OurHome line", () => {
  it("says it goes, is offered, or OurHome has it, with the reason", () => {
    expect(line({})).toContain("Goes to OurHome");
    expect(document.body.textContent).toContain("Checked by Sam.");
    expect(document.body.textContent).toContain("OurHome takes it the next time it asks.");
    cleanup();
    expect(line({ offered: { status: "ready", number: 4, at: "2026-11-01T12:00:00Z", taken: false } })).toContain("Offered to OurHome");
    cleanup();
    expect(line({ offered: { status: "ready", number: 4, at: "2026-11-01T12:00:00Z", taken: true } })).toContain("OurHome has it");
  });

  it("says it is ready but OurHome is not connected, where to connect it", () => {
    const text = line({ connected: false });
    expect(text).toContain("Ready for OurHome");
    expect(text).toContain("It goes once OurHome is connected (Settings, OurHome connection).");
  });

  it("says why it waits or never goes, and when it was taken back", () => {
    expect(line({ state: "waits", reason: "Waits for someone to mark it Checked: the sender is not verified." })).toContain("Waits before going to OurHome");
    cleanup();
    const text = line({ state: "never", reason: "Marked Not a bill.", offered: { status: "withdrawn", number: 5, at: "2026-11-01T12:00:00Z", taken: false } });
    expect(text).toContain("Not for OurHome");
    expect(text).toContain("Marked Not a bill.");
    expect(text).toContain("Taken back from OurHome on");
  });

  it("says OurHome keeps what it was sent when an email it has now waits", () => {
    const text = line({ state: "waits", reason: "Waits for someone to mark it Checked.", offered: { status: "ready", number: 4, at: "2026-11-01T12:00:00Z", taken: true } });
    expect(text).toContain("Waits before going to OurHome");
    expect(text).toContain("OurHome keeps what it was offered on");
    expect(text).toContain("any change waits.");
  });
});

const NOT_CONNECTED: OurHomeConnection = { connected: false, startDate: null, tokenCreatedAt: null, tokenCreatedBy: null, lastUsedAt: null, takenUpTo: 0, newest: 0 };
const CONNECTED: OurHomeConnection = {
  connected: true,
  startDate: "2026-11-01",
  tokenCreatedAt: "2026-11-01T15:00:00Z",
  tokenCreatedBy: "Sam",
  lastUsedAt: "2026-11-01T15:15:00Z",
  takenUpTo: 3,
  newest: 5,
};
const TOKEN = `ohi_${"A".repeat(43)}`;

describe("Settings' OurHome connection", () => {
  it("makes a token from a start date and shows it once, with Copy", async () => {
    let connection = NOT_CONNECTED;
    const sent = stub({
      "GET /api/ourhome": () => reply(200, connection),
      "POST /api/ourhome/token": (body) => {
        connection = { ...CONNECTED, startDate: (body as { startDate: string }).startDate, lastUsedAt: null, takenUpTo: 0, newest: 0 };
        return reply(201, { token: TOKEN, connection });
      },
    });
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    show(<OurHomeCard />);
    const date = (await screen.findByLabelText("Send emails dated from")) as HTMLInputElement;
    expect(date.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    fireEvent.change(date, { target: { value: "2026-10-15" } });
    fireEvent.click(screen.getByRole("button", { name: "Make a token for OurHome" }));
    expect(await screen.findByText(TOKEN)).toBeTruthy();
    expect(sent.find(([m]) => m === "POST")?.[2]).toEqual({ startDate: "2026-10-15" });
    fireEvent.click(screen.getByRole("button", { name: "Copy token" }));
    await screen.findByText("Copied.");
    expect(writeText).toHaveBeenCalledWith(TOKEN);
    expect(await screen.findByText("Not yet")).toBeTruthy();
  });

  it("shows what OurHome has picked up, and changes the start date", async () => {
    let connection = CONNECTED;
    const sent = stub({
      "GET /api/ourhome": () => reply(200, connection),
      "PUT /api/ourhome": (body) => {
        connection = { ...connection, startDate: (body as { startDate: string }).startDate };
        return reply(200, connection);
      },
    });
    show(<OurHomeCard />);
    expect(await screen.findByText("3 of 5 offers; OurHome takes the rest the next time it asks.")).toBeTruthy();
    expect(screen.getByText(/Made .* by Sam/)).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save date" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Send emails dated from"), { target: { value: "2026-10-01" } });
    fireEvent.click(save);
    await waitFor(() => expect(sent.some(([m]) => m === "PUT")).toBe(true));
    expect(sent.find(([m]) => m === "PUT")?.[2]).toEqual({ startDate: "2026-10-01" });
  });

  it("asks before making a new token or disconnecting, and Cancel changes nothing", async () => {
    let connection = CONNECTED;
    const sent = stub({
      "GET /api/ourhome": () => reply(200, connection),
      "POST /api/ourhome/token": () => reply(201, { token: TOKEN, connection }),
      "DELETE /api/ourhome/token": () => {
        connection = { ...connection, connected: false, tokenCreatedAt: null, tokenCreatedBy: null };
        return reply(200, connection);
      },
    });
    show(<OurHomeCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Make a new token" }));
    const ask = screen.getByRole("group", { name: "Make a new token?" });
    expect(ask.textContent).toContain("stops working at once");
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(sent.some(([m]) => m !== "GET")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Disconnect OurHome?" })).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Not connected: the token was turned off.")).toBeTruthy();
    expect(screen.getByText(/A new token keeps the start date/)).toBeTruthy();
  });
});

const DETAIL = { id: "proton-bills/1/3", review: null } as unknown as CaptureDetailResponse;
const WATER: Biller = {
  id: 7,
  name: "City Water",
  kind: "bill",
  senders: ["water.example"],
  notes: "",
  fetchInvoices: true,
  remindersAreBills: false,
  autoSend: false,
  cleanChecks: 0,
  createdAt: "",
  updatedAt: "",
};

describe("the Send automatically popup", () => {
  function stubReview(offer: boolean) {
    return stub({
      "PUT /api/captures/review": () =>
        reply(200, { captures: [{ id: DETAIL.id, review: { state: "checked", by: "Sam", at: "x" } }], offerAutoSend: offer ? [{ id: 7, name: "City Water" }] : [] }),
      "PUT /api/billers/7/auto-send": (body) => reply(200, { ...WATER, autoSend: (body as { autoSend: boolean }).autoSend }),
    });
  }

  it("opens when a check completes the biller's run, and Yes turns it on", async () => {
    const sent = stubReview(true);
    show(<CaptureReviewEditor detail={DETAIL} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark checked" }));
    const dialog = await screen.findByRole("dialog", { name: "Send City Water's emails automatically?" });
    expect(dialog.textContent).toContain("The last 3 of City Water's emails were checked and needed no fix.");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Yes, send automatically" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Yes, send automatically" }));
    await screen.findByText("City Water's emails now go to OurHome without a check.");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sent.find(([, path]) => path === "/api/billers/7/auto-send")?.[2]).toEqual({ autoSend: true });
  });

  it("Not now turns it down; Escape closes it without choosing", async () => {
    const sent = stubReview(true);
    show(<CaptureReviewEditor detail={DETAIL} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark checked" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Not now" }));
    await screen.findByText("Not now: City Water's emails are still checked each time.");
    expect(sent.find(([, path]) => path === "/api/billers/7/auto-send")?.[2]).toEqual({ autoSend: false });

    cleanup();
    const sentAgain = stubReview(true);
    show(<CaptureReviewEditor detail={DETAIL} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark checked" }));
    await screen.findByRole("dialog");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sentAgain.some(([, path]) => path === "/api/billers/7/auto-send")).toBe(false);
  });

  it("does not open when nothing was earned", async () => {
    stubReview(false);
    show(<CaptureReviewEditor detail={DETAIL} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark checked" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Marked checked."));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the biller page's Send automatically", () => {
  it("shows the run so far, with no way to skip it", () => {
    stub({});
    show(<BillerAutoSend biller={{ ...WATER, cleanChecks: 2 }} />);
    expect(screen.getByText(/2 of 3 so far/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("turns it on once earned, and off again", async () => {
    const sent = stub({ "PUT /api/billers/7/auto-send": (body) => reply(200, { ...WATER, autoSend: (body as { autoSend: boolean }).autoSend }) });
    show(<BillerAutoSend biller={{ ...WATER, cleanChecks: 3 }} />);
    fireEvent.click(screen.getByRole("button", { name: "Send automatically" }));
    await waitFor(() => expect(sent.at(-1)?.[2]).toEqual({ autoSend: true }));
    cleanup();
    show(<BillerAutoSend biller={{ ...WATER, autoSend: true }} />);
    expect(screen.getByText("Sent automatically.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check each email again" }));
    await waitFor(() => expect(sent.at(-1)?.[2]).toEqual({ autoSend: false }));
  });
});
