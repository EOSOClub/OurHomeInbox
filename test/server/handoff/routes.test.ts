// The hand-off to OurHome through the real server: the token (made, replaced,
// turned off), the feed OurHome reads (the contract in the vault's "Hand-off"
// note, section 6), and a biller earning Send automatically (section 2).

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createToken } from "../../../src/server/handoff/store.js";
import type { ApiError, Biller, CaptureDetailResponse, CaptureListResponse, CaptureReviewResponse } from "../../../src/shared/api.js";
import type { HandoffDocumentsResponse, HandoffHelloResponse, OurHomeConnection, OurHomeTokenResponse } from "../../../src/shared/handoff.js";
import { call, json, makeServer, saveEmail, setUp, type TestServer } from "../helpers.js";

let server: TestServer;
let cookie: string;

const id = (uid: number) => `proton-bills/1700000000/${uid}`;

/** A City Water bill: verified by Proton unless told otherwise, with one amount unless given its own body. */
function bill(uid: number, options: { verified?: boolean; date?: string; html?: string } = {}): Buffer {
  const lines = [
    "From: City Water <billing@water.example>",
    "To: sam@proton.me",
    `Subject: Water bill ${uid}`,
    `Date: ${options.date ?? "Tue, 20 Oct 2026 14:00:00 +0000"}`,
    `Message-ID: <bill-${uid}@water.example>`,
    "Received: by mailin.protonmail.ch",
    `Authentication-Results: mail.protonmail.ch; dmarc=${options.verified === false ? "fail" : "pass"} (p=reject dis=none) header.from=water.example`,
    "Content-Type: text/html",
    "",
    // Each its own bill: a due date of its own (bill 1 is due 11/04), or same-day bills would be one bill sent twice (copies.ts).
    options.html ?? `<table><tr><td>Amount Due:</td><td>$42.10</td></tr><tr><td>Due Date:</td><td>11/${String(3 + uid).padStart(2, "0")}/2026</td></tr></table>`,
    "",
  ];
  return Buffer.from(lines.join("\r\n"));
}

const TWO_AMOUNTS = "<p>Amount Due: $10.00</p><p>Amount Due: $12.00</p><p>Due Date: 11/04/2026</p>";

beforeEach(async () => {
  server = makeServer();
  cookie = await setUp(server.app);
});

afterEach(() => {
  server.close();
});

const send = (method: string, path: string, body?: unknown) => call(server.app, path, { method, cookie, body });

async function addWater(): Promise<Biller> {
  const res = await send("POST", "/api/billers", { name: "City Water", kind: "bill", senders: ["water.example"] });
  expect(res.status).toBe(201);
  return json<Biller>(res);
}

async function connect(startDate = "2026-10-01"): Promise<string> {
  const res = await send("POST", "/api/ourhome/token", { startDate });
  expect(res.status).toBe(201);
  return (await json<OurHomeTokenResponse>(res)).token;
}

