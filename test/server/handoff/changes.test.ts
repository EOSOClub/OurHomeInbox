// Contract v2 through the real server (the vault's "Hand-off" note, section
// 6): references on bills and paired payments, a payment always after its
// bill, pairings locked on sending, and OurHome's change reports.

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createToken } from "../../../src/server/handoff/store.js";
import type { ApiError, CaptureDetailResponse } from "../../../src/shared/api.js";
import type { HandoffChangesResponse, HandoffDocumentsResponse, HandoffReadyEntry, OurHomeTokenResponse } from "../../../src/shared/handoff.js";
import { call, json, makeServer, saveEmail, setUp, type TestServer } from "../helpers.js";
import { billEmail, id, paymentEmail } from "../payments/emails.js";

let server: TestServer;
let cookie: string;
let token: string;

const send = (method: string, path: string, body?: unknown) => call(server.app, path, { method, cookie, body });
const detail = async (uid: number) => json<CaptureDetailResponse>(await send("GET", `/api/captures/${id(uid)}`));
const bearer = (value: string) => ({ Authorization: `Bearer ${value}` });

async function mark(uids: number[], state: "checked" | "not-bill" | null): Promise<void> {
  expect((await send("PUT", "/api/captures/review", { captureIds: uids.map(id), state })).status).toBe(200);
}

async function documents(after = 0): Promise<HandoffDocumentsResponse> {
  const res = await call(server.app, `/api/handoff/documents?after=${after}`, { headers: bearer(token) });
  expect(res.status).toBe(200);
  return json<HandoffDocumentsResponse>(res);
}

function report(body: unknown, auth: string | null = token): Promise<Response> {
  return call(server.app, "/api/handoff/changes", { method: "POST", body, headers: auth ? bearer(auth) : {} });
}

const ready = (page: HandoffDocumentsResponse, uid: number) => page.documents.find((d): d is HandoffReadyEntry => d.captureId === id(uid) && d.status === "ready");
const changeRows = () => server.db.get<{ n: number }>("SELECT count(*) AS n FROM ourhome_changes")!.n;

beforeEach(async () => {
  server = makeServer();
  cookie = await setUp(server.app);
  expect((await send("POST", "/api/billers", { name: "City Water", kind: "bill", senders: ["water.example"] })).status).toBe(201);
  token = (await json<OurHomeTokenResponse>(await send("POST", "/api/ourhome/token", { startDate: "2026-09-01" }))).token;
});

afterEach(() => {
  server.close();
});

