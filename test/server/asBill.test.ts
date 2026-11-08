// A reminder used as the bill (owner, 2026-11-07), through the real server:
// marking it and taking the mark off, what the list, the email's page,
// pairing and the hand-off then say, and what is refused. Then a biller whose
// reminders are its bills (2026-11-08).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { byBillerAlready, NOT_A_REMINDER } from "../../src/server/asBill.js";
import { repeatReason } from "../../src/server/copies.js";
import { PAIRING_REASONS, REMINDER_REASON } from "../../src/server/handoff/rules.js";
import type { ApiError, AsBillResponse, Biller, BillerListResponse, CaptureDetailResponse, CaptureListResponse } from "../../src/shared/api.js";
import { ADMIN, call, json, makeServer, saveEmail, setUp, type TestServer } from "./helpers.js";
import { billEmail, id, paymentEmail, reminderEmail } from "./payments/emails.js";

let server: TestServer;
let cookie: string;

const MARKED_AT = "2026-11-20T12:00:00.000Z";

beforeEach(async () => {
  server = makeServer();
  cookie = await setUp(server.app);
  expect((await send("POST", "/api/billers", { name: "City Water", kind: "bill", senders: ["water.example"] })).status).toBe(201);
  // Past the 14 days an October payment waits for its bill email, so one with no bill needs a bill.
  server.clock.now = new Date(MARKED_AT);
});

afterEach(() => {
  server.close();
});

const send = (method: string, path: string, body?: unknown, as = cookie) => call(server.app, path, { method, cookie: as, body });
const detail = async (uid: number) => json<CaptureDetailResponse>(await send("GET", `/api/captures/${id(uid)}`));
const listed = async (uid: number) => (await json<CaptureListResponse>(await send("GET", "/api/captures"))).captures.find((c) => c.id === id(uid))!;
const asBill = (uid: number, value: unknown) => send("PUT", `/api/captures/${id(uid)}/as-bill`, { asBill: value });
const errorOf = async (res: Response) => (await json<ApiError>(res)).error;

