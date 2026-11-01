// The Status page's data: how each mailbox's reads went (and since when one
// has been failing), what the invoice links gave, and the recent problems for
// admins. Reading a mailbox is stood in for, so reads can be made to work or fail.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../../src/server/auth.js";
import type { StatusResponse } from "../../src/shared/api.js";
import type { InvoiceRecord } from "../../src/shared/invoice.js";
import { call, json, makeServer, rawEmail, saveEmail, sessionCookie, setUp, type TestServer } from "./helpers.js";

const reading = vi.hoisted(() => ({ fail: null as string | null }));
vi.mock("../../src/mailbox.js", async (original) => {
  const real = await original<typeof import("../../src/mailbox.js")>();
  return {
    ...real,
    captureMailbox: vi.fn(async () => {
      if (reading.fail) throw new real.MailboxError(reading.fail);
      return { inFolder: 2, alreadyCaptured: 1, captured: 1, failed: 0, tooLarge: 0 };
    }),
  };
});

let server: TestServer;
let cookie: string;

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  reading.fail = null;
  server = makeServer();
  cookie = await setUp(server.app);
});

afterEach(() => {
  server.close();
  vi.restoreAllMocks();
});

const status = async (as = cookie) => json<StatusResponse>(await call(server.app, "/api/status", { cookie: as }));

describe("a mailbox's reads", () => {
  it("says since when it has been failing, and a good read clears it", async () => {
    const { mailboxes } = server.service;
    reading.fail = "127.0.0.1:1143 refused the connection. Check the port.";
    server.clock.now = new Date("2026-10-30T09:00:00Z");
    await mailboxes.readAll();
    server.clock.now = new Date("2026-10-30T09:15:00Z");
    await mailboxes.readAll();
    let [mailbox] = (await status()).mailboxes;
    expect(mailbox).toMatchObject({
      failingSince: "2026-10-30T09:00:00.000Z",
      lastOkAt: null,
      lastCheck: { at: "2026-10-30T09:15:00.000Z", ok: false, message: "127.0.0.1:1143 refused the connection. Check the port." },
    });

    reading.fail = null;
    server.clock.now = new Date("2026-10-30T09:30:00Z");
    await mailboxes.readAll();
    [mailbox] = (await status()).mailboxes;
    expect(mailbox).toMatchObject({
      failingSince: null,
      lastOkAt: "2026-10-30T09:30:00.000Z",
      lastCheck: { ok: true, message: "1 new, 1 captured before", captured: 1 },
    });
  });
});

describe("GET /api/status", () => {
  function invoice(uid: number, record: Partial<InvoiceRecord>) {
    const full: InvoiceRecord = {
      version: 1,
      outcome: "saved",
      reason: "Got the invoice.",
      linkText: "View Invoice",
      url: "https://example.com/i",
      host: "example.com",
      triedAt: "2026-10-30T10:00:00.000Z",
      attempts: 3,
      file: null,
      size: null,
      sha256: null,
      pages: null,
      text: null,
      ...record,
    };
    writeFileSync(join(server.store.messageDir("proton-bills", "1700000000", uid), "invoice.json"), JSON.stringify(full));
  }

  it("counts what the invoice links gave, keeping retries apart, and lists the latest tries", async () => {
    for (const uid of [1, 2, 3, 4, 5]) await saveEmail(server.store, rawEmail({ subject: `Bill ${uid}` }), { uid });
    invoice(1, { outcome: "saved", triedAt: "2026-10-30T10:00:00.000Z" });
    invoice(2, { outcome: "sign-in", triedAt: "2026-10-30T11:00:00.000Z", reason: "It leads to a sign-in page." });
    invoice(3, { outcome: "failed", attempts: 1, triedAt: "2026-10-30T12:00:00.000Z" });
    invoice(4, { outcome: "failed", attempts: 3, triedAt: "2026-10-30T09:00:00.000Z" });
    const body = await status();
    expect(body.invoices.counts).toEqual({ saved: 1, "sign-in": 1, "not-pdf": 0, unreadable: 0, failed: 1, blocked: 0 });
    expect(body.invoices.retrying).toBe(1);
    expect(body.invoices.recent.map((r) => [r.captureId, r.outcome, r.retrying])).toEqual([
      ["proton-bills/1700000000/3", "failed", true],
      ["proton-bills/1700000000/2", "sign-in", false],
      ["proton-bills/1700000000/1", "saved", false],
      ["proton-bills/1700000000/4", "failed", false],
    ]);
    expect(body.invoices.recent[1]).toMatchObject({ subject: "Bill 2", sender: "Water Co", reason: "It leads to a sign-in page." });
  });

  it("says when mail is read, which version runs and since when", async () => {
    const body = await status();
    expect(body).toMatchObject({
      version: "0.1.0-test",
      startedAt: "2026-10-29T12:00:00.000Z",
      checking: { everyMinutes: 15, running: false },
      canEdit: true,
    });
    expect(body.mailboxes.map((m) => m.name)).toEqual(["Proton bills"]);
  });

  it("shows the recent problems from the log to everyone in the household", async () => {
    reading.fail = "Bridge is not running";
    await server.service.mailboxes.readAll();
    const admin = await status();
    expect(admin.problems?.[0]).toMatchObject({ level: "error", message: '"Proton bills": Bridge is not running' });

    const household = server.db.get<{ id: number }>("SELECT id FROM households")!.id;
    server.db.run(
      "INSERT INTO users (household_id, email, name, password_hash, is_admin, created_at) VALUES (?, 'kim@example.com', 'Kim', ?, 0, '2026-10-29')",
      household,
      await hashPassword("member password 1"),
    );
    const member = sessionCookie(await call(server.app, "/api/session", { method: "POST", body: { email: "kim@example.com", password: "member password 1" } }))!;
    // Everyone in the household sees what went wrong, not only an admin.
    const seen = await status(member);
    expect(seen.problems?.[0]).toMatchObject({ level: "error", message: '"Proton bills": Bridge is not running' });
    expect(seen.canEdit).toBe(true);
    expect(seen.mailboxes).toHaveLength(1);
  });

  it("needs a signed-in person", async () => {
    expect((await call(server.app, "/api/status")).status).toBe(401);
  });
});