describe("the feed with payments", () => {
  it("numbers a bill before the payment that references it, even when the payment's email is older", async () => {
    // Emailed before the bill, but paid after it: it pays that bill.
    await saveEmail(server.store, paymentEmail(1, "2026-10-05", "82.50", { paid: "2026-10-12" }), { uid: 1 });
    await saveEmail(server.store, billEmail(2, "2026-10-08", "80.00", { invoice: "INV-778" }), { uid: 2 });
    await mark([1, 2], "checked");
    const page = await documents();
    expect(page.documents.map((d) => [d.number, d.captureId])).toEqual([
      [1, id(2)],
      [2, id(1)],
    ]);
    expect(ready(page, 2)!.document.reference).toBe("INV-778");
    expect(ready(page, 1)!.document).toMatchObject({ kind: "receipt", amount: 82.5, fee: 2.5, baseAmount: 80, reference: "INV-778", paidDate: "2026-10-12" });
    expect(ready(page, 1)!.document).not.toHaveProperty("paidLate");
  });

  it("holds a checked payment until its bill goes, then sends it after the bill with the bill's reference", async () => {
    await saveEmail(server.store, billEmail(1, "2026-10-06", "80.00"), { uid: 1 });
    await saveEmail(server.store, billEmail(2, "2026-11-06", "80.00"), { uid: 2 });
    await saveEmail(server.store, paymentEmail(3, "2026-11-10", "80.00"), { uid: 3 });
    await mark([3], "checked");
    expect((await detail(3)).handoff).toMatchObject({ state: "waits", reason: "Waits for its bill to go to OurHome first." });
    expect((await documents()).documents).toEqual([]);

    await mark([1], "checked");
    const page = await documents();
    expect(page.documents.map((d) => d.captureId)).toEqual([id(1), id(3)]);
    const reference = `ohi:${createHash("sha256").update("<m1@water.example>").digest("hex").slice(0, 24)}`;
    expect(ready(page, 1)!.document.reference).toBe(reference);
    expect(ready(page, 3)!.document).toMatchObject({ reference, fee: 0, baseAmount: 80, paidLate: true });
  });

  it("sends a payment marked Paid on its own with no reference", async () => {
    await saveEmail(server.store, paymentEmail(1, "2026-10-15", "12.00"), { uid: 1 });
    await mark([1], "checked");
    expect((await documents()).documents).toEqual([]);
    expect((await send("PUT", `/api/captures/${id(1)}/pairing`, { choice: "own" })).status).toBe(200);
    const doc = ready(await documents(), 1)!.document;
    expect(doc).toMatchObject({ kind: "receipt", amount: 12 });
    expect(doc).not.toHaveProperty("reference");
  });

  it("holds a payment whose bill is from before the start date", async () => {
    await saveEmail(server.store, billEmail(1, "2026-08-28", "80.00"), { uid: 1 });
    await saveEmail(server.store, paymentEmail(2, "2026-09-05", "80.00"), { uid: 2 });
    await mark([1, 2], "checked");
    expect((await detail(2)).handoff).toMatchObject({ state: "waits", reason: expect.stringContaining("Its bill is from before the OurHome start date") });
    expect((await documents()).documents).toEqual([]);
  });

  it("keeps a bill's reference once offered, even when its invoice number changes", async () => {
    await saveEmail(server.store, billEmail(1, "2026-10-06", "80.00", { invoice: "INV-1", account: "555-01" }), { uid: 1 });
    await mark([1], "checked");
    expect(ready(await documents(), 1)!.document).toMatchObject({ invoiceNo: "INV-1", reference: "INV-1" });
    // A Fix makes the invoice number another value: it is offered again, with the reference it went with.
    const biller = server.db.get<{ id: number }>("SELECT id FROM billers")!;
    expect((await send("PUT", `/api/billers/${biller.id}/rules/invoiceNo`, { label: "Account Number" })).status).toBe(204);
    const again = ready(await documents(1), 1)!.document;
    expect(again).toMatchObject({ invoiceNo: "555-01", reference: "INV-1" });
    // A payment paired with it afterwards carries the same reference.
    await saveEmail(server.store, paymentEmail(2, "2026-10-15", "80.00"), { uid: 2 });
    await mark([2], "checked");
    expect(ready(await documents(2), 2)!.document.reference).toBe("INV-1");
  });

  it("keeps a bill's first reference through a withdrawal, for the bill offered again and its sent payment", async () => {
    await saveEmail(server.store, billEmail(1, "2026-10-06", "80.00", { invoice: "INV-1", account: "555-01" }), { uid: 1 });
    await saveEmail(server.store, paymentEmail(2, "2026-10-15", "80.00"), { uid: 2 });
    await mark([1, 2], "checked");
    expect((await documents()).documents.map((d) => d.captureId)).toEqual([id(1), id(2)]);
    const biller = server.db.get<{ id: number }>("SELECT id FROM billers")!;
    expect((await send("PUT", `/api/billers/${biller.id}/rules/invoiceNo`, { label: "Account Number" })).status).toBe(204);
    await mark([1], "not-bill");
    await mark([1], "checked");
    const later = await documents(2);
    // Only the bill moves: offered again after the Fix, taken back, offered again; the sent payment is never offered again.
    expect(later.documents.every((d) => d.captureId === id(1))).toBe(true);
    expect(later.documents.map((d) => d.status)).toEqual(["ready"]);
    expect(ready(later, 1)!.document).toMatchObject({ invoiceNo: "555-01", reference: "INV-1" });
    const paymentOffer = server.db.get<{ document: string }>("SELECT document FROM handoff_offers WHERE capture_id = ?", id(2))!;
    expect(JSON.parse(paymentOffer.document)).toMatchObject({ reference: "INV-1" });
  });

  describe("the sender's own day, against the start date", () => {
    beforeEach(async () => {
      expect((await send("PUT", "/api/ourhome", { startDate: "2026-11-01" })).status).toBe(200);
    });

    it("keeps a bill sent the evening before the start date out, and says its payment waits for that reason", async () => {
      // 8:30 pm on Oct 31 in Sioux Falls is already Nov 1 in UTC.
      await saveEmail(server.store, billEmail(1, "2026-10-31", "80.00", { dateHeader: "Sat, 31 Oct 2026 20:30:00 -0500" }), { uid: 1 });
      await saveEmail(server.store, paymentEmail(2, "2026-11-05", "80.00"), { uid: 2 });
      await mark([1, 2], "checked");
      expect((await detail(1)).handoff).toMatchObject({ state: "never", reason: expect.stringContaining("before the OurHome connection's start date") });
      expect((await detail(2)).handoff).toMatchObject({ state: "waits", reason: expect.stringContaining("Its bill is from before the OurHome start date") });
      expect((await documents()).documents).toEqual([]);
    });

    it("sends a bill sent just after midnight on the start date by a sender east of UTC, and its payment", async () => {
      // 00:30 on Nov 1 at +0100 is still Oct 31 in UTC.
      await saveEmail(server.store, billEmail(1, "2026-11-01", "80.00", { dateHeader: "Sun, 01 Nov 2026 00:30:00 +0100" }), { uid: 1 });
      await saveEmail(server.store, paymentEmail(2, "2026-11-05", "80.00"), { uid: 2 });
      await mark([1, 2], "checked");
      expect((await documents()).documents.map((d) => [d.captureId, d.status])).toEqual([
        [id(1), "ready"],
        [id(2), "ready"],
      ]);
    });
  });

  it("gives a past due bill sent in the evening that day as its due date, and a payment that evening is on time", async () => {
    await saveEmail(server.store, billEmail(1, "2026-10-20", "80.00", { pastDue: true, dateHeader: "Tue, 20 Oct 2026 20:30:00 -0500" }), { uid: 1 });
    await saveEmail(server.store, paymentEmail(2, "2026-10-21", "80.00", { paid: null, dateHeader: "Tue, 20 Oct 2026 21:00:00 -0500" }), { uid: 2 });
    await mark([1, 2], "checked");
    const page = await documents();
    expect(ready(page, 1)!.document.dueDate).toBe("2026-10-20");
    expect(ready(page, 2)!.document).toMatchObject({ reference: ready(page, 1)!.document.reference });
    expect(ready(page, 2)!.document).not.toHaveProperty("paidLate");
  });

  it("does not take back a sent payment when its bill stops going", async () => {
    await saveEmail(server.store, billEmail(1, "2026-10-06", "80.00"), { uid: 1 });
    await saveEmail(server.store, paymentEmail(2, "2026-10-15", "80.00"), { uid: 2 });
    await mark([1, 2], "checked");
    expect((await documents()).documents.map((d) => d.captureId)).toEqual([id(1), id(2)]);
    await mark([1], "not-bill");
    const page = await documents(2);
    expect(page.documents.map((d) => [d.captureId, d.status])).toEqual([[id(1), "withdrawn"]]);
    expect((await detail(2)).handoff).toMatchObject({ state: "goes", offered: { status: "ready", number: 2 } });
    expect((await detail(2)).handoff.reason).not.toContain("Waits for its bill");
  });

  it("never changes a sent payment's bill when a better one turns up later", async () => {
    await saveEmail(server.store, billEmail(2, "2026-11-06", "80.00"), { uid: 2 });
    await saveEmail(server.store, paymentEmail(3, "2026-11-10", "80.00"), { uid: 3 });
    await mark([2, 3], "checked");
    expect((await documents()).documents.map((d) => d.captureId)).toEqual([id(2), id(3)]);
    // The October bill arrives late: it would be the oldest fit now.
    await saveEmail(server.store, billEmail(1, "2026-10-06", "80.00"), { uid: 1 });
    await mark([1], "checked");
    const page = await documents(2);
    expect(page.documents.map((d) => d.captureId)).toEqual([id(1)]);
    expect((await detail(3)).payment).toMatchObject({ bill: { id: id(2) }, locked: true });
    expect((await detail(1)).payment).toMatchObject({ paidBy: null });
  });
});

