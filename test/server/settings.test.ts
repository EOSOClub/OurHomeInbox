// The install's settings over the API: shown without secrets, changed from
// the web into config.yml (comments kept) and applied at once, reloaded after
// a hand edit, and a broken file refused with the settings in use kept.

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/server/auth.js";
import type { ApiError, MailboxListResponse, SettingsResponse } from "../../src/shared/api.js";
import { BRIDGE_PASSWORD, call, json, makeServer, sessionCookie, setUp, TEST_CONFIG_YAML, type TestServer } from "./helpers.js";

let server: TestServer;
let cookie: string;

beforeEach(async () => {
  server = makeServer();
  cookie = await setUp(server.app);
});

afterEach(() => {
  try {
    chmodSync(server.configPath, 0o644);
  } catch {
    // already gone
  }
  server.close();
});

const get = (path: string, as = cookie) => call(server.app, path, { cookie: as });
const send = (method: string, path: string, body?: unknown, as = cookie) => call(server.app, path, { method, cookie: as, body });

describe("GET /api/settings", () => {
  it("describes the settings in use, never a secret", async () => {
    const res = await get("/api/settings");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(BRIDGE_PASSWORD);
    expect(JSON.parse(text)).toEqual({
      configPath: server.configPath,
      logLevel: "info",
      captureEveryMinutes: 15,
      web: { port: 8080 },
      docker: null,
      canEdit: true,
      needsRestart: [],
      // The mailbox config.yml lists was copied into the database at setup and is not read again.
      ignoredMailboxes: 1,
      secretKey: "file",
    });
  });
});

describe("changing settings", () => {
  it("writes them into config.yml, keeping its comments, and applies them at once", async () => {
    const res = await send("PUT", "/api/settings", { logLevel: "debug", captureEveryMinutes: 5 });
    expect(res.status).toBe(200);
    expect(await json<SettingsResponse>(res)).toMatchObject({ logLevel: "debug", captureEveryMinutes: 5 });
    expect(readFileSync(server.configPath, "utf8")).toBe(
      TEST_CONFIG_YAML.replace("log_level: info", "log_level: debug").replace("every_minutes: 15 #", "every_minutes: 5 #"),
    );
    expect(readFileSync(join(server.dir, "data", "config.yml.bak"), "utf8")).toBe(TEST_CONFIG_YAML);
    expect((await json<MailboxListResponse>(await get("/api/mailboxes"))).checking.everyMinutes).toBe(5);
  });

  it.each([
    [{ logLevel: "loud", captureEveryMinutes: 5 }, "Choose a log level."],
    [{ logLevel: "info", captureEveryMinutes: 0 }, "at most every 1 minute"],
    [{ logLevel: "info", captureEveryMinutes: 2000 }, "at least once a day"],
    [{ logLevel: "info", captureEveryMinutes: 2.5 }, "whole number"],
  ])("refuses %j", async (body, message) => {
    const res = await send("PUT", "/api/settings", body);
    expect(res.status).toBe(400);
    expect((await json<ApiError>(res)).error).toContain(message);
    expect(readFileSync(server.configPath, "utf8")).toBe(TEST_CONFIG_YAML);
  });

  it("says plainly when config.yml cannot be written, changing nothing", async () => {
    chmodSync(server.configPath, 0o444);
    const res = await send("PUT", "/api/settings", { logLevel: "debug", captureEveryMinutes: 5 });
    // Some systems let the file's owner write a read-only file anyway; where they do not, the reason is given.
    if (res.status === 409) {
      expect((await json<ApiError>(res)).error).toMatch(/cannot be written .*Run docker\/deploy\.sh once/);
      expect((await json<SettingsResponse>(await get("/api/settings"))).logLevel).toBe("info");
    } else {
      expect(res.status).toBe(200);
    }
  });

  it("lets only an admin change settings or reload them", async () => {
    const household = server.db.get<{ id: number }>("SELECT id FROM households")!.id;
    server.db.run(
      "INSERT INTO users (household_id, email, name, password_hash, is_admin, created_at) VALUES (?, 'kim@example.com', 'Kim', ?, 0, '2026-10-29')",
      household,
      await hashPassword("member password 1"),
    );
    const member = sessionCookie(await call(server.app, "/api/session", { method: "POST", body: { email: "kim@example.com", password: "member password 1" } }))!;
    expect((await json<SettingsResponse>(await get("/api/settings", member))).canEdit).toBe(false);
    expect((await send("PUT", "/api/settings", { logLevel: "debug", captureEveryMinutes: 5 }, member)).status).toBe(403);
    expect((await send("POST", "/api/settings/reload", undefined, member)).status).toBe(403);
  });
});

describe("reloading config.yml", () => {
  it("applies a hand edit without a restart", async () => {
    writeFileSync(server.configPath, TEST_CONFIG_YAML.replace("every_minutes: 15", "every_minutes: 30"));
    const res = await send("POST", "/api/settings/reload");
    expect(res.status).toBe(200);
    expect((await json<SettingsResponse>(res)).captureEveryMinutes).toBe(30);
    expect((await json<MailboxListResponse>(await get("/api/mailboxes"))).checking.everyMinutes).toBe(30);
  });

  it("refuses a broken file and keeps the settings in use", async () => {
    writeFileSync(server.configPath, "capture:\n  every_minutes: often\n");
    const res = await send("POST", "/api/settings/reload");
    expect(res.status).toBe(409);
    expect((await json<ApiError>(res)).error).toMatch(/^config\.yml has a problem, so the settings in use were kept: .*capture\.every_minutes/);
    expect((await json<SettingsResponse>(await get("/api/settings"))).captureEveryMinutes).toBe(15);
  });

  it("says when the web port changed, which needs docker/deploy.sh", async () => {
    writeFileSync(server.configPath, TEST_CONFIG_YAML.replace("port: 8080", "port: 9090"));
    const body = await json<SettingsResponse>(await send("POST", "/api/settings/reload"));
    expect(body.needsRestart).toEqual(["The web port in config.yml is 9090, but OurHomeInbox is running on 8080. Run docker/deploy.sh for it to take effect."]);
  });
});
