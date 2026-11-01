// The household's mailboxes over the API: copied from config.yml once, kept
// with encrypted passwords, added and changed by an admin, tried before
// saving, and read with each result recorded. No real mail server is used:
// tests that connect use a port on this computer that nothing listens on.

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../../src/server/auth.js";
import type { ApiError, CaptureListResponse, MailboxInfo, MailboxListResponse, MailboxTestResponse } from "../../src/shared/api.js";
import { BRIDGE_PASSWORD, call, json, makeServer, rawEmail, saveEmail, sessionCookie, setUp, type TestServer } from "./helpers.js";

let server: TestServer;
let cookie: string;

beforeEach(async () => {
  server = makeServer();
  cookie = await setUp(server.app);
});

afterEach(() => {
  server.close();
  vi.restoreAllMocks();
});

const get = (path: string, as = cookie) => call(server.app, path, { cookie: as });
const send = (method: string, path: string, body?: unknown, as = cookie) => call(server.app, path, { method, cookie: as, body });

const WATER = {
  name: "Water bills",
  provider: "proton-bridge",
  host: "protonmail-bridge",
  port: 143,
  security: "none",
  username: "water@proton.me",
  password: "water-secret-1",
  folder: "Folders/Water",
};

async function list(as = cookie): Promise<MailboxListResponse> {
  return json<MailboxListResponse>(await get("/api/mailboxes", as));
}

