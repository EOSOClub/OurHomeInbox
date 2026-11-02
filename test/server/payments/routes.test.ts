// Pairing through the real server: what each email's page and the list say,
// the picker's choices, and choosing a bill, Paid on its own, or Let
// OurHomeInbox choose (the vault's "Hand-off" note, section 7).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PAIRING_REASONS } from "../../../src/server/handoff/rules.js";
import { lockPairings, setPick } from "../../../src/server/payments/store.js";
import type { ApiError, Biller, CaptureDetailResponse, CaptureListResponse } from "../../../src/shared/api.js";
import type { HandoffDocumentsResponse, OurHomeTokenResponse } from "../../../src/shared/handoff.js";
import type { BillChoicesResponse, PairingResponse } from "../../../src/shared/payments.js";
import { call, json, makeServer, saveEmail, setUp, type TestServer } from "../helpers.js";
import { billEmail, id, paymentEmail } from "./emails.js";

let server: TestServer;
let cookie: string;

beforeEach(async () => {
  server = makeServer();
  cookie = await setUp(server.app);
  const res = await send("POST", "/api/billers", { name: "City Water", kind: "bill", senders: ["water.example"] });
  expect(res.status).toBe(201);
});

afterEach(() => {
  server.close();
});

const send = (method: string, path: string, body?: unknown) => call(server.app, path, { method, cookie, body });
const detail = async (uid: number) => json<CaptureDetailResponse>(await send("GET", `/api/captures/${id(uid)}`));
const choices = async (uid: number, all = false) => json<BillChoicesResponse>(await send("GET", `/api/captures/${id(uid)}/bill-choices${all ? "?all=1" : ""}`));
const choose = (uid: number, body: unknown) => send("PUT", `/api/captures/${id(uid)}/pairing`, body);

async function mark(uids: number[], state: "checked" | "not-bill" | null): Promise<void> {
  expect((await send("PUT", "/api/captures/review", { captureIds: uids.map(id), state })).status).toBe(200);
}

describe("what the pages say", () => {
  it("pairs a payment with its bill and says so on both", async () => {
    await saveEmail(server.store, billEmail(1, "2026-10-06", "80.00", { due: "2026-10-20" }), { uid: 1 });
    await saveEmail(server.store, paymentEmail(2, "2026-10-15", "80.00"), { uid: 2 });
    expect((await detail(2)).payment).toEqual({
      role: "payment",
      bill: { id: id(1), date: "2026-10-06T12:00:00.000Z", amount: 80 },
      how: "auto",
      paidLate: false,
      needsBill: false,
      staleChoice: false,
      locked: false,
    });
    expect((await detail(1)).payment).toEqual({ role: "bill", paidBy: { id: id(2), date: "2026-10-15T12:00:00.000Z" }, ourhome: null });
    const { captures } = await json<CaptureListResponse>(await send("GET", "/api/captures"));
    expect(captures.find((c) => c.id === id(2))!.payment).toMatchObject({ role: "payment", bill: { id: id(1) } });
  });

  it("pays the October bill late when November's came first, leaving November unpaid", async () => {
    await saveEmail(server.store, billEmail(1, "2026-10-06", "80.00"), { uid: 1 });
    await saveEmail(server.store, billEmail(2, "2026-11-06", "80.00"), { uid: 2 });
    await saveEmail(server.store, paymentEmail(3, "2026-11-10", "80.00"), { uid: 3 });
    expect((await detail(3)).payment).toMatchObject({ bill: { id: id(1) }, paidLate: true });
    expect((await detail(2)).payment).toEqual({ role: "bill", paidBy: null, ourhome: null });
  });

  it("says a payment with no fitting bill needs a bill, and holds it back even when Checked", async () => {
    await saveEmail(server.store, billEmail(1, "2026-10-06", "80.00"), { uid: 1 });
    await saveEmail(server.store, paymentEmail(2, "2026-10-15", "40.00"), { uid: 2 });
    await mark([2], "checked");
    const page = await detail(2);
    expect(page.payment).toMatchObject({ role: "payment", bill: null, how: null, needsBill: true });
    expect(page.handoff).toMatchObject({ state: "waits", reason: PAIRING_REASONS.needsBill });
  });

  it("gives other emails no pairing", async () => {
    await saveEmail(server.store, billEmail(1, "2026-10-06", "80.00"), { uid: 1 });
    await mark([1], "not-bill");
    expect((await detail(1)).payment).toBeNull();
  });
});

