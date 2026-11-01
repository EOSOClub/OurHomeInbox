import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/server/auth.js";
import type { ApiError, CaptureDetailResponse, CaptureListResponse, CaptureReview, CaptureReviewResponse, MailboxListResponse } from "../../src/shared/api.js";
import { MAX_REVIEWED_AT_ONCE } from "../../src/shared/review.js";
import { ADMIN, call, json, makeServer, rawEmail, saveEmail, sessionCookie, setUp, type TestServer } from "./helpers.js";

let server: TestServer;
let cookie: string;

const WATER = "proton-bills/1700000000/1";
const POWER = "proton-bills/1700000000/2";
const FIRST = "2026-10-29T12:00:00.000Z";

beforeEach(async () => {
  server = makeServer();
  cookie = await setUp(server.app);
  await saveEmail(server.store, rawEmail({ subject: "Water bill", date: "Mon, 05 Oct 2026 09:00:00 +0000" }), { uid: 1 });
  await saveEmail(server.store, rawEmail({ subject: "Power bill", date: "Wed, 28 Oct 2026 09:00:00 +0000" }), { uid: 2 });
});

afterEach(() => {
  server.close();
});

const get = (path: string, as = cookie) => call(server.app, path, { cookie: as });

async function mark(body: unknown, as = cookie): Promise<Response> {
  return call(server.app, "/api/captures/review", { method: "PUT", body, cookie: as });
}

async function errorOf(res: Response): Promise<string> {
  return (await json<ApiError>(res)).error;
}

/** Each listed email's mark, by subject. */
async function listed(as = cookie): Promise<Record<string, CaptureReview | null>> {
  const { captures } = await json<CaptureListResponse>(await get("/api/captures", as));
  return Object.fromEntries(captures.map((c) => [c.subject, c.review]));
}

/** Another member of the same household, signed in. */
async function member(): Promise<string> {
  const household = server.db.get<{ id: number }>("SELECT id FROM households")!.id;
  server.db.run(
    "INSERT INTO users (household_id, email, name, password_hash, is_admin, created_at) VALUES (?, 'kim@example.com', 'Kim', ?, 0, '2026-10-29')",
    household,
    await hashPassword("member password 1"),
  );
  return sessionCookie(await call(server.app, "/api/session", { method: "POST", body: { email: "kim@example.com", password: "member password 1" } }))!;
}

/** A second household with its own mailbox and one email in it. */
async function otherHouseholdEmail(): Promise<string> {
  const stamp = "2026-10-29T00:00:00.000Z";
  const household = server.db.run("INSERT INTO households (name, created_at) VALUES ('The Joneses', ?)", stamp).lastInsertRowid;
  server.db.run(
    `INSERT INTO mailboxes (household_id, name, slug, provider, host, port, security, username, folder, created_at, updated_at)
     VALUES (?, 'Their bills', 'their-bills', 'gmail', 'imap.gmail.com', 993, 'tls', 'jo@example.com', 'Bills', ?, ?)`,
    household,
    stamp,
    stamp,
  );
  await saveEmail(server.store, rawEmail({ subject: "Their bill" }), { uid: 7, mailbox: "Their bills" });
  return "their-bills/1700000000/7";
}