describe("using a reminder as the bill", () => {
  it("needs a signed-in person", async () => {
    await saveEmail(server.store, reminderEmail(1, "2026-10-06", "80.00"), { uid: 1 });
    expect((await call(server.app, `/api/captures/${id(1)}/as-bill`, { method: "PUT", body: { asBill: true } })).status).toBe(401);
  });

  it("turns a reminder that is never sent into a bill, saying who marked it and why it was a reminder", async () => {
    await saveEmail(server.store, reminderEmail(1, "2026-10-06", "80.00", { due: "2026-10-20" }), { uid: 1 });
    const before = await detail(1);
    expect([before.extraction.kind, before.asBill, before.handoff.state, before.handoff.reason]).toEqual(["reminder", null, "never", REMINDER_REASON]);
    expect(before.payment).toBeNull();

    const res = await asBill(1, true);
    expect(res.status).toBe(200);
    const mark = { by: ADMIN.name, at: MARKED_AT };
    expect(await json<AsBillResponse>(res)).toEqual({ asBill: mark });

    const after = await detail(1);
    expect(after.asBill).toEqual(mark);
    expect(after.extraction.kind).toBe("bill");
    expect(after.extraction.kindReason).toBe(`Marked as the bill by ${ADMIN.name}. On its own, OurHomeInbox took it for a reminder. The subject says "Reminder".`);
    // A bill like any other: what pays it, and the usual check before OurHome.
    expect(after.payment).toEqual({ role: "bill", paidBy: null, alsoPaidBy: [], part: null, ourhome: null });
    expect(after.handoff.state).toBe("waits");
    expect((await listed(1)).picked.kind).toBe("bill");
  });

  it("lets a payment with no bill email pay the reminder once it is the bill, and undoes it when the mark comes off", async () => {
    await saveEmail(server.store, reminderEmail(1, "2026-10-06", "80.00"), { uid: 1 });
    await saveEmail(server.store, paymentEmail(2, "2026-10-15", "80.00"), { uid: 2 });
    expect((await detail(2)).payment).toMatchObject({ bill: null, needsBill: true });

    expect((await asBill(1, true)).status).toBe(200);
    expect((await detail(2)).payment).toMatchObject({ bill: { id: id(1) }, needsBill: false, how: "auto" });
    expect((await detail(1)).payment).toMatchObject({ role: "bill", paidBy: { id: id(2) } });

    const off = await asBill(1, false);
    expect(off.status).toBe(200);
    expect(await json<AsBillResponse>(off)).toEqual({ asBill: null });
    const page = await detail(1);
    expect([page.extraction.kind, page.asBill, page.handoff.reason]).toEqual(["reminder", null, REMINDER_REASON]);
    expect((await detail(2)).payment).toMatchObject({ bill: null, needsBill: true });
    expect((await detail(2)).handoff.reason).toBe(PAIRING_REASONS.needsBill);
    // Taking off a mark that is not there is fine.
    expect((await asBill(1, false)).status).toBe(200);
  });

  it("is counted once when the bill's own email is there too", async () => {
    // The reminder repeats the bill: same amount and due date, a few days later.
    await saveEmail(server.store, billEmail(1, "2026-10-06", "80.00", { due: "2026-10-20" }), { uid: 1 });
    await saveEmail(server.store, reminderEmail(2, "2026-10-10", "80.00", { due: "2026-10-20" }), { uid: 2 });
    await asBill(2, true);
    const reminder = await detail(2);
    expect(reminder.extraction.kind).toBe("bill");
    expect(reminder.handoff).toMatchObject({ state: "never", reason: repeatReason("City Water", "2026-10-06") });
  });

  it("keeps who marked it first when it is marked again", async () => {
    await saveEmail(server.store, reminderEmail(1, "2026-10-06", "80.00"), { uid: 1 });
    await asBill(1, true);
    server.clock.now = new Date("2026-11-21T12:00:00Z");
    expect(await json<AsBillResponse>(await asBill(1, true))).toEqual({ asBill: { by: ADMIN.name, at: MARKED_AT } });
  });

  it("refuses an email that is not a reminder", async () => {
    await saveEmail(server.store, billEmail(1, "2026-10-06", "80.00"), { uid: 1 });
    await saveEmail(server.store, paymentEmail(2, "2026-10-15", "80.00"), { uid: 2 });
    for (const uid of [1, 2]) {
      const res = await asBill(uid, true);
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toBe(NOT_A_REMINDER);
    }
    expect(server.db.get("SELECT 1 FROM capture_as_bill")).toBeUndefined();
  });

  it("refuses a body without true or false, and an email that is not the household's", async () => {
    await saveEmail(server.store, reminderEmail(1, "2026-10-06", "80.00"), { uid: 1 });
    for (const value of [undefined, "yes", 1, null]) {
      const res = await asBill(1, value);
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe("Some of what was sent is missing or not in the right form.");
    }
    expect((await asBill(99, true)).status).toBe(404);
    expect((await send("PUT", "/api/captures/their-bills/1700000000/1/as-bill", { asBill: true })).status).toBe(404);
    expect((await send("PUT", "/api/captures/proton-bills/1700000000/01/as-bill", { asBill: true })).status).toBe(400);
    expect(server.db.get("SELECT 1 FROM capture_as_bill")).toBeUndefined();
  });

  it("keeps another household's marks apart", async () => {
    await saveEmail(server.store, reminderEmail(1, "2026-10-06", "80.00"), { uid: 1 });
    const stamp = "2026-10-29T00:00:00.000Z";
    const other = server.db.run("INSERT INTO households (name, created_at) VALUES ('The Joneses', ?)", stamp).lastInsertRowid;
    // A mark for one of our ids in their household does not count for us.
    server.db.run("INSERT INTO capture_as_bill (household_id, capture_id, marked_by, marked_at) VALUES (?, ?, NULL, ?)", other, id(1), stamp);
    const page = await detail(1);
    expect([page.extraction.kind, page.asBill]).toEqual(["reminder", null]);
  });
});

