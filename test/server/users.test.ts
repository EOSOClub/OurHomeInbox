// The household's people: the list, adding a person (who can then sign in),
// changing them, a new password for someone who forgot theirs, removing
// someone, the household always keeping an admin, only admins managing
// people, and other households kept apart.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiError, CaptureReview, CaptureListResponse, HouseholdUser, SessionResponse, UserListResponse } from "../../src/shared/api.js";
import { ADMIN, call, json, makeServer, rawEmail, saveEmail, sessionCookie, setUp, type TestServer } from "./helpers.js";

let server: TestServer;
let cookie: string;

const KIM = { name: "Kim Smith", email: "kim@example.com", password: "kims password 1", isAdmin: false };

beforeEach(async () => {
  server = makeServer();
  cookie = await setUp(server.app);
});

afterEach(() => {
  server.close();
});

const send = (method: string, path: string, body?: unknown, as = cookie) => call(server.app, path, { method, cookie: as, body });

async function users(as = cookie): Promise<UserListResponse> {
  return json<UserListResponse>(await call(server.app, "/api/users", { cookie: as }));
}

async function add(person: typeof KIM = KIM, as = cookie): Promise<HouseholdUser> {
  const res = await send("POST", "/api/users", person, as);
  expect(res.status, await res.clone().text()).toBe(201);
  return json<HouseholdUser>(res);
}

async function signIn(email: string, password: string): Promise<Response> {
  return call(server.app, "/api/session", { method: "POST", body: { email, password } });
}

async function errorOf(res: Response): Promise<string> {
  return (await json<ApiError>(res)).error;
}