describe("reviewing emails", () => {
  it("needs a signed-in person", async () => {
    expect((await call(server.app, "/api/captures/review", { method: "PUT", body: { captureIds: [WATER], state: "checked" } })).status).toBe(401);
  });

  it("starts with every email still to look at", async () => {
    expect(await listed()).toEqual({ "Water bill": null, "Power bill": null });
    expect((await json<CaptureDetailResponse>(await get(`/api/captures/${WATER}`))).review).toBeNull();
  });

  it("marks emails checked, saying who and when, on the list and the email", async () => {
    const res = await mark({ captureIds: [WATER, POWER], state: "checked" });
    expect(res.status).toBe(200);
    const review = { state: "checked", by: ADMIN.name, at: FIRST };
    expect(await json<CaptureReviewResponse>(res)).toEqual({ captures: [{ id: WATER, review }, { id: POWER, review }] });
    expect(await listed()).toEqual({ "Water bill": review, "Power bill": review });
    expect((await json<CaptureDetailResponse>(await get(`/api/captures/${WATER}`))).review).toEqual(review);
  });

  it("marks an email not a bill, and switches it back to checked", async () => {
    await mark({ captureIds: [WATER], state: "not-bill" });
    expect((await listed())["Water bill"]).toEqual({ state: "not-bill", by: ADMIN.name, at: FIRST });
    server.clock.now = new Date("2026-10-30T08:00:00Z");
    await mark({ captureIds: [WATER], state: "checked" });
    expect((await listed())["Water bill"]).toEqual({ state: "checked", by: ADMIN.name, at: "2026-10-30T08:00:00.000Z" });
  });

  it("keeps who marked it first when it is marked the same way again", async () => {
    await mark({ captureIds: [WATER], state: "checked" });
    const kim = await member();
    server.clock.now = new Date("2026-10-30T08:00:00Z");
    const again = await mark({ captureIds: [WATER, POWER], state: "checked" }, kim);
    expect(again.status).toBe(200);
    // Any member can mark; the household sees one mark per email.
    expect(await listed(kim)).toEqual({
      "Water bill": { state: "checked", by: ADMIN.name, at: FIRST },
      "Power bill": { state: "checked", by: "Kim", at: "2026-10-30T08:00:00.000Z" },
    });
  });

  it("clears a mark, so the email needs a look again", async () => {
    await mark({ captureIds: [WATER, POWER], state: "not-bill" });
    const res = await mark({ captureIds: [WATER], state: null });
    expect(await json<CaptureReviewResponse>(res)).toEqual({ captures: [{ id: WATER, review: null }] });
    expect(await listed()).toEqual({ "Water bill": null, "Power bill": { state: "not-bill", by: ADMIN.name, at: FIRST } });
    // Clearing one with no mark is fine.
    expect((await mark({ captureIds: [WATER], state: null })).status).toBe(200);
  });

  it("says nobody when the account that marked it is gone", async () => {
    const kim = await member();
    await mark({ captureIds: [WATER], state: "checked" }, kim);
    server.db.run("DELETE FROM users WHERE email = 'kim@example.com'");
    expect((await listed())["Water bill"]).toEqual({ state: "checked", by: null, at: FIRST });
  });

  it("refuses a change with no email, too many, or no state given", async () => {
    const noEmail = await mark({ captureIds: [], state: "checked" });
    expect(noEmail.status).toBe(400);
    expect(await errorOf(noEmail)).toBe("Choose at least one email.");
    const many = Array.from({ length: MAX_REVIEWED_AT_ONCE + 1 }, (_, i) => `proton-bills/1700000000/${i + 1}`);
    const tooMany = await mark({ captureIds: many, state: "checked" });
    expect(tooMany.status).toBe(400);
    expect(await errorOf(tooMany)).toBe(`Mark at most ${MAX_REVIEWED_AT_ONCE} emails at once.`);
    // Leaving the state out never clears marks by accident.
    for (const body of [{ captureIds: [WATER] }, { captureIds: [WATER], state: "paid" }, { captureIds: [WATER], state: "" }, { captureIds: WATER, state: "checked" }]) {
      const res = await mark(body);
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe("Some of what was sent is missing or not in the right form.");
    }
    expect(await listed()).toEqual({ "Water bill": null, "Power bill": null });
  });

  it("changes nothing when one email is not the household's or does not exist", async () => {
    const theirs = await otherHouseholdEmail();
    for (const bad of [theirs, "proton-bills/1700000000/99", "proton-bills/1700000000/01", "../x/1", "proton-bills/1700000000", "nope/1/1"]) {
      const res = await mark({ captureIds: [WATER, bad], state: "checked" });
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toContain("One of those emails was not found.");
    }
    expect(await listed()).toEqual({ "Water bill": null, "Power bill": null });
  });

  it("keeps another household's marks apart", async () => {
    const theirs = await otherHouseholdEmail();
    // Their mark, written as their own session would.
    server.db.run(
      "INSERT INTO capture_reviews (household_id, capture_id, state, reviewed_by, reviewed_at) VALUES (2, ?, 'checked', NULL, ?)",
      theirs,
      FIRST,
    );
    // A row for one of our ids in their household does not show for us.
    server.db.run("INSERT INTO capture_reviews (household_id, capture_id, state, reviewed_by, reviewed_at) VALUES (2, ?, 'not-bill', NULL, ?)", WATER, FIRST);
    expect(await listed()).toEqual({ "Water bill": null, "Power bill": null });
    await mark({ captureIds: [WATER], state: "checked" });
    expect((await listed())["Water bill"]).toMatchObject({ state: "checked" });
    expect(server.db.get<{ state: string }>("SELECT state FROM capture_reviews WHERE household_id = 2 AND capture_id = ?", WATER)?.state).toBe("not-bill");
  });

  it("keeps a removed mailbox's marks until it is restored", async () => {
    await mark({ captureIds: [WATER], state: "checked" });
    const { mailboxes } = await json<MailboxListResponse>(await get("/api/mailboxes"));
    expect((await call(server.app, `/api/mailboxes/${mailboxes[0]!.id}`, { method: "DELETE", cookie })).status).toBe(204);
    // Its emails cannot be marked while it is removed.
    expect((await mark({ captureIds: [POWER], state: "checked" })).status).toBe(404);
    server.db.run("UPDATE mailboxes SET removed_at = NULL WHERE id = ?", mailboxes[0]!.id);
    expect((await listed())["Water bill"]).toEqual({ state: "checked", by: ADMIN.name, at: FIRST });
  });
});
