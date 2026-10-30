import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_DAYS } from "../../src/server/auth.js";
import { ADMIN, call, makeServer, sessionCookie, setUp, type TestServer } from "./helpers.js";

let server: TestServer;

beforeEach(() => {
  server = makeServer();
});

afterEach(() => {
  server.close();
});

const LOGIN_FAILED = "That email and password do not match an account.";

describe("health", () => {
  it("answers without sign-in", async () => {
    const res = await call(server.app, "/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: "0.1.0-test" });
  });
});

describe("first-time setup", () => {
  it("says setup is needed until an account exists", async () => {
    const res = await call(server.app, "/api/session");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null, setupNeeded: true });
  });

  it("creates the household and an admin, and signs in", async () => {
    const res = await call(server.app, "/api/setup", { method: "POST", body: ADMIN });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      setupNeeded: false,
      user: {
        id: expect.any(Number),
        email: ADMIN.email,
        name: ADMIN.name,
        isAdmin: true,
        household: { id: expect.any(Number), name: ADMIN.householdName },
      },
    });

    const setCookie = res.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/ohi_session=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Secure"); // plain http here
    expect(setCookie).toContain(`Max-Age=${SESSION_DAYS * 24 * 60 * 60}`);

    const session = await call(server.app, "/api/session", { cookie: sessionCookie(res) });
    expect(await session.json()).toMatchObject({ setupNeeded: false, user: { email: ADMIN.email, isAdmin: true } });
  });

  it("stores only a hash of the password and of the session token", async () => {
    const cookie = await setUp(server.app);
    const user = server.db.get<{ password_hash: string }>("SELECT password_hash FROM users");
    expect(user?.password_hash).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(user?.password_hash).not.toContain(ADMIN.password);
    const token = cookie.split("=")[1]!;
    const session = server.db.get<{ token_hash: string }>("SELECT token_hash FROM sessions");
    expect(session?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(session?.token_hash).not.toBe(token);
  });

  it("refuses a second setup with 409", async () => {
    await setUp(server.app);
    const res = await call(server.app, "/api/setup", {
      method: "POST",
      body: { ...ADMIN, email: "intruder@example.com" },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "OurHomeInbox is already set up. Sign in instead." });
    expect(server.db.get<{ n: number }>("SELECT count(*) AS n FROM users")?.n).toBe(1);
  });

  it("refuses a short password, a bad email and missing fields with a plain message", async () => {
    const short = await call(server.app, "/api/setup", { method: "POST", body: { ...ADMIN, password: "short" } });
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual({ error: "Choose a password of at least 10 characters." });

    const email = await call(server.app, "/api/setup", { method: "POST", body: { ...ADMIN, email: "not an email" } });
    expect(email.status).toBe(400);
    expect(await email.json()).toEqual({ error: "Enter a valid email address, like name@example.com." });

    const missing = await call(server.app, "/api/setup", { method: "POST", body: { ...ADMIN, householdName: undefined } });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "Enter a name for your household." });

    const notObject = await call(server.app, "/api/setup", { method: "POST", body: [1, 2] });
    expect(notObject.status).toBe(400);
    expect(await notObject.json()).toEqual({ error: "Some of what was sent is missing or not in the right form." });

    expect(server.db.get<{ n: number }>("SELECT count(*) AS n FROM users")?.n).toBe(0);
  });

  it("answers malformed JSON with 400", async () => {
    const res = await call(server.app, "/api/setup", { method: "POST", body: "{not json" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "The request could not be read. Please try again." });
  });
});

describe("sign-in", () => {
  beforeEach(async () => {
    await setUp(server.app);
  });

  it("gives the same message for a wrong password and an unknown email", async () => {
    const wrong = await call(server.app, "/api/session", { method: "POST", body: { email: ADMIN.email, password: "wrong password" } });
    const unknown = await call(server.app, "/api/session", {
      method: "POST",
      body: { email: "nobody@example.com", password: ADMIN.password },
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: LOGIN_FAILED });
    expect(await unknown.json()).toEqual({ error: LOGIN_FAILED });
    expect(sessionCookie(wrong)).toBeNull();
    expect(sessionCookie(unknown)).toBeNull();
  });

  it("signs in with the right password, whatever the email's capitals", async () => {
    const res = await call(server.app, "/api/session", {
      method: "POST",
      body: { email: "  SAM@Example.com ", password: ADMIN.password },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { email: ADMIN.email, name: ADMIN.name } });
    const cookie = sessionCookie(res);
    expect(cookie).not.toBeNull();
    expect((await call(server.app, "/api/captures", { cookie })).status).toBe(200);
  });

  it("marks the cookie Secure behind an https proxy", async () => {
    const res = await call(server.app, "/api/session", {
      method: "POST",
      body: { email: ADMIN.email, password: ADMIN.password },
      headers: { "X-Forwarded-Proto": "https" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join("\n")).toContain("Secure");
  });

  it("blocks an email after 5 failures in 15 minutes, even with the right password", async () => {
    for (let i = 0; i < 5; i++) {
      const ip = `10.0.0.${i + 1}`; // a different address each time: the email limit alone
      const res = await call(server.app, "/api/session", { method: "POST", ip, body: { email: ADMIN.email, password: "wrong password" } });
      expect(res.status).toBe(401);
    }
    const blocked = await call(server.app, "/api/session", {
      method: "POST",
      ip: "10.0.0.99",
      body: { email: ADMIN.email, password: ADMIN.password },
    });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "Too many sign-in attempts. Please wait 15 minutes and try again." });

    server.clock.now = new Date(server.clock.now.getTime() + 15 * 60 * 1000 + 1);
    const later = await call(server.app, "/api/session", {
      method: "POST",
      ip: "10.0.0.99",
      body: { email: ADMIN.email, password: ADMIN.password },
    });
    expect(later.status).toBe(200);
  });

  it("blocks an address after 5 failures, whichever emails it tried", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await call(server.app, "/api/session", {
        method: "POST",
        ip: "10.0.0.7",
        body: { email: `guess${i}@example.com`, password: "wrong password" },
      });
      expect(res.status).toBe(401);
    }
    const blocked = await call(server.app, "/api/session", {
      method: "POST",
      ip: "10.0.0.7",
      body: { email: ADMIN.email, password: ADMIN.password },
    });
    expect(blocked.status).toBe(429);
    const elsewhere = await call(server.app, "/api/session", {
      method: "POST",
      ip: "10.0.0.8",
      body: { email: ADMIN.email, password: ADMIN.password },
    });
    expect(elsewhere.status).toBe(200);
  });
});