describe("the household's people", () => {
  it("lists everyone, with no password, and says who is asking", async () => {
    const list = await users();
    expect(list.canManage).toBe(true);
    expect(list.users).toEqual([{ id: expect.any(Number), name: ADMIN.name, email: ADMIN.email, isAdmin: true, createdAt: expect.any(String), you: true }]);
    expect(JSON.stringify(list)).not.toMatch(/password|scrypt/);
  });

  it("needs a signed-in person", async () => {
    expect((await call(server.app, "/api/users")).status).toBe(401);
    expect((await call(server.app, "/api/users", { method: "POST", body: KIM })).status).toBe(401);
  });

  it("adds a person, who can then sign in and do everything but manage people", async () => {
    const kim = await add();
    expect(kim).toMatchObject({ name: KIM.name, email: KIM.email, isAdmin: false, you: false });
    expect((await users()).users.map((u) => u.name)).toEqual([KIM.name, ADMIN.name]);

    const res = await signIn(KIM.email, KIM.password);
    expect(res.status).toBe(200);
    expect(await json<SessionResponse>(res)).toMatchObject({ user: { email: KIM.email, isAdmin: false, household: { name: ADMIN.householdName } } });
    const kimCookie = sessionCookie(res)!;

    // Sees everyone, but cannot manage people.
    const seen = await users(kimCookie);
    expect(seen.canManage).toBe(false);
    expect(seen.users.find((u) => u.you)?.email).toBe(KIM.email);
    expect((await send("POST", "/api/users", { ...KIM, email: "lee@example.com" }, kimCookie)).status).toBe(403);
    expect((await send("PUT", `/api/users/${kim.id}`, { ...KIM, isAdmin: true }, kimCookie)).status).toBe(403);
    const admin = seen.users.find((u) => !u.you)!;
    expect((await send("PUT", `/api/users/${admin.id}/password`, { password: "taken over 123" }, kimCookie)).status).toBe(403);
    expect((await send("DELETE", `/api/users/${admin.id}`, undefined, kimCookie)).status).toBe(403);
    expect(await errorOf(await send("DELETE", `/api/users/${admin.id}`, undefined, kimCookie))).toBe("Only an admin can add, change or remove people.");

    // Everything else, such as the install's settings, is open to them.
    expect((await send("PUT", "/api/settings", { logLevel: "debug", captureEveryMinutes: 5 }, kimCookie)).status).toBe(200);
  });

  it("refuses an email that already has an account, ignoring capitals, and a short password", async () => {
    await add();
    const again = await send("POST", "/api/users", { ...KIM, email: "KIM@Example.com" });
    expect(again.status).toBe(409);
    expect(await errorOf(again)).toBe("That email address already has an account.");
    expect((await send("POST", "/api/users", { ...KIM, email: ADMIN.email })).status).toBe(409);

    const short = await send("POST", "/api/users", { ...KIM, email: "lee@example.com", password: "short" });
    expect(short.status).toBe(400);
    expect(await errorOf(short)).toBe("Choose a password of at least 10 characters.");
    expect(await errorOf(await send("POST", "/api/users", { ...KIM, email: "not an email" }))).toBe("Enter a valid email address, like name@example.com.");
    expect(await errorOf(await send("POST", "/api/users", { ...KIM, name: "  " }))).toBe("Enter their name.");
    expect((await send("POST", "/api/users", { name: "Lee", email: "lee@example.com", password: "long enough 1" })).status).toBe(400);
  });

  it("changes a person's name, email and admin; they sign in with the new email", async () => {
    const kim = await add();
    const res = await send("PUT", `/api/users/${kim.id}`, { name: "Kim Jones", email: "kim.jones@example.com", isAdmin: true });
    expect(res.status).toBe(200);
    expect(await json<HouseholdUser>(res)).toMatchObject({ name: "Kim Jones", email: "kim.jones@example.com", isAdmin: true });
    expect((await signIn(KIM.email, KIM.password)).status).toBe(401);
    const signedIn = await signIn("kim.jones@example.com", KIM.password);
    expect(await json<SessionResponse>(signedIn)).toMatchObject({ user: { isAdmin: true } });
    // Now an admin: can manage people.
    expect((await users(sessionCookie(signedIn)!)).canManage).toBe(true);

    expect((await send("PUT", `/api/users/${kim.id}`, { name: "Kim", email: ADMIN.email, isAdmin: true })).status).toBe(409);
  });

  it("always keeps an admin: the last one cannot stop being one", async () => {
    const me = (await users()).users[0]!;
    const res = await send("PUT", `/api/users/${me.id}`, { name: ADMIN.name, email: ADMIN.email, isAdmin: false });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("The household needs at least one admin. Make someone else an admin first.");

    // With a second admin, the first can step down.
    await add({ ...KIM, isAdmin: true });
    expect((await send("PUT", `/api/users/${me.id}`, { name: ADMIN.name, email: ADMIN.email, isAdmin: false })).status).toBe(200);
    expect((await users()).canManage).toBe(false);
  });

  it("gives someone a new password, signing them out everywhere", async () => {
    const kim = await add();
    const kimCookie = sessionCookie(await signIn(KIM.email, KIM.password))!;
    expect((await call(server.app, "/api/session", { cookie: kimCookie }).then((r) => json<SessionResponse>(r))).user).not.toBeNull();

    const res = await send("PUT", `/api/users/${kim.id}/password`, { password: "a brand new one 2" });
    expect(res.status).toBe(204);
    expect((await call(server.app, "/api/users", { cookie: kimCookie })).status).toBe(401);
    expect((await signIn(KIM.email, KIM.password)).status).toBe(401);
    expect((await signIn(KIM.email, "a brand new one 2")).status).toBe(200);

    expect(await errorOf(await send("PUT", `/api/users/${kim.id}/password`, { password: "short" }))).toBe("Choose a password of at least 10 characters.");
  });

  it("sends an admin to Change your password for their own", async () => {
    const me = (await users()).users[0]!;
    const res = await send("PUT", `/api/users/${me.id}/password`, { password: "no current one 1" });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain("Change your password");
    expect((await signIn(ADMIN.email, ADMIN.password)).status).toBe(200);
  });

  it("removes someone, signing them out; their review marks stay, without a name", async () => {
    await saveEmail(server.store, rawEmail({ subject: "Water bill" }), { uid: 1 });
    const kim = await add();
    const kimCookie = sessionCookie(await signIn(KIM.email, KIM.password))!;
    expect((await send("PUT", "/api/captures/review", { captureIds: ["proton-bills/1700000000/1"], state: "checked" }, kimCookie)).status).toBe(200);

    expect((await send("DELETE", `/api/users/${kim.id}`)).status).toBe(204);
    expect((await users()).users.map((u) => u.email)).toEqual([ADMIN.email]);
    expect((await call(server.app, "/api/users", { cookie: kimCookie })).status).toBe(401);
    expect((await signIn(KIM.email, KIM.password)).status).toBe(401);
    const { captures } = await json<CaptureListResponse>(await call(server.app, "/api/captures", { cookie }));
    expect(captures[0]!.review).toMatchObject<Partial<CaptureReview>>({ state: "checked", by: null });

    expect((await send("DELETE", `/api/users/${kim.id}`)).status).toBe(404);
  });

  it("does not let an admin remove themselves", async () => {
    const me = (await users()).users[0]!;
    const res = await send("DELETE", `/api/users/${me.id}`);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("You cannot remove yourself. Another admin can.");
  });

  it("never reaches another household's people", async () => {
    const stamp = "2026-10-29T00:00:00.000Z";
    const household = server.db.run("INSERT INTO households (name, created_at) VALUES ('The Joneses', ?)", stamp).lastInsertRowid;
    const theirs = server.db.run(
      "INSERT INTO users (household_id, email, name, password_hash, is_admin, created_at) VALUES (?, 'jo@example.com', 'Jo Jones', 'x', 1, ?)",
      household,
      stamp,
    ).lastInsertRowid;
    expect((await users()).users.map((u) => u.email)).toEqual([ADMIN.email]);
    expect((await send("PUT", `/api/users/${theirs}`, { name: "Mine now", email: "jo@example.com", isAdmin: false })).status).toBe(404);
    expect((await send("PUT", `/api/users/${theirs}/password`, { password: "taken over 123" })).status).toBe(404);
    expect((await send("DELETE", `/api/users/${theirs}`)).status).toBe(404);
    expect(server.db.get<{ name: string }>("SELECT name FROM users WHERE id = ?", theirs)?.name).toBe("Jo Jones");
    // A new person always joins the household of the admin adding them.
    const kim = await add();
    expect(server.db.get<{ household_id: number }>("SELECT household_id FROM users WHERE id = ?", kim.id)?.household_id).not.toBe(household);
  });

  it("answers a made-up person or id with not found", async () => {
    for (const id of ["999", "0", "abc", "-1", "1e3"]) {
      expect((await send("DELETE", `/api/users/${id}`)).status, id).toBe(404);
      expect((await send("PUT", `/api/users/${id}`, { name: "X", email: "x@example.com", isAdmin: false })).status, id).toBe(404);
    }
  });
});