function feed(token: string | null, query = ""): Promise<Response> {
  return call(server.app, `/api/handoff/documents${query}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
}

async function documents(token: string, query = ""): Promise<HandoffDocumentsResponse> {
  const res = await feed(token, query);
  expect(res.status).toBe(200);
  return json<HandoffDocumentsResponse>(res);
}

async function mark(uids: number[], state: "checked" | "not-bill" | null): Promise<CaptureReviewResponse> {
  const res = await send("PUT", "/api/captures/review", { captureIds: uids.map(id), state });
  expect(res.status).toBe(200);
  return json<CaptureReviewResponse>(res);
}

async function detail(uid: number): Promise<CaptureDetailResponse> {
  return json<CaptureDetailResponse>(await call(server.app, `/api/captures/${id(uid)}`, { cookie }));
}

describe("the OurHome token", () => {
  it("is made once, shown once, and kept only as a hash", async () => {
    expect(await json<OurHomeConnection>(await send("GET", "/api/ourhome"))).toMatchObject({ connected: false, startDate: null, newest: 0 });
    const res = await send("POST", "/api/ourhome/token", { startDate: "2026-10-01" });
    const { token, connection } = await json<OurHomeTokenResponse>(res);
    expect(token).toMatch(/^ohi_[A-Za-z0-9_-]{43}$/);
    expect(connection).toMatchObject({ connected: true, startDate: "2026-10-01", tokenCreatedBy: "Sam Smith", lastUsedAt: null });
    const stored = server.db.get<{ token_hash: string }>("SELECT token_hash FROM handoff_connections")!;
    expect(stored.token_hash).not.toContain(token.slice(4));
    expect(JSON.stringify(await json(await send("GET", "/api/ourhome")))).not.toContain(token);
  });

  it("refuses the feed without the token, with a wrong one, or with only a sign-in", async () => {
    const token = await connect();
    const none = await feed(null);
    expect(none.status).toBe(401);
    expect(none.headers.get("WWW-Authenticate")).toContain("Bearer");
    expect((await json<ApiError>(none)).error).toContain("sent no token");
    expect((await json<ApiError>(await feed(`${token}x`))).error).toContain("does not work");
    expect((await feed("ohi_" + "a".repeat(43))).status).toBe(401);
    expect((await call(server.app, "/api/handoff/documents", { cookie })).status).toBe(401);
    expect((await feed(token)).status).toBe(200);
  });

  it("stops working when replaced or turned off; the start date stays", async () => {
    const first = await connect("2026-10-05");
    const second = await connect();
    expect((await feed(first)).status).toBe(401);
    expect((await feed(second)).status).toBe(200);
    const off = await json<OurHomeConnection>(await send("DELETE", "/api/ourhome/token"));
    expect(off).toMatchObject({ connected: false, startDate: "2026-10-01" });
    expect((await feed(second)).status).toBe(401);
    // A token made without a date keeps the one set before.
    const third = (await json<OurHomeTokenResponse>(await send("POST", "/api/ourhome/token", {}))).connection;
    expect(third.startDate).toBe("2026-10-01");
  });

  it("says hello with the household, the newest number and the start date", async () => {
    const token = await connect();
    const res = await call(server.app, "/api/handoff/hello", { headers: { Authorization: `Bearer ${token}` } });
    expect(await json<HandoffHelloResponse>(res)).toEqual({ household: "The Smiths", newest: 0, startDate: "2026-10-01" });
    expect((await json<OurHomeConnection>(await send("GET", "/api/ourhome"))).lastUsedAt).not.toBeNull();
  });

  it("changes the start date, refusing a day that is not real or a household with no token yet", async () => {
    expect((await send("PUT", "/api/ourhome", { startDate: "2026-10-01" })).status).toBe(409);
    await connect();
    expect((await json<OurHomeConnection>(await send("PUT", "/api/ourhome", { startDate: "2026-09-15" }))).startDate).toBe("2026-09-15");
    expect((await json<ApiError>(await send("PUT", "/api/ourhome", { startDate: "2026-02-30" }))).error).toBe("Choose a real day for the start date.");
  });

  it("only ever shows a household its own emails", async () => {
    await addWater();
    await saveEmail(server.store, bill(1), { uid: 1 });
    await connect();
    await mark([1], "checked");
    const stamp = "2026-10-29T00:00:00.000Z";
    const theirs = Number(server.db.run("INSERT INTO households (name, created_at) VALUES ('The Joneses', ?)", stamp).lastInsertRowid);
    const user = Number(server.db.run("INSERT INTO users (household_id, email, name, password_hash, is_admin, created_at) VALUES (?, 'jo@example.com', 'Jo', 'x', 1, ?)", theirs, stamp).lastInsertRowid);
    const theirToken = createToken(server.db, theirs, user, "2026-10-01", new Date());
    expect(await documents(theirToken)).toEqual({ documents: [], next: 0, more: false });
  });
});

describe("the feed OurHome reads", () => {
  beforeEach(async () => {
    await addWater();
    await saveEmail(server.store, bill(1, { date: "Mon, 05 Oct 2026 09:00:00 +0000" }), { uid: 1 });
    await saveEmail(server.store, bill(2), { uid: 2 });
  });

  it("offers nothing until there is a token, then only what goes", async () => {
    await mark([1], "checked");
    expect(server.db.get<{ n: number }>("SELECT count(*) AS n FROM handoff_offers")!.n).toBe(0);
    const token = await connect();
    const page = await documents(token);
    expect(page).toEqual({
      documents: [
        {
          number: 1,
          captureId: id(1),
          link: `/mail/${id(1)}`,
          status: "ready",
          document: {
            kind: "bill",
            messageId: "<bill-1@water.example>",
            biller: "City Water",
            billerKey: expect.stringMatching(/^ourhomeinbox-biller:\d+$/),
            billerEmail: "billing@water.example",
            subject: "Water bill 1",
            amount: 42.1,
            dueDate: "2026-11-04",
            emailDate: "2026-10-05T09:00:00.000Z",
            reference: `ohi:${createHash("sha256").update("<bill-1@water.example>").digest("hex").slice(0, 24)}`,
          },
        },
      ],
      next: 1,
      more: false,
    });
    // Asking again after it: nothing new, and the same reply for the same question.
    expect(await documents(token, "?after=1")).toEqual({ documents: [], next: 1, more: false });
    expect((await documents(token)).documents).toHaveLength(1);
  });

  it("says on each email whether it goes, and when OurHome has it", async () => {
    await mark([1], "checked");
    expect((await detail(1)).handoff).toEqual({ state: "goes", reason: "Checked by Sam Smith.", connected: false, offered: null });
    expect((await detail(2)).handoff).toMatchObject({ state: "waits", reason: expect.stringContaining("City Water's emails are checked each time") });
    const token = await connect();
    await documents(token);
    expect((await detail(1)).handoff).toMatchObject({ connected: true, offered: { status: "ready", number: 1, taken: false } });
    await documents(token, "?after=1");
    expect((await detail(1)).handoff.offered).toMatchObject({ taken: true });
    const { captures } = await json<CaptureListResponse>(await call(server.app, "/api/captures", { cookie }));
    expect(captures.find((c) => c.id === id(1))!.handoff.offered?.taken).toBe(true);
  });

  it("offers an email again with a new number when what OurHome gets changes", async () => {
    const token = await connect();
    await mark([1], "checked");
    expect((await documents(token)).next).toBe(1);
    // Renaming the biller changes the document.
    const biller = server.db.get<{ id: number }>("SELECT id FROM billers")!;
    await send("PUT", `/api/billers/${biller.id}`, { name: "Sioux Falls Water", kind: "bill", senders: ["water.example"] });
    const again = await documents(token, "?after=1");
    expect(again.documents).toEqual([expect.objectContaining({ number: 2, captureId: id(1), status: "ready", document: expect.objectContaining({ biller: "Sioux Falls Water" }) })]);
  });

  it("withdraws an email once when it stops going, and offers it again if it goes again", async () => {
    const token = await connect();
    await mark([1], "checked");
    await documents(token);
    await mark([1], "not-bill");
    const withdrawn = await documents(token, "?after=1");
    expect(withdrawn).toEqual({
      documents: [{ number: 2, captureId: id(1), link: `/mail/${id(1)}`, status: "withdrawn", messageId: "<bill-1@water.example>", reason: "Marked Not a bill." }],
      next: 2,
      more: false,
    });
    expect((await documents(token, "?after=2")).documents).toEqual([]);
    await mark([1], "checked");
    expect((await documents(token, "?after=2")).documents).toEqual([expect.objectContaining({ number: 3, status: "ready" })]);
  });

  it("never offers an email dated before the start date, unless the date is moved back", async () => {
    const token = await connect("2026-10-10");
    await mark([1, 2], "checked");
    expect((await documents(token)).documents.map((d) => d.captureId)).toEqual([id(2)]);
    expect((await detail(1)).handoff).toMatchObject({ state: "never", reason: expect.stringContaining("start date") });
    await send("PUT", "/api/ourhome", { startDate: "2026-10-01" });
    expect((await documents(token, "?after=1")).documents.map((d) => d.captureId)).toEqual([id(1)]);
  });

  it("does not take bills back from OurHome when a mailbox is removed", async () => {
    const token = await connect();
    await mark([1, 2], "checked");
    expect((await documents(token)).next).toBe(2);
    const mailbox = server.db.get<{ id: number }>("SELECT id FROM mailboxes")!;
    expect((await send("DELETE", `/api/mailboxes/${mailbox.id}`)).status).toBe(204);
    expect(await documents(token, "?after=2")).toEqual({ documents: [], next: 2, more: false });
  });

  it("pages with limit, numbering the oldest first, and refuses a bad query", async () => {
    const token = await connect();
    await mark([1, 2], "checked");
    const first = await documents(token, "?limit=1");
    expect(first).toMatchObject({ next: 1, more: true });
    expect(first.documents[0]!.captureId).toBe(id(1));
    expect(await documents(token, "?after=1&limit=1")).toMatchObject({ next: 2, more: false });
    for (const query of ["?after=-1", "?after=abc", "?limit=0", "?limit=201", "?limit=1.5"]) {
      expect((await feed(token, query)).status, query).toBe(400);
    }
  });

  it("never counts more as handled than was offered", async () => {
    const token = await connect();
    await documents(token, "?after=999");
    expect((await json<OurHomeConnection>(await send("GET", "/api/ourhome"))).takenUpTo).toBe(0);
  });
});

describe("earning Send automatically", () => {
  let water: Biller;

  beforeEach(async () => {
    water = await addWater();
    for (const uid of [1, 2, 3, 4, 5]) await saveEmail(server.store, bill(uid), { uid });
  });

  const run = async () => (await json<Biller>(await send("GET", `/api/billers/${water.id}`))).cleanChecks;

  it("offers it on the third clean check in a row, and once it is on, clean emails go by themselves", async () => {
    expect((await mark([1], "checked")).offerAutoSend).toEqual([]);
    expect((await mark([2], "checked")).offerAutoSend).toEqual([]);
    expect(await run()).toBe(2);
    expect((await mark([3], "checked")).offerAutoSend).toEqual([{ id: water.id, name: "City Water" }]);

    const on = await json<Biller>(await send("PUT", `/api/billers/${water.id}/auto-send`, { autoSend: true }));
    expect(on).toMatchObject({ autoSend: true, cleanChecks: 0 });
    expect((await detail(4)).handoff).toMatchObject({ state: "goes", reason: "Sent automatically: City Water's emails need no check." });
    // Once on, it is not offered again.
    expect((await mark([4, 5], "checked")).offerAutoSend).toEqual([]);
  });

  it("counts several marked at once, but each email only once", async () => {
    expect((await mark([1, 2, 3], "checked")).offerAutoSend).toEqual([{ id: water.id, name: "City Water" }]);
    await send("PUT", `/api/billers/${water.id}/auto-send`, { autoSend: false });
    await mark([1], null);
    expect((await mark([1], "checked")).offerAutoSend).toEqual([]);
    expect(await mark([1], "checked")).toMatchObject({ offerAutoSend: [] });
    expect(await run()).toBe(1);
  });

  it("starts the run again after a Fix, a Checked email with a doubt or an unverified sender, or Not now", async () => {
    await mark([1, 2], "checked");
    await send("PUT", `/api/billers/${water.id}/rules/amount`, { label: "Amount Due" });
    expect(await run()).toBe(0);

    await saveEmail(server.store, bill(6, { html: TWO_AMOUNTS }), { uid: 6 });
    await saveEmail(server.store, bill(7, { verified: false }), { uid: 7 });
    await mark([1, 2], null);
    await mark([1, 2], "checked");
    await mark([6], "checked");
    expect(await run()).toBe(0);
    await mark([3], "checked");
    await mark([7], "checked");
    expect(await run()).toBe(0);

    await mark([4, 5], "checked");
    await mark([1], null);
    expect((await mark([1], "checked")).offerAutoSend).toHaveLength(1);
    // "Not now": off, and the run starts again, so it asks after another three.
    expect(await json<Biller>(await send("PUT", `/api/billers/${water.id}/auto-send`, { autoSend: false }))).toMatchObject({ autoSend: false, cleanChecks: 0 });
  });

  it("is not changed by marking an email Not a bill", async () => {
    await mark([1, 2], "checked");
    await mark([3], "not-bill");
    expect(await run()).toBe(2);
  });

  it("holds back an odd email from an automatic biller until someone checks it", async () => {
    await send("PUT", `/api/billers/${water.id}/auto-send`, { autoSend: true });
    await saveEmail(server.store, bill(8, { verified: false }), { uid: 8 });
    expect((await detail(8)).handoff).toMatchObject({ state: "waits", reason: "Waits for someone to mark it Checked: the sender is not verified." });
    await mark([8], "checked");
    expect((await detail(8)).handoff.state).toBe("goes");
  });

  it("keeps what OurHome was sent when Send automatically is turned off: only new emails wait", async () => {
    await send("PUT", `/api/billers/${water.id}/auto-send`, { autoSend: true });
    const token = await connect();
    const sent = await documents(token);
    expect(sent.documents.map((d) => d.status)).toEqual(["ready", "ready", "ready", "ready", "ready"]);
    await send("PUT", `/api/billers/${water.id}/auto-send`, { autoSend: false });
    expect(await documents(token, `?after=${sent.next}`)).toEqual({ documents: [], next: sent.next, more: false });
    const page = await detail(4);
    expect(page.handoff).toMatchObject({ state: "waits", offered: { status: "ready" } });
    expect(server.db.get<{ n: number }>("SELECT count(*) AS n FROM handoff_offers WHERE status = 'withdrawn'")!.n).toBe(0);
    // Marking one Not a bill still takes it back.
    await mark([4], "not-bill");
    expect((await documents(token, `?after=${sent.next}`)).documents).toEqual([expect.objectContaining({ captureId: id(4), status: "withdrawn" })]);
  });

  it("answers another household's biller, or a bad body, as such", async () => {
    expect((await send("PUT", "/api/billers/999/auto-send", { autoSend: true })).status).toBe(404);
    expect((await send("PUT", `/api/billers/${water.id}/auto-send`, { autoSend: "yes" })).status).toBe(400);
  });
});
