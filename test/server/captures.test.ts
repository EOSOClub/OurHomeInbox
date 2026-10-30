import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentDisposition } from "../../src/server/captures.js";
import type { ApiError, CaptureDetailResponse, CaptureListResponse, SettingsResponse } from "../../src/shared/api.js";
import { BRIDGE_PASSWORD, call, json, makeServer, rawEmail, saveEmail, setUp, testConfig, type TestServer } from "./helpers.js";

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

const get = (path: string) => call(server.app, path, { cookie });

async function saveThree() {
  // uid 1: oldest Date; uid 2: newest Date; uid 3: no Date, so its capture time counts.
  await saveEmail(server.store, rawEmail({ subject: "Water bill", date: "Mon, 05 Oct 2026 09:00:00 +0000", attachmentName: "bill.pdf" }), {
    uid: 1,
  });
  await saveEmail(
    server.store,
    rawEmail({ subject: "Power bill", date: "Wed, 28 Oct 2026 09:00:00 +0000", html: '<p>Pay <a href="https://power.example">here</a></p>' }),
    { uid: 2 },
  );
  await saveEmail(server.store, rawEmail({ subject: "Gas bill" }), { uid: 3, capturedAt: "2026-10-20T00:00:00Z" });
}

describe("GET /api/captures", () => {
  it("is empty when nothing is captured", async () => {
    const res = await get("/api/captures");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ captures: [] });
  });

  it("lists captures newest first, by Date header else capture time", async () => {
    await saveThree();
    const res = await get("/api/captures");
    expect(res.status).toBe(200);
    const { captures } = await json<CaptureListResponse>(res);
    expect(captures.map((c) => c.subject)).toEqual(["Power bill", "Gas bill", "Water bill"]);
    expect(captures[2]).toEqual({
      id: "proton-bills/1700000000/1",
      mailbox: "Proton bills",
      mailboxSlug: "proton-bills",
      folder: "Folders/Bills",
      uidValidity: "1700000000",
      uid: 1,
      subject: "Water bill",
      from: [{ name: "Water Co", address: "billing@water.example" }],
      date: "2026-10-05T09:00:00.000Z",
      capturedAt: "2026-10-29T12:00:00.000Z",
      attachmentCount: 1,
      linkCount: 1,
      hasText: true,
      hasHtml: false,
      biller: null,
      picked: { kind: "statement", amount: null, dueDate: null, paidDate: null, needsCheck: false },
    });
    expect(captures[0]).toMatchObject({ uid: 2, hasHtml: true, linkCount: 2, attachmentCount: 0 });
    expect(captures[1]).toMatchObject({ uid: 3, date: null, capturedAt: "2026-10-20T00:00:00.000Z" });
  });

  it("skips a damaged capture.json with a warning instead of failing", async () => {
    await saveThree();
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(join(server.store.messageDir("Proton bills", "1700000000", 3), "capture.json"), "{ broken");
    const res = await get("/api/captures");
    expect(res.status).toBe(200);
    const { captures } = await json<CaptureListResponse>(res);
    expect(captures.map((c) => c.uid)).toEqual([2, 1]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Skipping"));
  });

  it("ignores folders that are not a captured message", async () => {
    await saveThree();
    // Unfinished (no capture.json), oddly named, and a mailbox not in config.yml.
    mkdirSync(join(server.store.root, "proton-bills", "1700000000", "9"), { recursive: true });
    mkdirSync(join(server.store.root, "proton-bills", "not-a-number", "1"), { recursive: true });
    await saveEmail(server.store, rawEmail({ subject: "Someone else's" }), { uid: 1, mailbox: "Other box" });
    const { captures } = await json<CaptureListResponse>(await get("/api/captures"));
    expect(captures).toHaveLength(3);
    expect(captures.every((c) => c.mailboxSlug === "proton-bills")).toBe(true);
  });
});