describe("POST /api/handoff/changes", () => {
  beforeEach(async () => {
    await saveEmail(server.store, billEmail(1, "2026-10-06", "80.00"), { uid: 1 });
    await saveEmail(server.store, billEmail(2, "2026-11-06", "80.00"), { uid: 2 });
    await saveEmail(server.store, paymentEmail(3, "2026-11-10", "80.00"), { uid: 3 });
    await mark([1, 2], "checked");
    expect((await documents()).documents).toHaveLength(2);
  });

  const paid = { messageId: "<m1@water.example>", change: "paid", at: "2026-11-03T15:20:00.000Z" };

  it("refuses without the token, or with a wrong one, as the other feed routes do", async () => {
    const none = await report({ changes: [paid] }, null);
    expect(none.status).toBe(401);
    expect(none.headers.get("WWW-Authenticate")).toContain("Bearer");
    expect((await json<ApiError>(none)).error).toContain("sent no token");
    expect((await report({ changes: [paid] }, `${token}x`)).status).toBe(401);
    // A sign-in is not enough.
    expect((await call(server.app, "/api/handoff/changes", { method: "POST", cookie, body: { changes: [paid] } })).status).toBe(401);
    expect(changeRows()).toBe(0);
  });

  it("refuses a body that breaks the rules and keeps nothing from it", async () => {
    const tooMany = Array.from({ length: 101 }, () => paid);
    for (const body of [
      {},
      { changes: [] },
      { changes: tooMany },
      { changes: [paid, { ...paid, change: "deleted" }] },
      { changes: [paid, { ...paid, at: "yesterday" }] },
      { changes: [paid, { ...paid, at: "2026-11-03" }] },
      { changes: [{ ...paid, messageId: "" }] },
      { changes: [{ change: "paid", at: paid.at }] },
      "not json",
    ]) {
      const res = await report(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await json<ApiError>(res)).error).toBeTruthy();
    }
    expect(changeRows()).toBe(0);
  });

  it("counts and drops messageIds it never offered, and takes the same report again harmlessly", async () => {
    const unknown = await report({ changes: [paid, { ...paid, messageId: "<never@water.example>" }, { ...paid, messageId: "<m3@water.example>" }] });
    expect(unknown.status).toBe(200);
    expect(await json<HandoffChangesResponse>(unknown)).toEqual({ accepted: 1, unknown: 2 });
    expect(await json<HandoffChangesResponse>(await report({ changes: [paid] }))).toEqual({ accepted: 1, unknown: 0 });
    expect(changeRows()).toBe(1);
  });

  it("takes 100 changes with Message-IDs at their longest, while other routes keep their smaller limit", async () => {
    const longest = Array.from({ length: 100 }, (_, n) => ({ ...paid, messageId: `<${String(n).padStart(3, "0")}${"x".repeat(993)}>` }));
    expect(longest[0]!.messageId).toHaveLength(998);
    const res = await report({ changes: longest });
    expect(res.status).toBe(200);
    expect(await json<HandoffChangesResponse>(res)).toEqual({ accepted: 0, unknown: 100 });
    expect((await send("PUT", "/api/captures/review", { captureIds: ["a".repeat(70_000)], state: null })).status).toBe(413);
  });

  it("keeps each time in one form, whatever offset OurHome wrote", async () => {
    await report({ changes: [{ ...paid, at: "2026-11-03T10:20:00-05:00" }] });
    expect(server.db.get<{ at: string }>("SELECT at FROM ourhome_changes")!.at).toBe("2026-11-03T15:20:00.000Z");
    expect((await detail(1)).payment).toMatchObject({ ourhome: { change: "paid", at: "2026-11-03T15:20:00.000Z" } });
  });

  it("only ever touches the reporting household's emails", async () => {
    const stamp = "2026-10-29T00:00:00.000Z";
    const theirs = Number(server.db.run("INSERT INTO households (name, created_at) VALUES ('The Joneses', ?)", stamp).lastInsertRowid);
    const user = Number(server.db.run("INSERT INTO users (household_id, email, name, password_hash, is_admin, created_at) VALUES (?, 'jo@example.com', 'Jo', 'x', 1, ?)", theirs, stamp).lastInsertRowid);
    // The other household was offered an email with the same Message-ID as ours.
    server.db.run(
      "INSERT INTO handoff_offers (household_id, capture_id, number, status, message_id, fingerprint, document, reason, offered_at) VALUES (?, 'theirs/1/1', 1, 'ready', '<m1@water.example>', 'x', '{}', NULL, ?)",
      theirs,
      stamp,
    );
    const theirToken = createToken(server.db, theirs, user, "2026-09-01", new Date());
    expect(await json<HandoffChangesResponse>(await report({ changes: [paid] }))).toEqual({ accepted: 1, unknown: 0 });
    expect(server.db.get<{ n: number }>("SELECT count(*) AS n FROM ourhome_changes WHERE household_id = ?", theirs)!.n).toBe(0);
    // Their token cannot report on an email only we were offered.
    expect(await json<HandoffChangesResponse>(await report({ changes: [{ ...paid, messageId: "<m2@water.example>" }] }, theirToken))).toEqual({ accepted: 0, unknown: 1 });
    expect((await detail(2)).payment).toMatchObject({ ourhome: null });
  });

  it("takes a bill reported paid or removed out of pairing, and says so on its page", async () => {
    expect((await detail(3)).payment).toMatchObject({ bill: { id: id(1) }, how: "auto", paidLate: true });
    await report({ changes: [paid] });
    expect((await detail(1)).payment).toEqual({ role: "bill", paidBy: null, ourhome: { change: "paid", at: "2026-11-03T15:20:00.000Z" } });
    // The unlocked automatic pairing falls away: the payment takes November's bill, on time.
    expect((await detail(3)).payment).toMatchObject({ bill: { id: id(2) }, paidLate: false, needsBill: false });

    await report({ changes: [{ messageId: "<m2@water.example>", change: "removed", at: "2026-11-12T08:00:00.000Z" }] });
    expect((await detail(2)).payment).toMatchObject({ ourhome: { change: "removed" } });
    expect((await detail(3)).payment).toMatchObject({ bill: null, needsBill: true });
    // The picker shows both, and neither can be picked.
    const list = await json<{ bills: Array<{ id: string; state: string; canPick: boolean }> }>(await send("GET", `/api/captures/${id(3)}/bill-choices`));
    expect(list.bills.map((b) => [b.id, b.state, b.canPick])).toEqual([
      [id(2), "removed", false],
      [id(1), "paid", false],
    ]);
  });
});