describe("a person's pick, checked again", () => {
  it("needs a bill again when the picked bill is later marked Not a bill, keeping the choice on record", async () => {
    await saveEmail(server.store, billEmail(1, "2026-10-06", "80.00"), { uid: 1 });
    await saveEmail(server.store, paymentEmail(2, "2026-10-15", "80.00"), { uid: 2 });
    expect((await choose(2, { choice: "bill", billId: id(1) })).status).toBe(200);
    await mark([1], "not-bill");
    await mark([2], "checked");
    const page = await detail(2);
    expect(page.payment).toMatchObject({ bill: null, how: null, needsBill: true, staleChoice: true });
    expect(page.handoff).toMatchObject({ state: "waits", reason: "The bill chosen for this payment can no longer be used. Choose another." });
    expect(server.db.get<{ how: string }>("SELECT how FROM payment_pairings WHERE payment_id = ?", id(2))).toEqual({ how: "person" });
  });

  it("never pairs a pick with a bill a sent payment has taken", async () => {
    await saveEmail(server.store, billEmail(1, "2026-10-06", "80.00"), { uid: 1 });
    await saveEmail(server.store, paymentEmail(2, "2026-10-08", "80.00"), { uid: 2 });
    await saveEmail(server.store, paymentEmail(3, "2026-10-10", "80.00"), { uid: 3 });
    // P1 (2) picks B (1); then P1 is marked Not a bill, and P2 (3) pays B by itself and is sent.
    expect((await choose(2, { choice: "bill", billId: id(1) })).status).toBe(200);
    await mark([2], "not-bill");
    expect((await detail(3)).payment).toMatchObject({ bill: { id: id(1) }, how: "auto" });
    const token = (await json<OurHomeTokenResponse>(await send("POST", "/api/ourhome/token", { startDate: "2026-09-01" }))).token;
    await mark([1, 3], "checked");
    const feed = await json<HandoffDocumentsResponse>(await call(server.app, "/api/handoff/documents", { headers: { Authorization: `Bearer ${token}` } }));
    expect(feed.documents.map((d) => d.captureId)).toEqual([id(1), id(3)]);
    // P1 comes back: its old pick cannot take B from the payment already sent.
    await mark([2], null);
    expect((await detail(2)).payment).toMatchObject({ bill: null, needsBill: true, staleChoice: true });
    expect((await detail(3)).payment).toMatchObject({ bill: { id: id(1) }, locked: true });
    expect((await detail(1)).payment).toMatchObject({ role: "bill", paidBy: { id: id(3) } });
  });
});

describe("two people's picks of one bill", () => {
  it("leave the bill with the earlier pick", async () => {
    await saveEmail(server.store, billEmail(1, "2026-10-06", "80.00"), { uid: 1 });
    await saveEmail(server.store, paymentEmail(2, "2026-10-08", "80.00"), { uid: 2 });
    await saveEmail(server.store, paymentEmail(3, "2026-10-10", "80.00"), { uid: 3 });
    // P1 (2) picks B first; while P1 is marked Not a bill, P2 (3) picks B too.
    server.clock.now = new Date("2026-10-29T12:00:00Z");
    expect((await choose(2, { choice: "bill", billId: id(1) })).status).toBe(200);
    await mark([2], "not-bill");
    server.clock.now = new Date("2026-10-30T12:00:00Z");
    expect((await choose(3, { choice: "bill", billId: id(1) })).status).toBe(200);
    // P1 comes back: its pick was first, so it keeps B, though P2 is newer and listed first.
    await mark([2], null);
    expect((await detail(2)).payment).toMatchObject({ bill: { id: id(1) }, how: "person" });
    expect((await detail(3)).payment).toMatchObject({ bill: null, needsBill: true, staleChoice: true });
    expect((await detail(1)).payment).toMatchObject({ paidBy: { id: id(2) } });
  });
});