describe("a biller whose reminders are its bills (2026-11-08)", () => {
  const water = async () => (await json<BillerListResponse>(await send("GET", "/api/billers"))).billers[0]!;
  /** Saves the biller with the setting as given (left out when undefined), as its page's form does. */
  const setReminders = async (value: boolean | undefined) => {
    const { id: billerId, name, kind, senders, notes, fetchInvoices } = await water();
    const res = await send("PUT", `/api/billers/${billerId}`, { name, kind, senders, notes, fetchInvoices, remindersAreBills: value });
    expect(res.status).toBe(200);
    return json<Biller>(res);
  };

  it("is off for a new biller, and saved with the biller's form", async () => {
    expect((await water()).remindersAreBills).toBe(false);
    expect((await setReminders(true)).remindersAreBills).toBe(true);
    expect((await water()).remindersAreBills).toBe(true);
    // The form sends the whole biller: left out is off, like any other field.
    expect((await setReminders(undefined)).remindersAreBills).toBe(false);
    const res = await send("POST", "/api/billers", { name: "Xcel Energy", kind: "bill", senders: ["xcel.example"], remindersAreBills: true });
    expect((await json<Biller>(res)).remindersAreBills).toBe(true);
    expect((await send("POST", "/api/billers", { name: "Gas", kind: "bill", senders: ["gas.example"], remindersAreBills: "yes" })).status).toBe(400);
  });

  it("uses each of its reminders as the bill, and makes them reminders again when turned off", async () => {
    await saveEmail(server.store, reminderEmail(1, "2026-10-06", "80.00", { due: "2026-10-20" }), { uid: 1 });
    await saveEmail(server.store, paymentEmail(2, "2026-10-15", "80.00"), { uid: 2 });
    await setReminders(true);

    const page = await detail(1);
    expect([page.extraction.kind, page.asBill, page.asBillByBiller]).toEqual(["bill", null, true]);
    expect(page.extraction.kindReason).toBe(
      `City Water sends its bills as reminders (set on the biller's page), so this reminder is used as the bill. On its own, OurHomeInbox took it for a reminder. The subject says "Reminder".`,
    );
    expect(page.handoff.state).toBe("waits");
    expect((await listed(1)).picked.kind).toBe("bill");
    expect((await detail(2)).payment).toMatchObject({ bill: { id: id(1) }, needsBill: false });
    // No mark needed, or taken: the setting already does it.
    const res = await asBill(1, true);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe(byBillerAlready("City Water"));
    expect(server.db.get("SELECT 1 FROM capture_as_bill")).toBeUndefined();

    await setReminders(false);
    const off = await detail(1);
    expect([off.extraction.kind, off.asBillByBiller, off.handoff.reason]).toEqual(["reminder", false, REMINDER_REASON]);
    expect((await detail(2)).payment).toMatchObject({ bill: null, needsBill: true });
  });

  it("comes before a person's mark, which stands again once the setting is off", async () => {
    await saveEmail(server.store, reminderEmail(1, "2026-10-06", "80.00"), { uid: 1 });
    await asBill(1, true);
    await setReminders(true);
    const on = await detail(1);
    expect([on.extraction.kind, on.asBill, on.asBillByBiller]).toEqual(["bill", null, true]);
    await setReminders(false);
    const off = await detail(1);
    expect([off.extraction.kind, off.asBill, off.asBillByBiller]).toEqual(["bill", { by: ADMIN.name, at: MARKED_AT }, false]);
  });

  it("leaves its bills as they are, and counts a reminder about a bill already in once, even weeks later", async () => {
    await saveEmail(server.store, billEmail(1, "2026-10-01", "80.00", { due: "2026-10-25" }), { uid: 1 });
    // Nineteen days later: past the week two bill emails can be apart, but the same amount and due date.
    await saveEmail(server.store, reminderEmail(2, "2026-10-20", "80.00", { due: "2026-10-25" }), { uid: 2 });
    await setReminders(true);
    const bill = await detail(1);
    expect([bill.extraction.kind, bill.asBillByBiller, bill.handoff.state]).toEqual(["bill", false, "waits"]);
    expect((await detail(2)).handoff).toMatchObject({ state: "never", reason: repeatReason("City Water", "2026-10-01") });
    // A bill email is refused a mark too, with the same reason.
    expect(await errorOf(await asBill(1, true))).toBe(byBillerAlready("City Water"));
  });
});