/** A port on this computer that refuses connections. */
async function closedPort(): Promise<number> {
  const probe: Server = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", () => done()));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

/** A second, non-admin member of the household, signed in. */
async function memberCookie(): Promise<string> {
  const household = server.db.get<{ id: number }>("SELECT id FROM households")!.id;
  server.db.run(
    "INSERT INTO users (household_id, email, name, password_hash, is_admin, created_at) VALUES (?, 'kim@example.com', 'Kim', ?, 0, '2026-10-29')",
    household,
    await hashPassword("member password 1"),
  );
  const res = await call(server.app, "/api/session", { method: "POST", body: { email: "kim@example.com", password: "member password 1" } });
  return sessionCookie(res)!;
}

describe("the mailboxes in config.yml", () => {
  it("are copied in at first-time setup, with the password from .env encrypted and never sent back", async () => {
    const res = await get("/api/mailboxes");
    const text = await res.text();
    expect(text).not.toContain(BRIDGE_PASSWORD);
    const body = JSON.parse(text) as MailboxListResponse;
    expect(body.canEdit).toBe(true);
    expect(body.mailboxes).toEqual([
      {
        id: expect.any(Number),
        name: "Proton bills",
        slug: "proton-bills",
        provider: "proton-bridge",
        folder: "Folders/Bills",
        imap: { host: "127.0.0.1", port: 1143, security: "starttls", username: "sam@proton.me", passwordSet: true, passwordProblem: null },
        enabled: true,
        lastCheck: null,
        lastOkAt: null,
        failingSince: null,
        createdAt: "2026-10-29T12:00:00.000Z",
        updatedAt: "2026-10-29T12:00:00.000Z",
      },
    ]);
    const stored = server.db.get<{ password_secret: string }>("SELECT password_secret FROM mailboxes")!.password_secret;
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain(BRIDGE_PASSWORD);
  });

  it("are copied once only: a later start or a mailbox removed on the web does not bring them back", async () => {
    const [mailbox] = (await list()).mailboxes;
    expect((await send("DELETE", `/api/mailboxes/${mailbox!.id}`)).status).toBe(204);
    expect(server.service.mailboxes.importFromConfig(server.service.settings.config)).toBe("done before");
    expect((await list()).mailboxes).toEqual([]);
  });

  it("are copied with no password when .env has none, and say so", async () => {
    server.close();
    server = makeServer({ env: { PROTON_BRIDGE_PASSWORD: "" } });
    cookie = await setUp(server.app);
    expect((await list()).mailboxes[0]?.imap).toMatchObject({ passwordSet: false, passwordProblem: null });
  });

  it("are copied when the household already exists at start (an install from before this version)", async () => {
    server.db.run("DELETE FROM mailboxes");
    server.db.run("DELETE FROM app_state");
    expect(server.service.mailboxes.importFromConfig(server.service.settings.config)).toBe("copied");
    expect((await list()).mailboxes.map((m) => m.slug)).toEqual(["proton-bills"]);
  });
});

describe("adding and changing a mailbox", () => {
  it("adds one with its password encrypted, then changes it, keeping the password when none is sent", async () => {
    const created = await send("POST", "/api/mailboxes", WATER);
    expect(created.status).toBe(201);
    const water = await json<MailboxInfo>(created);
    expect(water).toMatchObject({ name: "Water bills", slug: "water-bills", folder: "Folders/Water", enabled: true, imap: { passwordSet: true } });
    expect(JSON.stringify(water)).not.toContain("water-secret-1");

    server.clock.now = new Date("2026-10-30T08:00:00Z");
    const { password: _password, ...withoutPassword } = WATER;
    const changed = await json<MailboxInfo>(await send("PUT", `/api/mailboxes/${water.id}`, { ...withoutPassword, folder: "Bills", enabled: false }));
    expect(changed).toMatchObject({ folder: "Bills", enabled: false, imap: { passwordSet: true }, updatedAt: "2026-10-30T08:00:00.000Z" });
    const sealed = () => server.db.get<{ password_secret: string }>("SELECT password_secret FROM mailboxes WHERE id = ?", water.id)!.password_secret;
    const before = sealed();
    await send("PUT", `/api/mailboxes/${water.id}`, { ...WATER, password: "new-secret-2" });
    expect(sealed()).not.toBe(before);
  });

  it("keeps a renamed mailbox's mail where it is", async () => {
    await saveEmail(server.store, rawEmail({ subject: "Water bill" }), { uid: 1 });
    const [mailbox] = (await list()).mailboxes;
    const same = { name: "Sam's Proton", provider: "proton-bridge", host: "127.0.0.1", port: 1143, security: "starttls", username: "sam@proton.me", folder: "Folders/Bills" };
    const renamed = await json<MailboxInfo>(await send("PUT", `/api/mailboxes/${mailbox!.id}`, same));
    expect(renamed).toMatchObject({ name: "Sam's Proton", slug: "proton-bills" });
    const { captures } = await json<CaptureListResponse>(await get("/api/captures"));
    expect(captures.map((c) => [c.mailbox, c.mailboxSlug, c.subject])).toEqual([["Sam's Proton", "proton-bills", "Water bill"]]);
  });

  it("gives a new mailbox its own folder, never one in use or left on disk", async () => {
    mkdirSync(join(server.store.root, "water-bills"), { recursive: true });
    const water = await json<MailboxInfo>(await send("POST", "/api/mailboxes", WATER));
    expect(water.slug).toBe("water-bills-2");
    const other = await json<MailboxInfo>(await send("POST", "/api/mailboxes", { ...WATER, name: "Proton Bills!" }));
    expect(other.slug).toBe("proton-bills-2");
  });

  it("refuses a second mailbox of the same name, ignoring capitals", async () => {
    const res = await send("POST", "/api/mailboxes", { ...WATER, name: "PROTON BILLS" });
    expect(res.status).toBe(409);
    expect((await json<ApiError>(res)).error).toBe("There is already a mailbox called Proton bills.");
  });

  it.each([
    [{ name: "" }, "Enter a name for the mailbox."],
    [{ name: "!!!" }, "The name needs at least one letter or number."],
    [{ host: "http://bridge/x" }, "with no spaces or slashes"],
    [{ port: 70000 }, "between 1 and 65535"],
    [{ port: "143" }, "as a number"],
    [{ security: "ssl" }, "Choose how the connection is protected."],
    [{ username: " " }, "Enter the IMAP username."],
    [{ folder: "" }, "Enter the folder to read"],
    [{ provider: "gmail" }, "Choose the kind of mailbox."],
  ])("refuses %j", async (change, message) => {
    const res = await send("POST", "/api/mailboxes", { ...WATER, ...change });
    expect(res.status).toBe(400);
    expect((await json<ApiError>(res)).error).toContain(message);
  });

  it("removes one, keeping its captured mail on disk but no longer showing it", async () => {
    await saveEmail(server.store, rawEmail({ subject: "Water bill" }), { uid: 1 });
    const [mailbox] = (await list()).mailboxes;
    expect((await send("DELETE", `/api/mailboxes/${mailbox!.id}`)).status).toBe(204);
    expect((await json<CaptureListResponse>(await get("/api/captures"))).captures).toEqual([]);
    expect(server.store.has("proton-bills", "1700000000", 1)).toBe(true);
    expect((await send("DELETE", `/api/mailboxes/${mailbox!.id}`)).status).toBe(404);
  });

  it("keeps a removed one, without its password, to restore with its mail", async () => {
    await saveEmail(server.store, rawEmail({ subject: "Water bill" }), { uid: 1 });
    const [mailbox] = (await list()).mailboxes;
    server.clock.now = new Date("2026-10-31T02:33:00Z");
    await send("DELETE", `/api/mailboxes/${mailbox!.id}`);
    const removedRow = () => server.db.get<{ password_secret: string; enabled: number }>("SELECT password_secret, enabled FROM mailboxes WHERE id = ?", mailbox!.id)!;
    expect(removedRow()).toEqual({ password_secret: "", enabled: 0 });
    const after = await list();
    expect(after.mailboxes).toEqual([]);
    expect(after.removed).toEqual([
      {
        id: mailbox!.id,
        name: "Proton bills",
        slug: "proton-bills",
        provider: "proton-bridge",
        folder: "Folders/Bills",
        imap: { host: "127.0.0.1", port: 1143, security: "starttls", username: "sam@proton.me" },
        emails: 1,
        removedAt: "2026-10-31T02:33:00.000Z",
      },
    ]);
    // Not changed, read or tried as a mailbox while removed.
    expect((await send("PUT", `/api/mailboxes/${mailbox!.id}`, WATER)).status).toBe(404);
    expect((await send("POST", "/api/mailboxes/test", { ...WATER, id: mailbox!.id, password: undefined })).status).toBe(404);
    expect(server.service.mailboxes.households()).toEqual([]);

    // Adding it again by hand would start an empty folder, so it points to restoring it.
    const again = await send("POST", "/api/mailboxes", { ...WATER, name: "proton bills" });
    expect(again.status).toBe(409);
    expect((await json<ApiError>(again)).error).toBe(
      "A removed mailbox is called Proton bills. Restore it under Removed mailboxes in Settings to get its emails back, or choose another name.",
    );

    const restored = await send("POST", `/api/mailboxes/${mailbox!.id}/restore`, { ...WATER, name: "Proton bills" });
    expect(restored.status).toBe(200);
    expect(await json<MailboxInfo>(restored)).toMatchObject({ name: "Proton bills", slug: "proton-bills", folder: "Folders/Water", enabled: true, imap: { passwordSet: true } });
    const now = await list();
    expect(now.removed).toEqual([]);
    expect(now.mailboxes.map((m) => m.slug)).toEqual(["proton-bills"]);
    const { captures } = await json<CaptureListResponse>(await get("/api/captures"));
    expect(captures.map((c) => c.subject)).toEqual(["Water bill"]);
    expect((await send("POST", `/api/mailboxes/${mailbox!.id}/restore`, WATER)).status).toBe(404);
  });

  it("restores a removed one under a new name when its old one is taken, and refuses a name in use", async () => {
    const [mailbox] = (await list()).mailboxes;
    await send("DELETE", `/api/mailboxes/${mailbox!.id}`);
    await send("POST", "/api/mailboxes", WATER);
    const clash = await send("POST", `/api/mailboxes/${mailbox!.id}/restore`, WATER);
    expect(clash.status).toBe(409);
    expect((await json<ApiError>(clash)).error).toBe("There is already a mailbox called Water bills.");
    const restored = await send("POST", `/api/mailboxes/${mailbox!.id}/restore`, { ...WATER, name: "Old bills" });
    expect(await json<MailboxInfo>(restored)).toMatchObject({ name: "Old bills", slug: "proton-bills" });
  });

  it("lets everyone in the household change mailboxes, not only an admin, and never shows a password", async () => {
    const member = await memberCookie();
    const seen = await list(member);
    expect(seen.canEdit).toBe(true);
    expect(seen.mailboxes).toHaveLength(1);
    const added = await send("POST", "/api/mailboxes", WATER, member);
    expect(added.status).toBe(201);
    const water = await json<MailboxInfo>(added);
    expect(JSON.stringify(water)).not.toContain(WATER.password);
    expect((await send("PUT", `/api/mailboxes/${water.id}`, { ...WATER, name: "Water", password: undefined }, member)).status).toBe(200);
    expect((await send("DELETE", `/api/mailboxes/${water.id}`, undefined, member)).status).toBe(204);
    expect((await send("POST", `/api/mailboxes/${water.id}/restore`, { ...WATER, name: "Water again" }, member)).status).toBe(200);
    expect(JSON.stringify(await list(member))).not.toContain(WATER.password);
  });

  it("never reaches another household's mailbox or its mail", async () => {
    const stamp = "2026-10-29T00:00:00.000Z";
    const household = server.db.run("INSERT INTO households (name, created_at) VALUES ('The Joneses', ?)", stamp).lastInsertRowid;
    const theirs = server.db.run(
      `INSERT INTO mailboxes (household_id, name, slug, provider, host, port, security, username, folder, created_at, updated_at)
       VALUES (?, 'Their bills', 'their-bills', 'proton-bridge', 'h', 1, 'none', 'u', 'INBOX', ?, ?)`,
      household,
      stamp,
      stamp,
    ).lastInsertRowid;
    await saveEmail(server.store, rawEmail({ subject: "Their bill" }), { uid: 1, mailbox: "Their bills" });
    expect((await list()).mailboxes.map((m) => m.name)).toEqual(["Proton bills"]);
    expect((await send("PUT", `/api/mailboxes/${theirs}`, WATER)).status).toBe(404);
    expect((await send("DELETE", `/api/mailboxes/${theirs}`)).status).toBe(404);
    server.db.run("UPDATE mailboxes SET removed_at = ? WHERE id = ?", stamp, theirs);
    expect((await list()).removed).toEqual([]);
    expect((await send("POST", `/api/mailboxes/${theirs}/restore`, WATER)).status).toBe(404);
    expect((await send("POST", "/api/mailboxes/test", { ...WATER, id: theirs, password: undefined })).status).toBe(404);
    expect((await json<CaptureListResponse>(await get("/api/captures"))).captures).toEqual([]);
    expect((await get("/api/captures/their-bills/1700000000/1")).status).toBe(404);
  });
});

describe("mail on disk that no mailbox owns (a mailbox deleted before removed ones were kept)", () => {
  /** As an older version left it: the mailbox deleted outright, its mail still on disk. */
  async function deletedOutright(): Promise<void> {
    await saveEmail(server.store, rawEmail({ subject: "Water bill" }), { uid: 1, mailbox: "Proton bill label" });
    await saveEmail(server.store, rawEmail({ subject: "Water bill 2" }), { uid: 2, mailbox: "Proton bill label" });
    mkdirSync(join(server.store.root, "empty-folder"), { recursive: true });
    server.db.run("DELETE FROM app_state WHERE key = 'lost_mail_folders_checked'");
  }

  it("is listed once as a removed mailbox, named from its emails, and restores with its mail", async () => {
    await deletedOutright();
    expect(server.service.mailboxes.findLostFolders()).toBe("found");
    const { removed } = await list();
    expect(removed).toEqual([
      {
        id: expect.any(Number),
        name: "Proton bill label",
        slug: "proton-bill-label",
        provider: "proton-bridge",
        folder: "Folders/Bills",
        imap: null,
        emails: 2,
        removedAt: "2026-10-29T12:00:00.000Z",
      },
    ]);
    expect(server.service.mailboxes.findLostFolders()).toBe("done before");
    expect((await list()).removed).toHaveLength(1);

    const restored = await send("POST", `/api/mailboxes/${removed[0]!.id}/restore`, { ...WATER, name: "Proton bill label", folder: "Labels/Bill" });
    expect(await json<MailboxInfo>(restored)).toMatchObject({ slug: "proton-bill-label", folder: "Labels/Bill", enabled: true });
    const { captures } = await json<CaptureListResponse>(await get("/api/captures"));
    expect(captures.map((c) => c.subject).sort()).toEqual(["Water bill", "Water bill 2"]);
  });

  it("gets a name of its own when its old one is in use", async () => {
    await deletedOutright();
    await send("POST", "/api/mailboxes", { ...WATER, name: "Proton Bill Label" });
    server.service.mailboxes.findLostFolders();
    expect((await list()).removed.map((m) => [m.name, m.slug])).toEqual([["Proton bill label (found)", "proton-bill-label"]]);
  });

  it("stays hidden with more than one household, as it is not known whose it is", async () => {
    await deletedOutright();
    server.db.run("INSERT INTO households (name, created_at) VALUES ('The Joneses', '2026-10-29')");
    expect(server.service.mailboxes.findLostFolders()).toBe("found");
    expect((await list()).removed).toEqual([]);
    expect(server.db.get("SELECT 1 FROM mailboxes WHERE slug = 'proton-bill-label'")).toBeUndefined();
  });

  it("waits for first-time setup on a new install", () => {
    server.close();
    server = makeServer();
    expect(server.service.mailboxes.findLostFolders()).toBe("waiting");
  });
});

describe("a saved password", () => {
  const SAVED = { name: "Proton bills", provider: "proton-bridge", host: "127.0.0.1", port: 1143, security: "starttls", username: "sam@proton.me", folder: "Folders/Bills" };
  const sealed = () => server.db.get<{ password_secret: string }>("SELECT password_secret FROM mailboxes")!.password_secret;

  it.each([
    ["server", { host: "attacker.example" }],
    ["port", { port: 993 }],
    ["security", { security: "tls" }],
    ["username", { username: "someone@else.example" }],
  ])("is never kept, or tried, for a different %s", async (_what, change) => {
    const [mailbox] = (await list()).mailboxes;
    const before = sealed();
    const saved = await send("PUT", `/api/mailboxes/${mailbox!.id}`, { ...SAVED, ...change });
    expect(saved.status).toBe(400);
    expect((await json<ApiError>(saved)).error).toMatch(/^Enter the password again to use a different server/);
    expect(sealed()).toBe(before);
    expect((await list()).mailboxes[0]).toMatchObject({ imap: { host: "127.0.0.1", port: 1143 } });

    const tried = await send("POST", "/api/mailboxes/test", { ...SAVED, ...change, id: mailbox!.id });
    expect(tried.status).toBe(400);
    expect((await json<ApiError>(tried)).error).toMatch(/^Enter the password again/);
  });

  it("is kept for the same server, written in other capitals, and a new server works with the password typed", async () => {
    const [mailbox] = (await list()).mailboxes;
    expect((await send("PUT", `/api/mailboxes/${mailbox!.id}`, { ...SAVED, host: "127.0.0.1", folder: "Bills" })).status).toBe(200);
    const moved = await send("PUT", `/api/mailboxes/${mailbox!.id}`, { ...SAVED, host: "protonmail-bridge", password: "typed again" });
    expect(moved.status).toBe(200);
    expect(await json<MailboxInfo>(moved)).toMatchObject({ imap: { host: "protonmail-bridge", passwordSet: true } });
    expect((await send("PUT", `/api/mailboxes/${mailbox!.id}`, { ...SAVED, host: "ProtonMail-Bridge" })).status).toBe(200);
  });
});

describe("a saved password the key cannot open", () => {
  it("is shown as needing to be entered again, not used", async () => {
    server.db.run("UPDATE mailboxes SET password_secret = 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'");
    const [mailbox] = (await list()).mailboxes;
    expect(mailbox!.imap.passwordSet).toBe(false);
    expect(mailbox!.imap.passwordProblem).toMatch(/Enter the password again/);
  });
});

describe("trying settings, and reading mail", () => {
  it("tries a connection and says in plain words why it did not work", async () => {
    const port = await closedPort();
    const res = await send("POST", "/api/mailboxes/test", { ...WATER, host: "127.0.0.1", port });
    expect(res.status).toBe(200);
    expect(await json<MailboxTestResponse>(res)).toEqual({ ok: false, message: `127.0.0.1:${port} refused the connection. Check the port.`, folders: [], messages: null });
  });

  it("tries a saved mailbox with its saved password when none is typed", async () => {
    server.db.run("UPDATE mailboxes SET password_secret = ''");
    const [mailbox] = (await list()).mailboxes;
    const res = await send("POST", "/api/mailboxes/test", { ...WATER, id: mailbox!.id, password: undefined });
    expect((await json<MailboxTestResponse>(res)).message).toBe("No password is saved for this mailbox. Add it in Settings.");
  });

  it("records how each read went, and skips paused mailboxes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const port = await closedPort();
    const [mailbox] = (await list()).mailboxes;
    // A new server needs the password typed again (see "a saved password").
    await send("PUT", `/api/mailboxes/${mailbox!.id}`, { ...WATER, name: "Proton bills", host: "127.0.0.1", port });
    const paused = await json<MailboxInfo>(await send("POST", "/api/mailboxes", { ...WATER, enabled: false }));
    server.clock.now = new Date("2026-10-30T09:00:00Z");
    expect(await server.service.mailboxes.readAll()).toEqual({ read: 0, failed: 1, captured: 0 });
    const after = (await list()).mailboxes;
    expect(after.find((m) => m.id === mailbox!.id)?.lastCheck).toEqual({
      at: "2026-10-30T09:00:00.000Z",
      ok: false,
      message: `127.0.0.1:${port} refused the connection. Check the port.`,
      captured: 0,
    });
    expect(after.find((m) => m.id === paused.id)?.lastCheck).toBeNull();
  });

  it("checks mail now when asked, and says when mail is read", async () => {
    server.close();
    const read = vi.fn(async () => {});
    server = makeServer({ readMail: read });
    cookie = await setUp(server.app);
    const res = await send("POST", "/api/mailboxes/check");
    expect(res.status).toBe(200);
    expect(read).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    expect((await list()).checking).toMatchObject({ everyMinutes: 15, running: false, lastFinishedAt: "2026-10-29T12:00:00.000Z", nextAt: "2026-10-29T12:15:00.000Z" });
  });
});

// A folder left on disk (a removed mailbox's mail, or anything else) is never taken over.
describe("the data folder", () => {
  it("treats a folder holding only a file as taken too", async () => {
    mkdirSync(join(server.store.root, "gas"), { recursive: true });
    writeFileSync(join(server.store.root, "gas", "note.txt"), "x");
    expect((await json<MailboxInfo>(await send("POST", "/api/mailboxes", { ...WATER, name: "Gas" }))).slug).toBe("gas-2");
  });
});