describe("the sender's own day", () => {
  it("pairs a payment made the day a bill was sent in the evening, though that is the next day in UTC", async () => {
    await saveEmail(server.store, billEmail(1, "2026-10-06", "80.00", { dateHeader: "Tue, 06 Oct 2026 20:30:00 -0500" }), { uid: 1 });
    await saveEmail(server.store, paymentEmail(2, "2026-10-07", "80.00", { paid: "2026-10-06" }), { uid: 2 });
    expect((await detail(2)).payment).toMatchObject({ bill: { id: id(1), date: "2026-10-07T01:30:00.000Z" }, paidLate: false });
  });

  it("counts a payment sent the evening of the due date as on time", async () => {
    await saveEmail(server.store, billEmail(1, "2026-10-06", "80.00", { due: "2026-10-20" }), { uid: 1 });
    await saveEmail(server.store, paymentEmail(2, "2026-10-21", "80.00", { paid: null, dateHeader: "Tue, 20 Oct 2026 21:00:00 -0500" }), { uid: 2 });
    expect((await detail(2)).payment).toMatchObject({ bill: { id: id(1) }, paidLate: false });
  });
});

describe("locking a pairing", () => {
  it("keeps who chose it only when what was sent is what they chose", () => {
    const householdId = server.db.get<{ id: number }>("SELECT id FROM households")!.id;
    const userId = server.db.get<{ id: number }>("SELECT id FROM users")!.id;
    const now = new Date("2026-11-01T12:00:00Z");
    setPick(server.db, householdId, "p-same", "b1", userId, now);
    setPick(server.db, householdId, "p-other", "b1", userId, now);
    lockPairings(server.db, householdId, [{ paymentId: "p-same", billId: "b1" }, { paymentId: "p-other", billId: "b2" }], now);
    const row = (payment: string) => server.db.get<{ how: string; bill_id: string; chosen_by: number | null }>("SELECT how, bill_id, chosen_by FROM payment_pairings WHERE payment_id = ?", payment);
    expect(row("p-same")).toEqual({ how: "locked", bill_id: "b1", chosen_by: userId });
    expect(row("p-other")).toEqual({ how: "locked", bill_id: "b2", chosen_by: null });
  });
});