describe("billers on captured mail", () => {
  async function addBiller(body: unknown): Promise<number> {
    const res = await call(server.app, "/api/billers", { method: "POST", cookie, body });
    if (res.status !== 201) throw new Error(`biller not added: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { id: number }).id;
  }

  it("shows each email's biller in the list and on the email, and follows changes at once", async () => {
    await saveThree();
    const id = await addBiller({ name: "Water Co", kind: "bill", senders: ["water.example"] });
    const match = { id, name: "Water Co", kind: "bill", matchedOn: "water.example" };

    const { captures } = await json<CaptureListResponse>(await get("/api/captures"));
    expect(captures.map((c) => c.biller)).toEqual([match, match, match]);
    expect((await json<CaptureDetailResponse>(await get("/api/captures/proton-bills/1700000000/2"))).biller).toEqual(match);

    // A more specific sender on another biller takes over.
    const billing = await addBiller({ name: "Water Billing", kind: "bill", senders: ["billing@water.example"] });
    const after = await json<CaptureListResponse>(await get("/api/captures"));
    expect(after.captures.map((c) => c.biller?.id)).toEqual([billing, billing, billing]);

    await call(server.app, `/api/billers/${billing}`, { method: "DELETE", cookie });
    await call(server.app, `/api/billers/${id}`, { method: "DELETE", cookie });
    const none = await json<CaptureListResponse>(await get("/api/captures"));
    expect(none.captures.map((c) => c.biller)).toEqual([null, null, null]);
  });

  it("uses only the signed-in household's billers", async () => {
    await saveThree();
    const stamp = "2026-10-29T00:00:00.000Z";
    const household = server.db.run("INSERT INTO households (name, created_at) VALUES ('The Joneses', ?)", stamp).lastInsertRowid;
    const theirs = server.db.run(
      "INSERT INTO billers (household_id, name, kind, created_at, updated_at) VALUES (?, 'Their Water', 'bill', ?, ?)",
      household,
      stamp,
      stamp,
    ).lastInsertRowid;
    server.db.run(
      "INSERT INTO biller_senders (biller_id, household_id, sender, position) VALUES (?, ?, 'water.example', 0)",
      theirs,
      household,
    );
    const { captures } = await json<CaptureListResponse>(await get("/api/captures"));
    expect(captures.map((c) => c.biller)).toEqual([null, null, null]);
  });
});

describe("GET /api/captures/:mailbox/:uidValidity/:uid", () => {
  it("returns the whole capture record", async () => {
    await saveThree();
    const res = await get("/api/captures/proton-bills/1700000000/2");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
    const body = await json<CaptureDetailResponse>(res);
    expect(body.id).toBe("proton-bills/1700000000/2");
    expect(body.mailboxSlug).toBe("proton-bills");
    expect(body.capture).toMatchObject({ subject: "Power bill", uid: 2, html: expect.stringContaining("<a href") });
    expect(body.biller).toBeNull();
    expect(body.extraction).toMatchObject({ source: "html", kind: "statement", fields: [] });
  });

  it("says what the reader picked out, in the list and on the email", async () => {
    const html = "<table><tr><td>Amount Billed:</td><td>$4.13</td></tr><tr><td>Due Date:</td><td>11/04/2026</td></tr></table>";
    await saveEmail(server.store, rawEmail({ subject: "Your bill is ready", html }), { uid: 7 });
    const { captures } = await json<CaptureListResponse>(await get("/api/captures"));
    expect(captures[0]!.picked).toEqual({ kind: "bill", amount: "4.13", dueDate: "2026-11-04", paidDate: null, needsCheck: false });

    const { extraction } = await json<CaptureDetailResponse>(await get("/api/captures/proton-bills/1700000000/7"));
    expect(extraction.source).toBe("html");
    expect(extraction.pieces).toEqual(["Amount Billed:", "$4.13", "Due Date:", "11/04/2026"]);
    expect([extraction.kind, extraction.kindReason]).toEqual(["bill", "It has an amount to pay."]);
    expect(extraction.fields.map((f) => [f.field, f.values.map((v) => [v.value, v.shown, v.label]), f.by])).toEqual([
      ["amount", [["4.13", "$4.13", "Amount Billed"]], "reader"],
      ["dueDate", [["2026-11-04", "11/04/2026", "Due Date"]], "reader"],
    ]);
  });

  it("answers 404 for a message that is not captured", async () => {
    await saveThree();
    const res = await get("/api/captures/proton-bills/1700000000/99");
    expect(res.status).toBe(404);
    expect((await json<ApiError>(res)).error).toMatch(/not found/);
  });

  it.each([
    ["a mailbox not in config.yml", "/api/captures/other-box/1700000000/1", 404],
    ["a mailbox name instead of its slug", "/api/captures/Proton%20bills/1700000000/1", 404],
    ["an encoded slash in the mailbox", "/api/captures/proton-bills%2F..%2F..%2Fdata/1700000000/1", 404],
    ["dots as the mailbox", "/api/captures/%2E%2E/1700000000/1", 404],
    ["a UIDVALIDITY that is not a number", "/api/captures/proton-bills/17x/1", 400],
    ["an encoded traversal as the UIDVALIDITY", "/api/captures/proton-bills/..%2F..%2F/1", 400],
    ["uid 0", "/api/captures/proton-bills/1700000000/0", 400],
    ["a negative uid", "/api/captures/proton-bills/1700000000/-1", 400],
    ["a leading zero uid", "/api/captures/proton-bills/1700000000/01", 400],
    ["a fractional uid", "/api/captures/proton-bills/1700000000/1.5", 400],
    ["a uid too large to be exact", "/api/captures/proton-bills/1700000000/99999999999999999999", 400],
  ])("refuses %s", async (_label, path, status) => {
    await saveThree();
    const res = await get(path);
    expect(res.status).toBe(status);
    expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(await res.json()).toHaveProperty("error");
  });

  it("never escapes the store with .. in the address", async () => {
    await saveThree();
    // URL parsing folds plain dots before routing (this becomes /settings,
    // outside the API); encoded ones stay inside a param and match no route.
    const res = await get("/api/captures/proton-bills/1700000000/../../../../settings");
    expect(res.status).toBe(404);
    const res2 = await get("/api/captures/proton-bills/1700000000/1/raw/..%2F..%2Fcapture.json");
    expect(res2.status).toBe(404);
    expect(await res2.json()).toEqual({ error: "There is nothing here." });
  });
});

describe("downloads", () => {
  it("sends the raw email as <uid>.eml", async () => {
    await saveThree();
    const res = await get("/api/captures/proton-bills/1700000000/1/raw");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="1.eml"; filename*=UTF-8''1.eml`);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const dir = server.store.messageDir("Proton bills", "1700000000", 1);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(readFileSync(join(dir, "message.eml")));
  });

  it("sends an attachment by its 1-based number", async () => {
    await saveThree();
    const res = await get("/api/captures/proton-bills/1700000000/1/attachments/1");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="bill.pdf"; filename*=UTF-8''bill.pdf`);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("%PDF-1.4\n");
  });

  it.each([
    ["0", 400],
    ["2", 404],
    ["-1", 400],
    ["1.0", 400],
    ["abc", 400],
    ["99999999999999999999", 404],
  ])("refuses attachment number %s", async (index, status) => {
    await saveThree();
    const res = await get(`/api/captures/proton-bills/1700000000/1/attachments/${index}`);
    expect(res.status).toBe(status);
    expect(await res.json()).toHaveProperty("error");
  });

  it("refuses an attachment path in capture.json that leads outside the message folder", async () => {
    await saveThree();
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = server.store.messageDir("Proton bills", "1700000000", 1);
    const capture = JSON.parse(readFileSync(join(dir, "capture.json"), "utf8"));
    writeFileSync(join(server.dir, "secret.txt"), "outside");
    for (const file of ["../2/message.eml", "../../../../secret.txt", join(server.dir, "secret.txt"), ".", "attachments/../../1"]) {
      capture.attachments[0].file = file;
      writeFileSync(join(dir, "capture.json"), JSON.stringify(capture));
      const res = await get("/api/captures/proton-bills/1700000000/1/attachments/1");
      expect(res.status, file).toBe(404);
    }
    expect(warn).toHaveBeenCalled();
  });

  it("refuses an attachment reached through a link that leads outside the message folder", async () => {
    await saveThree();
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = server.store.messageDir("Proton bills", "1700000000", 1);
    writeFileSync(join(server.dir, "secret.txt"), "outside");
    // A folder link ("junction" on Windows needs no special rights; elsewhere it is a plain symlink).
    symlinkSync(server.dir, join(dir, "attachments", "outside"), "junction");
    const capture = JSON.parse(readFileSync(join(dir, "capture.json"), "utf8"));
    capture.attachments[0].file = "attachments/outside/secret.txt";
    writeFileSync(join(dir, "capture.json"), JSON.stringify(capture));
    const res = await get("/api/captures/proton-bills/1700000000/1/attachments/1");
    expect(res.status).toBe(404);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("it leads outside"));
  });

  it("makes a safe download name from whatever the sender called the file", () => {
    expect(attachmentDisposition("bill.pdf")).toBe(`attachment; filename="bill.pdf"; filename*=UTF-8''bill.pdf`);
    expect(attachmentDisposition('../../etc/pass"wd')).toBe(`attachment; filename="passwd"; filename*=UTF-8''passwd`);
    expect(attachmentDisposition("Rechnung März.pdf")).toBe(
      `attachment; filename="Rechnung M_rz.pdf"; filename*=UTF-8''Rechnung%20M%C3%A4rz.pdf`,
    );
    expect(attachmentDisposition("a\r\nSet-Cookie: x=1.pdf")).toBe(
      `attachment; filename="aSet-Cookie_ x_1.pdf"; filename*=UTF-8''aSet-Cookie%3A%20x%3D1.pdf`,
    );
    expect(attachmentDisposition("it's (1).pdf")).toContain("filename*=UTF-8''it%27s%20%281%29.pdf");
    expect(attachmentDisposition("...")).toBe(`attachment; filename="download"; filename*=UTF-8''download`);
  });
});

describe("GET /api/settings", () => {
  it("describes the settings in use without any password", async () => {
    const res = await get("/api/settings");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(BRIDGE_PASSWORD);
    const body = JSON.parse(text);
    expect(body).toMatchObject({
      configPath: "/app/config.yml",
      logLevel: "info",
      web: { port: 8080 },
      capture: { everyMinutes: 15 },
      mailboxes: [
        {
          name: "Proton bills",
          slug: "proton-bills",
          provider: "proton-bridge",
          folder: "Folders/Bills",
          imap: {
            host: "127.0.0.1",
            port: 1143,
            security: "starttls",
            username: "sam@proton.me",
            passwordEnv: "PROTON_BRIDGE_PASSWORD",
            passwordSet: true,
          },
        },
      ],
    });
    expect(Object.keys(body.mailboxes[0].imap).sort()).toEqual(
      ["host", "passwordEnv", "passwordSet", "port", "security", "username"].sort(),
    );
  });

  it("says when a mailbox has no password", async () => {
    server.close();
    const config = testConfig();
    config.mailboxes[0]!.imap.password = "";
    server = makeServer({ config });
    cookie = await setUp(server.app);
    const body = await json<SettingsResponse>(await get("/api/settings"));
    expect(body.mailboxes[0]?.imap.passwordSet).toBe(false);
  });
});
