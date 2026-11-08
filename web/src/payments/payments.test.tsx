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
import type { BillChoice, BillChoicesResponse, PaymentChoice, PaymentChoicesResponse, PaymentInfo, PaymentSide } from "../../../src/shared/payments";
import { MatchAfterFix } from "./MatchAfterFix";
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
  alsoBills: [],
  part: null,
  how: "auto",
  paidLate: false,
  needsBill: false,
  waitingUntil: null,
  staleChoice: false,
  locked: false,
  duplicateOf: null,
  maybeDuplicateOf: null,
};
const NEEDS_BILL: PaymentSide = {
  role: "payment",
  bill: null,
  alsoBills: [],
  part: null,
  how: null,
  paidLate: false,
  needsBill: true,
  waitingUntil: null,
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
    owed: more.amount === undefined ? 80 : more.amount,
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
  paymentAmount: null,
  bills: [
    choice(2, "2026-11-06", { dueDate: "2026-11-20", invoiceNo: "W-1102" }),
    choice(1, "2026-10-06", { state: "paired", canPick: false, reason: "Another payment already pays this bill.", paidByDate: "2026-10-08T12:00:00.000Z" }),
    choice(3, "2026-09-06", { state: "unusable", canPick: false, amount: null, reason: "Its amount is not settled. Use Fix on its amount first." }),
    choice(7, "2026-08-06", { state: "removed", canPick: false, reason: "This bill was removed in OurHome." }),
  ],
};

const BILL_ID = "proton-bills/1700000000/1";
const BILL_API = `/api/captures/${BILL_ID}`;

function paymentChoice(id: number, day: string, more: Partial<PaymentChoice> = {}): PaymentChoice {
  return {
    id: `proton-bills/1700000000/${id}`,
    date: `${day}T12:00:00.000Z`,
    amount: 80,
    state: "free",
    canPick: true,
    reason: null,
    pays: [],
    biller: "City Water",
    sender: "City Water",
    subject: `Payment received ${id}`,
    paidDate: day,
    ...more,
  };
}

const PAYMENT_CHOICES: PaymentChoicesResponse = {
  biller: "City Water",
  all: false,
  billAmount: 80,
  mode: "add",
  blocked: null,
  payments: [
    paymentChoice(5, "2026-10-15", { state: "other", pays: [{ id: "proton-bills/1700000000/7", date: "2026-08-06T12:00:00.000Z" }] }),
    paymentChoice(6, "2026-10-02", {
      state: "locked",
      canPick: false,
      reason: "This payment has been sent to OurHome; change it there.",
      pays: [{ id: "proton-bills/1700000000/8", date: "2026-09-06T12:00:00.000Z" }],
    }),
  ],
};

const text = () => document.body.textContent ?? "";

