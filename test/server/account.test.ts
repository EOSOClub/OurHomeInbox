// Changing your own sign-in password.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiError } from "../../src/shared/api.js";
import { ADMIN, call, json, makeServer, sessionCookie, setUp, type TestServer } from "./helpers.js";

let server: TestServer;
let cookie: string;

beforeEach(async () => {
  server = makeServer();
  cookie = await setUp(server.app);
});

afterEach(() => {
  server.close();
});

const change = (body: unknown, as = cookie) => call(server.app, "/api/account/password", { method: "PUT", cookie: as, body });
const signIn = (password: string) => call(server.app, "/api/session", { method: "POST", body: { email: ADMIN.email, password } });

describe("PUT /api/account/password", () => {
  it("changes it, keeps this session, and signs out the others", async () => {
    const other = sessionCookie(await signIn(ADMIN.password))!;
    const res = await change({ currentPassword: ADMIN.password, newPassword: "a brand new password" });
    expect(res.status).toBe(204);
    expect((await call(server.app, "/api/session", { cookie })).status).toBe(200);
    expect((await json<{ user: unknown }>(await call(server.app, "/api/session", { cookie }))).user).not.toBeNull();
    expect((await json<{ user: unknown }>(await call(server.app, "/api/session", { cookie: other }))).user).toBeNull();
    expect((await signIn(ADMIN.password)).status).toBe(401);
    expect((await signIn("a brand new password")).status).toBe(200);
  });

  it("needs the current password, and a wrong one does not sign the page out", async () => {
    const res = await change({ currentPassword: "not my password", newPassword: "a brand new password" });
    expect(res.status).toBe(400);
    expect((await json<ApiError>(res)).error).toBe("Your current password is not right.");
    expect((await json<{ user: unknown }>(await call(server.app, "/api/session", { cookie }))).user).not.toBeNull();
    expect((await signIn(ADMIN.password)).status).toBe(200);
  });

  it.each([
    [{ currentPassword: ADMIN.password, newPassword: "short" }, "at least 10 characters"],
    [{ currentPassword: ADMIN.password, newPassword: ADMIN.password }, "different from your current one"],
    [{ currentPassword: "", newPassword: "a brand new password" }, "Enter your current password."],
  ])("refuses %j", async (body, message) => {
    const res = await change(body);
    expect(res.status).toBe(400);
    expect((await json<ApiError>(res)).error).toContain(message);
  });

  it("stops after too many wrong current passwords", async () => {
    for (let i = 0; i < 5; i++) expect((await change({ currentPassword: `wrong ${i}`, newPassword: "a brand new password" })).status).toBe(400);
    const res = await change({ currentPassword: ADMIN.password, newPassword: "a brand new password" });
    expect(res.status).toBe(429);
  });

  it("needs a signed-in person", async () => {
    expect((await change({ currentPassword: ADMIN.password, newPassword: "a brand new password" }, "")).status).toBe(401);
  });
});