describe("sessions", () => {
  it("signs out: the session ends and the cookie is cleared", async () => {
    const cookie = await setUp(server.app);
    const res = await call(server.app, "/api/session", { method: "DELETE", cookie });
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie().join("\n")).toMatch(/ohi_session=;.*Max-Age=0/);
    expect(server.db.get<{ n: number }>("SELECT count(*) AS n FROM sessions")?.n).toBe(0);

    const after = await call(server.app, "/api/session", { cookie });
    expect(await after.json()).toEqual({ user: null, setupNeeded: false });
    expect((await call(server.app, "/api/captures", { cookie })).status).toBe(401);
  });

  it("ends a session after 30 days", async () => {
    const cookie = await setUp(server.app);
    server.clock.now = new Date(server.clock.now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
    const res = await call(server.app, "/api/session", { cookie });
    expect(await res.json()).toEqual({ user: null, setupNeeded: false });
    expect(res.headers.getSetCookie().join("\n")).toMatch(/ohi_session=;/);
    expect(server.db.get<{ n: number }>("SELECT count(*) AS n FROM sessions")?.n).toBe(0);
  });

  it("records when a session was last used", async () => {
    const cookie = await setUp(server.app);
    server.clock.now = new Date("2026-10-30T08:00:00Z");
    await call(server.app, "/api/session", { cookie });
    expect(server.db.get<{ last_seen_at: string }>("SELECT last_seen_at FROM sessions")?.last_seen_at).toBe(
      "2026-10-30T08:00:00.000Z",
    );
  });

  it("ignores a made-up session cookie", async () => {
    await setUp(server.app);
    const res = await call(server.app, "/api/captures", { cookie: "ohi_session=made-up-token" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Please sign in first." });
  });
});

describe("sign-in required", () => {
  it.each([
    ["GET", "/api/captures"],
    ["GET", "/api/captures/proton-bills/1700000000/1"],
    ["GET", "/api/captures/proton-bills/1700000000/1/raw"],
    ["GET", "/api/captures/proton-bills/1700000000/1/attachments/1"],
    ["GET", "/api/settings"],
    ["DELETE", "/api/session"],
    ["GET", "/api/no-such-thing"],
  ])("%s %s answers 401 when signed out", async (method, path) => {
    await setUp(server.app);
    const res = await call(server.app, path, { method });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Please sign in first." });
  });
});

describe("cross-site protection", () => {
  it("blocks a sign-in sent from another website", async () => {
    await setUp(server.app);
    const res = await call(server.app, "/api/session", {
      method: "POST",
      body: { email: ADMIN.email, password: ADMIN.password },
      headers: { Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "This request came from another website, so it was blocked." });
    expect(sessionCookie(res)).toBeNull();
  });

  it("blocks a sign-out sent from another website", async () => {
    const cookie = await setUp(server.app);
    const res = await call(server.app, "/api/session", { method: "DELETE", cookie, headers: { Origin: "null" } });
    expect(res.status).toBe(403);
    expect(server.db.get<{ n: number }>("SELECT count(*) AS n FROM sessions")?.n).toBe(1);
  });

  it("blocks a request the browser marks as cross-site", async () => {
    const res = await call(server.app, "/api/setup", { method: "POST", body: ADMIN, headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(res.status).toBe(403);
  });

  it("allows the same origin", async () => {
    const res = await call(server.app, "/api/setup", {
      method: "POST",
      body: ADMIN,
      headers: { Origin: "http://localhost", "Sec-Fetch-Site": "same-origin" },
    });
    expect(res.status).toBe(200);
  });

  it("refuses a body that is not JSON, like a plain HTML form", async () => {
    const res = await call(server.app, "/api/setup", {
      method: "POST",
      body: "householdName=x&name=y&email=a%40b.c&password=0123456789",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "The request was sent in a form OurHomeInbox does not accept." });
    const textPlain = await call(server.app, "/api/setup", {
      method: "POST",
      body: JSON.stringify(ADMIN),
      headers: { "Content-Type": "text/plain" },
    });
    expect(textPlain.status).toBe(415);
    expect(server.db.get<{ n: number }>("SELECT count(*) AS n FROM users")?.n).toBe(0);
  });

  it("refuses an oversized body", async () => {
    const res = await call(server.app, "/api/setup", { method: "POST", body: { ...ADMIN, name: "x".repeat(100_000) } });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "That request is too large." });
  });
});