describe("the picker", () => {
  beforeEach(async () => {
    await send("POST", "/api/billers", { name: "City Power", kind: "bill", senders: ["power.example"] });
    await saveEmail(server.store, billEmail(1, "2026-09-06", "80.00", { invoice: "W-9" }), { uid: 1 });
    await saveEmail(server.store, billEmail(2, "2026-10-06", "80.00", { due: "2026-10-20" }), { uid: 2 });
    // No amount picked out (a due date makes it a bill).
    await saveEmail(server.store, billEmail(3, "2026-11-06", "", { due: "2026-11-20" }), { uid: 3 });
    await saveEmail(server.store, billEmail(4, "2026-10-10", "55.00", { power: true }), { uid: 4 });
    await saveEmail(server.store, paymentEmail(5, "2026-09-15", "80.00"), { uid: 5 });
    await saveEmail(server.store, paymentEmail(6, "2026-10-15", "200.00"), { uid: 6 });
  });

  it("lists that biller's bills newest first, with each one's state and whether it can be picked", async () => {
    const list = await choices(6);
    expect(list).toMatchObject({ biller: "City Water", all: false, locked: false });
    expect(list.bills.map((b) => [b.id, b.state, b.canPick])).toEqual([
      [id(3), "unusable", false],
      [id(2), "unpaid", true],
      [id(1), "paired", false],
    ]);
    expect(list.bills[2]).toMatchObject({ amount: 80, invoiceNo: "W-9", sender: "City Water", subject: "Your bill 1 is ready", reason: "Another payment already pays this bill.", paidByDate: "2026-09-15T12:00:00.000Z" });
    expect(list.bills[1]!.paidByDate).toBeNull();
    expect(list.bills[1]).toMatchObject({ dueDate: "2026-10-20", reason: null, date: "2026-10-06T12:00:00.000Z" });
    expect(list.bills[0]!.reason).toContain("amount is not settled");
    // Payment 5 sees its own bill as "this".
    expect((await choices(5)).bills.find((b) => b.id === id(1))).toMatchObject({ state: "this", canPick: true });
  });

  it("lists every biller's bills with the switch", async () => {
    const list = await choices(6, true);
    expect(list.all).toBe(true);
    expect(list.bills.map((b) => b.id)).toEqual([id(3), id(4), id(2), id(1)]);
    expect(list.bills.find((b) => b.id === id(4))).toMatchObject({ biller: "City Power", canPick: true });
  });

  it("saves a person's pick, Paid on its own, and Let OurHomeInbox choose", async () => {
    const picked = await choose(6, { choice: "bill", billId: id(2) });
    expect(picked.status).toBe(200);
    expect((await json<PairingResponse>(picked)).payment).toMatchObject({ role: "payment", bill: { id: id(2) }, how: "person", needsBill: false });
    expect((await detail(2)).payment).toMatchObject({ paidBy: { id: id(6) } });

    const own = await json<PairingResponse>(await choose(6, { choice: "own" }));
    expect(own.payment).toMatchObject({ bill: null, how: "own", needsBill: false });
    expect((await detail(2)).payment).toMatchObject({ paidBy: null });

    const auto = await json<PairingResponse>(await choose(6, { choice: "auto" }));
    expect(auto.payment).toMatchObject({ bill: null, how: null, needsBill: true });
    // Another biller's bill can be picked too.
    expect((await json<PairingResponse>(await choose(6, { choice: "bill", billId: id(4) }))).payment).toMatchObject({ bill: { id: id(4) }, how: "person" });
  });

  it("refuses a bill that cannot be picked, one that is not there, an email that is not a payment, and a bad body", async () => {
    const paired = await choose(6, { choice: "bill", billId: id(1) });
    expect(paired.status).toBe(409);
    expect((await json<ApiError>(paired)).error).toBe("Another payment already pays this bill.");
    expect((await choose(6, { choice: "bill", billId: id(3) })).status).toBe(409);
    expect((await choose(6, { choice: "bill", billId: "proton-bills/1700000000/99" })).status).toBe(404);
    expect((await choose(6, { choice: "bill", billId: id(5) })).status).toBe(404);
    const notPayment = await choose(2, { choice: "own" });
    expect(notPayment.status).toBe(409);
    expect((await json<ApiError>(notPayment)).error).toContain("Only a payment email");
    expect((await choose(6, { choice: "maybe" })).status).toBe(400);
    expect((await send("GET", "/api/captures/nowhere/1700000000/6/bill-choices")).status).toBe(404);
    expect(server.db.get<{ n: number }>("SELECT count(*) AS n FROM payment_pairings")!.n).toBe(0);
  });

  it("refuses any change once the payment has been sent to OurHome", async () => {
    const token = (await json<OurHomeTokenResponse>(await send("POST", "/api/ourhome/token", { startDate: "2026-09-01" }))).token;
    await mark([1, 5], "checked");
    const feed = await json<HandoffDocumentsResponse>(await call(server.app, "/api/handoff/documents", { headers: { Authorization: `Bearer ${token}` } }));
    expect(feed.documents.map((d) => d.captureId)).toEqual([id(1), id(5)]);

    const page = await detail(5);
    expect(page.payment).toMatchObject({ bill: { id: id(1) }, how: "auto", locked: true });
    for (const body of [{ choice: "own" }, { choice: "auto" }, { choice: "bill", billId: id(2) }]) {
      const res = await choose(5, body);
      expect(res.status).toBe(409);
      expect((await json<ApiError>(res)).error).toContain("Change it in OurHome");
    }
    const list = await choices(5);
    expect(list.locked).toBe(true);
    expect(list.bills.every((b) => !b.canPick)).toBe(true);
    expect(server.db.get<{ how: string; bill_id: string }>("SELECT how, bill_id FROM payment_pairings WHERE payment_id = ?", id(5))).toEqual({ how: "locked", bill_id: id(1) });
  });
});
