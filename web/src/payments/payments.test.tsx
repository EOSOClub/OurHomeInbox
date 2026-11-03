// @vitest-environment jsdom
// Pairing on the pages, against a stand-in server: a payment's line ("Pays
// the Oct 6 bill", "Paid late", "Needs a bill", locked once sent), the picker
// (a preview before Pick this bill, rows that cannot be picked, Escape, the
// switch for every biller's bills), and a bill's line.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureDetailResponse } from "../../../src/shared/api";
import type { BillChoice, BillChoicesResponse, PaymentInfo, PaymentSide } from "../../../src/shared/payments";
import { PaymentEditor, PaymentSummary } from "./PaymentLine";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function reply(status: number, body?: unknown): Response {
  return body === undefined ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function show(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
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

const PAYMENT_ID = "proton-bills/1700000000/5";
const API = `/api/captures/${PAYMENT_ID}`;

const PAIRED: PaymentSide = {
  role: "payment",
  bill: { id: "proton-bills/1700000000/1", date: "2026-10-06T12:00:00.000Z", amount: 80 },
  how: "auto",
  paidLate: false,
  needsBill: false,
  staleChoice: false,
  locked: false,
  duplicateOf: null,
  maybeDuplicateOf: null,
};
const NEEDS_BILL: PaymentSide = {
  role: "payment",
  bill: null,
  how: null,
  paidLate: false,
  needsBill: true,
  staleChoice: false,
  locked: false,
  duplicateOf: null,
  maybeDuplicateOf: null,
};
/** The Waste Management payment email a second email repeats. */
const ORIGINAL = { id: "proton-bills/1700000000/4", date: "2026-07-12T03:02:27.000Z", biller: "Waste Management" };

function detail(payment: PaymentInfo, id = PAYMENT_ID): CaptureDetailResponse & { payment: PaymentInfo } {
  return { id, biller: { id: 3, name: "City Water", kind: "bill", matchedOn: "water.example" }, payment } as unknown as CaptureDetailResponse & { payment: PaymentInfo };
}

function choice(id: number, day: string, more: Partial<BillChoice> = {}): BillChoice {
  return {
    id: `proton-bills/1700000000/${id}`,
    date: `${day}T12:00:00.000Z`,
    amount: 80,
    state: "unpaid",
    canPick: true,
    reason: null,
    paidByDate: null,
    biller: "City Water",
    sender: "City Water",
    subject: `Your bill ${id} is ready`,
    dueDate: null,
    invoiceNo: null,
    ...more,
  };
}

const CHOICES: BillChoicesResponse = {
  biller: "City Water",
  all: false,
  locked: false,
  bills: [
    choice(2, "2026-11-06", { dueDate: "2026-11-20", invoiceNo: "W-1102" }),
    choice(1, "2026-10-06", { state: "paired", canPick: false, reason: "Another payment already pays this bill.", paidByDate: "2026-10-08T12:00:00.000Z" }),
    choice(3, "2026-09-06", { state: "unusable", canPick: false, amount: null, reason: "Its amount is not settled. Use Fix on its amount first." }),
    choice(7, "2026-08-06", { state: "removed", canPick: false, reason: "This bill was removed in OurHome." }),
  ],
};

const text = () => document.body.textContent ?? "";

describe("a payment's line", () => {
  it("says which bill it pays, as a link, and that it was paid late when so", () => {
    show(<PaymentEditor detail={detail({ ...PAIRED, paidLate: true })} />);
    const link = screen.getByRole("link", { name: /^Open the Oct 6(, 2026)? bill$/ });
    expect(link.getAttribute("href")).toBe("/mail/proton-bills/1700000000/1");
    expect(text()).toMatch(/Pays the Oct 6(, 2026)? bill/);
    expect(text()).toContain("Paid late");
    expect(text()).toContain("Chosen by OurHomeInbox");
    expect(screen.getByRole("button", { name: "Choose a bill" })).toBeTruthy();
  });

  it("does not say paid late when it was on time", () => {
    render(<PaymentSummary payment={PAIRED} />);
    expect(text()).toMatch(/Pays the Oct 6(, 2026)? bill/);
    expect(text()).not.toContain("Paid late");
  });

  it("says it needs a bill, or is paid on its own", () => {
    render(<PaymentSummary payment={NEEDS_BILL} />);
    expect(text()).toContain("Needs a bill");
    cleanup();
    render(<PaymentSummary payment={{ ...NEEDS_BILL, needsBill: false, how: "own" }} />);
    expect(text()).toContain("Paid on its own");
    cleanup();
    render(<PaymentSummary payment={{ ...NEEDS_BILL, staleChoice: true }} />);
    expect(text()).toContain("Needs a bill");
    expect(text()).toContain("The bill chosen for this payment can no longer be used. Choose another.");
  });

  it("says a second email is the same payment as another, as a link, and still offers Choose a bill", () => {
    show(<PaymentEditor detail={detail({ ...NEEDS_BILL, needsBill: false, duplicateOf: ORIGINAL })} />);
    const link = screen.getByRole("link", { name: /^Open the Jul 1[12](, 2026)? Waste Management payment$/ });
    expect(link.getAttribute("href")).toBe("/mail/proton-bills/1700000000/4");
    expect(text()).toMatch(/Same payment as the Jul 1[12](, 2026)? Waste Management payment/);
    expect(text()).toContain("it is not sent to OurHome and the payment counts once");
    expect(text()).not.toContain("Needs a bill");
    expect(screen.getByRole("button", { name: "Choose a bill" })).toBeTruthy();
  });

  it("names the payment a payment that needs a bill may repeat, but not on a stale choice", () => {
    render(<PaymentSummary payment={{ ...NEEDS_BILL, maybeDuplicateOf: ORIGINAL }} />);
    expect(text()).toContain("Needs a bill");
    expect(text()).toMatch(/It may be a second email about the Jul 1[12](, 2026)? Waste Management payment: if so, mark it Not a bill\./);
    cleanup();
    render(<PaymentSummary payment={{ ...NEEDS_BILL, maybeDuplicateOf: ORIGINAL, staleChoice: true }} />);
    expect(text()).not.toContain("It may be a second email");
  });

  it("is locked once sent to OurHome: no Choose a bill", () => {
    show(<PaymentEditor detail={detail({ ...PAIRED, how: "person", locked: true })} />);
    expect(text()).toContain("Sent to OurHome; change it there.");
    expect(text()).toContain("Chosen by someone in the household.");
    expect(screen.queryByRole("button", { name: "Choose a bill" })).toBeNull();
  });
});

describe("the picker", () => {
  it("opens with focus inside, shows a bill before it is picked, and saves the pick", async () => {
    const sent = stub({
      [`GET ${API}/bill-choices`]: () => reply(200, CHOICES),
      [`PUT ${API}/pairing`]: () => reply(200, { payment: { ...NEEDS_BILL, needsBill: false, how: "person" } }),
    });
    show(<PaymentEditor detail={detail(NEEDS_BILL)} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose a bill" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose its bill" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Portalled to the page's body.
    expect(dialog.closest("body")).toBe(document.body);

    const row = await within(dialog).findByRole("button", { name: /^Nov 6(, 2026)? bill, \$80\.00, Unpaid$/ });
    expect(within(dialog).queryByRole("button", { name: "Pick this bill" })).toBeNull();
    fireEvent.click(row);
    expect(row.getAttribute("aria-pressed")).toBe("true");
    const preview = within(dialog).getByRole("region", { name: "The selected bill" });
    expect(preview.textContent).toContain("Your bill 2 is ready");
    expect(preview.textContent).toContain("W-1102");
    expect(preview.textContent).toContain("Nov 20, 2026");
    const open = within(preview).getByRole("link", { name: "Open the email, in a new tab" });
    expect(open.getAttribute("href")).toBe("/mail/proton-bills/1700000000/2");
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toContain("noopener");

    fireEvent.click(within(preview).getByRole("button", { name: "Pick this bill" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent.find(([m]) => m === "PUT")?.[2]).toEqual({ choice: "bill", billId: "proton-bills/1700000000/2" });
    expect(await screen.findByText(/Saved: this payment pays the Nov 6(, 2026)? bill\./)).toBeTruthy();
  });

  it("shows a bill that cannot be picked as disabled, naming the payment that pays it, with a reason only when it adds something", async () => {
    stub({ [`GET ${API}/bill-choices`]: () => reply(200, CHOICES) });
    show(<PaymentEditor detail={detail(NEEDS_BILL)} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose a bill" }));
    const dialog = await screen.findByRole("dialog");
    // The accessible name keeps everything, the reason included.
    const paired = await within(dialog).findByRole("button", { name: /^Oct 6(, 2026)? bill, \$80\.00, Paid by the Oct 8(, 2026)? payment, Another payment already pays this bill\.$/ });
    expect((paired as HTMLButtonElement).disabled).toBe(true);
    expect(paired.textContent).toMatch(/Paid by the Oct 8(, 2026)? payment/);
    // On screen, no second line repeating the state.
    expect(dialog.textContent).not.toContain("Another payment already pays this bill.");
    expect(dialog.textContent).not.toContain("This bill was removed in OurHome.");
    expect(dialog.textContent).toContain("Removed in OurHome");
    // A reason that says more than the state is shown.
    const unusable = within(dialog).getByRole("button", { name: /Cannot be picked, Its amount is not settled/ });
    expect((unusable as HTMLButtonElement).disabled).toBe(true);
    expect(unusable.textContent).toContain("Its amount is not settled. Use Fix on its amount first.");
  });

  it("closes on Escape without changing anything, and gives focus back", async () => {
    const sent = stub({ [`GET ${API}/bill-choices`]: () => reply(200, CHOICES) });
    show(<PaymentEditor detail={detail(PAIRED)} />);
    const opener = screen.getByRole("button", { name: "Choose a bill" });
    fireEvent.click(opener);
    await screen.findByRole("dialog");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent.some(([m]) => m === "PUT")).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("lists every biller's bills with the switch, and saves Paid on its own and Let OurHomeInbox choose", async () => {
    const sent = stub({
      [`GET ${API}/bill-choices`]: () => reply(200, CHOICES),
      [`GET ${API}/bill-choices?all=1`]: () => reply(200, { ...CHOICES, all: true, bills: [choice(4, "2026-10-10", { biller: "City Power", amount: 55 }), ...CHOICES.bills] }),
      [`PUT ${API}/pairing`]: () => reply(200, { payment: PAIRED }),
    });
    show(<PaymentEditor detail={detail(PAIRED)} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose a bill" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("switch", { name: "Show every biller's bills" }));
    expect(await within(dialog).findByRole("button", { name: /\$55\.00, Unpaid, City Power$/ })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Paid on its own" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent.filter(([m]) => m === "PUT").map(([, , body]) => body)).toEqual([{ choice: "own" }]);
    expect(await screen.findByText("Saved: this payment goes to OurHome on its own, with no bill.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Choose a bill" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Let OurHomeInbox choose" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent.filter(([m]) => m === "PUT").at(-1)?.[2]).toEqual({ choice: "auto" });
  });

  it("shows the server's reason when a pick is refused", async () => {
    stub({
      [`GET ${API}/bill-choices`]: () => reply(200, CHOICES),
      [`PUT ${API}/pairing`]: () => reply(409, { error: "This payment has been sent to OurHome, so its bill can no longer be changed here. Change it in OurHome." }),
    });
    show(<PaymentEditor detail={detail(PAIRED)} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose a bill" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Paid on its own" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Change it in OurHome.");
  });
});

describe("a bill's line", () => {
  it("says which payment pays it, as a link", () => {
    show(<PaymentEditor detail={detail({ role: "bill", paidBy: { id: "proton-bills/1700000000/9", date: "2026-10-28T14:03:11.000Z" }, ourhome: null }, "proton-bills/1700000000/1")} />);
    expect(text()).toMatch(/Paid by the Oct 28(, 2026)? payment/);
    expect(screen.getByRole("link", { name: /^Open the Oct 28(, 2026)? payment$/ }).getAttribute("href")).toBe("/mail/proton-bills/1700000000/9");
    expect(screen.queryByRole("button", { name: "Choose a bill" })).toBeNull();
  });

  it("says what OurHome reported, with the date, or that nothing pays it yet", () => {
    render(<PaymentSummary payment={{ role: "bill", paidBy: null, ourhome: { change: "paid", at: "2026-11-03T15:20:00.000Z" } }} />);
    expect(text()).toMatch(/Paid in OurHome by hand on Nov 3(, 2026)?\./);
    cleanup();
    render(<PaymentSummary payment={{ role: "bill", paidBy: null, ourhome: { change: "removed", at: "2026-11-12T15:20:00.000Z" } }} />);
    expect(text()).toMatch(/Removed in OurHome on Nov 12(, 2026)?\./);
    cleanup();
    render(<PaymentSummary payment={{ role: "bill", paidBy: null, ourhome: null }} />);
    expect(text()).toContain("No payment email for it yet");
  });
});