describe("a payment's line", () => {
  it("names every bill a payment for several pays, oldest first, each a link", () => {
    const also = { id: "proton-bills/1700000000/2", date: "2026-11-06T12:00:00.000Z", amount: 80 };
    show(<PaymentEditor detail={detail({ ...PAIRED, alsoBills: [also] })} />);
    expect(text()).toMatch(/Pays the Oct 6(, 2026)? and Nov 6(, 2026)? bills/);
    expect(screen.getByRole("link", { name: /^Open the Nov 6(, 2026)? bill$/ }).getAttribute("href")).toBe("/mail/proton-bills/1700000000/2");
    expect(text()).toContain("the oldest unpaid bills of this biller, which together fit the amount");
  });

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

  it("says a payment made before its bill email is waiting for it, until which day", () => {
    render(<PaymentSummary payment={{ ...NEEDS_BILL, needsBill: false, waitingUntil: "2026-11-17" }} />);
    expect(text()).toContain("Waiting for its bill email");
    // The day as written, not the day before in a time zone behind UTC.
    expect(text()).toMatch(/up to Nov 17(, 2026)?,/);
    expect(text()).not.toContain("Needs a bill");
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

  it("says it pays part of its bill, with what is still owed (owner, 2026-11-07)", () => {
    render(<PaymentSummary payment={{ ...PAIRED, how: "person", part: { billId: PAIRED.bill!.id, paid: 90, owed: 50 } }} />);
    expect(text()).toMatch(/Pays part of the Oct 6(, 2026)? bill/);
    expect(text()).toContain("Partly paid");
    expect(text()).toContain("$90.00 paid so far, $50.00 still owed. When the rest is paid, choose this bill for that payment email too.");
    cleanup();
    // One payment for several bills whose last is short: that one is named.
    const also = { id: "proton-bills/1700000000/2", date: "2026-11-06T12:00:00.000Z", amount: 80 };
    render(<PaymentSummary payment={{ ...PAIRED, how: "person", alsoBills: [also], part: { billId: also.id, paid: 30, owed: 50 } }} />);
    expect(text()).toMatch(/Pays the Oct 6(, 2026)? and Nov 6(, 2026)? bills/);
    expect(text()).toMatch(/The Nov 6(, 2026)? bill is paid only in part: \$30\.00 paid so far, \$50\.00 still owed\./);
    cleanup();
    render(<PaymentSummary payment={PAIRED} />);
    expect(text()).not.toContain("Partly paid");
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

  it("picks several bills for one payment, adding them up against it, and turns a row off again", async () => {
    const two: BillChoicesResponse = {
      ...CHOICES,
      paymentAmount: 113.46,
      bills: [choice(2, "2026-11-06", { amount: 56.94 }), choice(8, "2026-10-20", { amount: 56.52 }), choice(9, "2026-09-20", { amount: 10 })],
    };
    const sent = stub({
      [`GET ${API}/bill-choices`]: () => reply(200, two),
      [`PUT ${API}/pairing`]: () => reply(200, { payment: { ...NEEDS_BILL, needsBill: false, how: "person" } }),
    });
    show(<PaymentEditor detail={detail(NEEDS_BILL)} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose a bill" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose its bill" });
    const nov = await within(dialog).findByRole("button", { name: /^Nov 6(, 2026)? bill/ });
    const oct = within(dialog).getByRole("button", { name: /^Oct 20(, 2026)? bill/ });
    const sep = within(dialog).getByRole("button", { name: /^Sep 20(, 2026)? bill/ });
    fireEvent.click(nov);
    expect(within(dialog).getByRole("status").textContent).toBe("1 bill selected: $56.94, $56.52 less than the $113.46 payment.");
    fireEvent.click(sep);
    fireEvent.click(sep);
    expect(sep.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(oct);
    expect(within(dialog).getByRole("status").textContent).toBe("2 bills selected: $113.46, exactly the payment.");
    // The last one selected is the one shown.
    expect(within(dialog).getByRole("region", { name: "The selected bill" }).textContent).toContain("Your bill 8 is ready");

    fireEvent.click(within(dialog).getByRole("button", { name: "Pick these 2 bills" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent.find(([m]) => m === "PUT")?.[2]).toEqual({ choice: "bills", billIds: ["proton-bills/1700000000/2", "proton-bills/1700000000/8"] });
    expect(await screen.findByText(/Saved: this payment pays the Oct 20(, 2026)? and Nov 6(, 2026)? bills\./)).toBeTruthy();
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

  it("lets a bill another payment pays part of be picked, counting what is still owed (owner, 2026-11-07)", async () => {
    const part: BillChoicesResponse = {
      ...CHOICES,
      paymentAmount: 60,
      bills: [choice(1, "2026-10-06", { amount: 140, owed: 50, state: "part", paidByDate: "2026-10-20T12:00:00.000Z" })],
    };
    const sent = stub({
      [`GET ${API}/bill-choices`]: () => reply(200, part),
      [`PUT ${API}/pairing`]: () => reply(200, { payment: { ...NEEDS_BILL, needsBill: false, how: "person" } }),
    });
    show(<PaymentEditor detail={detail(NEEDS_BILL)} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose a bill" }));
    const dialog = await screen.findByRole("dialog");
    const row = await within(dialog).findByRole("button", { name: /^Oct 6(, 2026)? bill, \$140\.00, Partly paid by the Oct 20(, 2026)? payment, \$50\.00 still owed$/ });
    expect((row as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(row);
    const preview = within(dialog).getByRole("region", { name: "The selected bill" });
    expect(preview.textContent).toContain("$50.00, after the other payments on it");
    expect(within(dialog).getByRole("status").textContent).toBe("1 bill selected: $50.00 still owed, $10.00 less than the $60.00 payment.");
    fireEvent.click(within(preview).getByRole("button", { name: "Pick this bill" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent.find(([m]) => m === "PUT")?.[2]).toEqual({ choice: "bill", billId: "proton-bills/1700000000/1" });
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
    show(<PaymentEditor detail={detail({ role: "bill", paidBy: { id: "proton-bills/1700000000/9", date: "2026-10-28T14:03:11.000Z" }, alsoPaidBy: [], part: null, ourhome: null }, "proton-bills/1700000000/1")} />);
    expect(text()).toMatch(/Paid by the Oct 28(, 2026)? payment/);
    expect(text()).not.toContain("Partly paid");
    expect(screen.getByRole("link", { name: /^Open the Oct 28(, 2026)? payment$/ }).getAttribute("href")).toBe("/mail/proton-bills/1700000000/9");
    expect(screen.queryByRole("button", { name: "Choose a bill" })).toBeNull();
  });

  it("says it is partly paid with what is still owed, then paid by both payments (owner, 2026-11-07)", () => {
    const first = { id: "proton-bills/1700000000/9", date: "2026-10-20T14:03:11.000Z" };
    show(<PaymentEditor detail={detail({ role: "bill", paidBy: first, alsoPaidBy: [], part: { billId: "proton-bills/1700000000/1", paid: 90, owed: 50 }, ourhome: null }, "proton-bills/1700000000/1")} />);
    expect(text()).toMatch(/Partly paid by the Oct 20(, 2026)? payment/);
    expect(text()).toContain("$90.00 paid so far, $50.00 still owed.");
    cleanup();
    const second = { id: "proton-bills/1700000000/10", date: "2026-10-28T14:03:11.000Z" };
    show(<PaymentEditor detail={detail({ role: "bill", paidBy: first, alsoPaidBy: [second], part: null, ourhome: null }, "proton-bills/1700000000/1")} />);
    expect(text()).toMatch(/^Paid by the Oct 20(, 2026)? and Oct 28(, 2026)? payments/);
    expect(text()).not.toContain("Partly paid");
    expect(screen.getByRole("link", { name: /^Open the Oct 28(, 2026)? payment$/ }).getAttribute("href")).toBe("/mail/proton-bills/1700000000/10");
  });

  it("offers Choose its payment, or Change its payment once paid in full, but not once OurHome reported it", () => {
    const paidBy = { id: "proton-bills/1700000000/9", date: "2026-10-28T14:03:11.000Z" };
    show(<PaymentEditor detail={detail({ role: "bill", paidBy: null, alsoPaidBy: [], part: null, ourhome: null }, BILL_ID)} />);
    expect(screen.getByRole("button", { name: "Choose its payment" })).toBeTruthy();
    cleanup();
    show(<PaymentEditor detail={detail({ role: "bill", paidBy, alsoPaidBy: [], part: null, ourhome: null }, BILL_ID)} />);
    expect(screen.getByRole("button", { name: "Change its payment" })).toBeTruthy();
    cleanup();
    show(<PaymentEditor detail={detail({ role: "bill", paidBy, alsoPaidBy: [], part: { billId: BILL_ID, paid: 40, owed: 40 }, ourhome: null }, BILL_ID)} />);
    expect(screen.getByRole("button", { name: "Choose its payment" })).toBeTruthy();
    cleanup();
    show(<PaymentEditor detail={detail({ role: "bill", paidBy: null, alsoPaidBy: [], part: null, ourhome: { change: "removed", at: "2026-11-03T15:20:00.000Z" } }, BILL_ID)} />);
    expect(screen.queryByRole("button", { name: /its payment/ })).toBeNull();
  });

  it("picks a payment for the bill after showing it, and says what picking it does", async () => {
    const sent = stub({
      [`GET ${BILL_API}/payment-choices`]: () => reply(200, PAYMENT_CHOICES),
      [`PUT ${BILL_API}/payer`]: () => reply(200, { bill: { role: "bill", paidBy: null, alsoPaidBy: [], part: null, ourhome: null } }),
    });
    show(<PaymentEditor detail={detail({ role: "bill", paidBy: null, alsoPaidBy: [], part: null, ourhome: null }, BILL_ID)} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose its payment" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose its payment" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    const locked = await within(dialog).findByRole("button", { name: /^Oct 2(, 2026)? payment, \$80\.00, Sent to OurHome, pays the Sep 6(, 2026)? bill, / });
    expect((locked as HTMLButtonElement).disabled).toBe(true);
    const moving = within(dialog).getByRole("button", { name: /^Oct 15(, 2026)? payment, \$80\.00, Pays the Aug 6(, 2026)? bill$/ });
    fireEvent.click(moving);
    const preview = within(dialog).getByRole("region", { name: "The selected payment" });
    expect(preview.textContent).toMatch(/It pays the Aug 6(, 2026)? bill now: picking it moves it to this bill only\. It is added to what pays this bill\./);
    expect(preview.textContent).toContain("Oct 15, 2026");
    fireEvent.click(within(preview).getByRole("button", { name: "Pick this payment" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent.find(([m]) => m === "PUT")?.[2]).toEqual({ paymentId: "proton-bills/1700000000/5" });
    expect(await screen.findByText(/Saved: the Oct 15(, 2026)? payment pays this bill\./)).toBeTruthy();
  });

  it("says it takes the place of both payments when two pay the bill in full (Xcel Energy, seen 2026-11-07)", async () => {
    const two: PaymentChoicesResponse = {
      ...PAYMENT_CHOICES,
      mode: "replace",
      payments: [paymentChoice(9, "2026-11-06", { amount: 90 }), paymentChoice(3, "2026-10-15", { state: "this", canPick: false }), paymentChoice(2, "2026-10-15", { state: "this", canPick: false })],
    };
    stub({ [`GET ${BILL_API}/payment-choices`]: () => reply(200, two) });
    show(<PaymentEditor detail={detail({ role: "bill", paidBy: null, alsoPaidBy: [], part: null, ourhome: null }, BILL_ID)} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose its payment" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: /^Nov 6(, 2026)? payment/ }));
    expect(within(dialog).getByRole("region", { name: "The selected payment" }).textContent).toContain("It takes the place of the 2 payments that pay this bill now.");
  });

  it("says why nothing can be picked when a sent payment pays the bill in full", async () => {
    const blocked = "A payment already sent to OurHome pays this bill, so its payment can only be changed in OurHome.";
    stub({ [`GET ${BILL_API}/payment-choices`]: () => reply(200, { ...PAYMENT_CHOICES, mode: "replace", blocked, payments: [] }) });
    show(<PaymentEditor detail={detail({ role: "bill", paidBy: null, alsoPaidBy: [], part: null, ourhome: null }, BILL_ID)} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose its payment" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(blocked)).toBeTruthy();
  });

  it("says what OurHome reported, with the date, or that nothing pays it yet", () => {
    render(<PaymentSummary payment={{ role: "bill", paidBy: null, alsoPaidBy: [], part: null, ourhome: { change: "paid", at: "2026-11-03T15:20:00.000Z" } }} />);
    expect(text()).toMatch(/Paid in OurHome by hand on Nov 3(, 2026)?\./);
    cleanup();
    render(<PaymentSummary payment={{ role: "bill", paidBy: null, alsoPaidBy: [], part: null, ourhome: { change: "removed", at: "2026-11-12T15:20:00.000Z" } }} />);
    expect(text()).toMatch(/Removed in OurHome on Nov 12(, 2026)?\./);
    cleanup();
    render(<PaymentSummary payment={{ role: "bill", paidBy: null, alsoPaidBy: [], part: null, ourhome: null }} />);
    expect(text()).toContain("No payment email for it yet");
  });
});

describe("right after a Fix (owner, 2026-11-07)", () => {
  /** The email's page as the server answers it after the Fix. */
  const page = (payment: PaymentInfo, id = PAYMENT_ID) => ({ [`GET /api/captures/${id}`]: () => reply(200, detail(payment, id)) });

  it("says the bill it matched and offers Change its bill, which opens the picker", async () => {
    stub({ ...page(PAIRED), [`GET ${API}/bill-choices`]: () => reply(200, CHOICES) });
    show(<MatchAfterFix captureId={PAYMENT_ID} savedAt={0} />);
    expect(await screen.findByText(/OurHomeInbox matched it to the Oct 6(, 2026)? bill\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change its bill" }));
    expect(await screen.findByRole("dialog", { name: "Choose its bill" })).toBeTruthy();
  });

  it("offers Choose a bill when none fits, and says what is still owed on a part payment", async () => {
    stub(page(NEEDS_BILL));
    show(<MatchAfterFix captureId={PAYMENT_ID} savedAt={0} />);
    expect(await screen.findByText("No bill email fits it. Choose its bill, or mark it Paid on its own.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose a bill" })).toBeTruthy();
    cleanup();
    stub(page({ ...PAIRED, how: "person", part: { billId: PAIRED.bill!.id, paid: 90, owed: 50 } }));
    show(<MatchAfterFix captureId={PAYMENT_ID} savedAt={0} />);
    expect(await screen.findByText(/It pays the Oct 6(, 2026)? bill, as chosen in your household\. That pays only part of it: \$50\.00 is still owed\./)).toBeTruthy();
  });

  it("on a bill, says what pays it, or offers Choose its payment, which opens the payment picker", async () => {
    stub({ ...page({ role: "bill", paidBy: null, alsoPaidBy: [], part: null, ourhome: null }, BILL_ID), [`GET ${BILL_API}/payment-choices`]: () => reply(200, PAYMENT_CHOICES) });
    show(<MatchAfterFix captureId={BILL_ID} savedAt={0} />);
    expect(await screen.findByText("No payment email fits it yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Choose its payment" }));
    expect(await screen.findByRole("dialog", { name: "Choose its payment" })).toBeTruthy();
    cleanup();
    const paidBy = { id: "proton-bills/1700000000/9", date: "2026-10-28T14:03:11.000Z" };
    stub(page({ role: "bill", paidBy, alsoPaidBy: [], part: null, ourhome: null }, BILL_ID));
    show(<MatchAfterFix captureId={BILL_ID} savedAt={0} />);
    expect(await screen.findByText(/It is paid by the Oct 28(, 2026)? payment\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change its payment" })).toBeTruthy();
  });

  it("says it is looking until the email has been read again since the Fix, and offers nothing once sent", async () => {
    stub(page({ ...PAIRED, locked: true }));
    show(<MatchAfterFix captureId={PAYMENT_ID} savedAt={Date.now() + 60_000} />);
    expect(await screen.findByText("Looking again for what it pairs with...")).toBeTruthy();
    cleanup();
    stub(page({ ...PAIRED, locked: true }));
    show(<MatchAfterFix captureId={PAYMENT_ID} savedAt={0} />);
    expect(await screen.findByText("This payment has been sent to OurHome, so its bill can only be changed there.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
