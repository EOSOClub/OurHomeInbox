// Signing in and out, first-time setup, and your own password:
//   GET    /api/session            who is signed in, and whether setup is still needed
//   POST   /api/session            sign in
//   DELETE /api/session            sign out
//   POST   /api/setup              create the household and its first (admin) account
//   PUT    /api/account/password   change your own password
// Also the middleware that reads the session cookie on every /api request.

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { MIN_PASSWORD_LENGTH, type SessionResponse, type SessionUser } from "../shared/api.js";
import {
  createSession,
  deleteSession,
  findSession,
  hashPassword,
  hashToken,
  LoginLimiter,
  SESSION_COOKIE,
  verifyAgainstDummy,
  verifyPassword,
} from "./auth.js";
import type { Database } from "./db.js";
import { apiError, clientIp, isHttps, jsonBody, MESSAGES, type AppEnv } from "./http.js";

export interface SessionDeps {
  db: Database;
  now: () => Date;
  /** Called once first-time setup has made the household (to copy config.yml's mailboxes into it). */
  onSetUp?: () => void;
}

const LOGIN_FAILED = "That email and password do not match an account.";
const TOO_MANY = "Too many sign-in attempts. Please wait 15 minutes and try again.";
const ALREADY_SET_UP = "OurHomeInbox is already set up. Sign in instead.";
const WRONG_CURRENT = "Your current password is not right.";
const TOO_MANY_TRIES = "Too many wrong passwords. Please wait 15 minutes and try again.";

// Generous upper limits: they only stop silly sizes, never a real name.
const MAX_TEXT = 200;
const MAX_PASSWORD = 1000;

const loginSchema = z.object(
  {
    email: z.string({ error: "Enter your email address." }).trim().min(1, "Enter your email address.").max(MAX_TEXT, LOGIN_FAILED),
    password: z.string({ error: "Enter your password." }).min(1, "Enter your password.").max(MAX_PASSWORD, LOGIN_FAILED),
  },
  { error: MESSAGES.badShape },
);

const setupSchema = z.object(
  {
    householdName: z
      .string({ error: "Enter a name for your household." })
      .trim()
      .min(1, "Enter a name for your household.")
      .max(MAX_TEXT, `Keep the household name under ${MAX_TEXT} characters.`),
    name: z
      .string({ error: "Enter your name." })
      .trim()
      .min(1, "Enter your name.")
      .max(MAX_TEXT, `Keep your name under ${MAX_TEXT} characters.`),
    email: z
      .string({ error: "Enter your email address." })
      .trim()
      .max(MAX_TEXT, `Keep the email address under ${MAX_TEXT} characters.`)
      .pipe(z.email("Enter a valid email address, like name@example.com.")),
    password: z
      .string({ error: "Choose a password." })
      .min(MIN_PASSWORD_LENGTH, `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`)
      .max(MAX_PASSWORD, `Keep the password under ${MAX_PASSWORD} characters.`),
  },
  { error: MESSAGES.badShape },
);

const passwordChangeSchema = z.object(
  {
    currentPassword: z
      .string({ error: "Enter your current password." })
      .min(1, "Enter your current password.")
      .max(MAX_PASSWORD, WRONG_CURRENT),
    newPassword: z
      .string({ error: "Choose a new password." })
      .min(MIN_PASSWORD_LENGTH, `Choose a new password of at least ${MIN_PASSWORD_LENGTH} characters.`)
      .max(MAX_PASSWORD, `Keep the password under ${MAX_PASSWORD} characters.`),
  },
  { error: MESSAGES.badShape },
);

function hasUsers(db: Database): boolean {
  return db.get<{ one: number }>("SELECT 1 AS one FROM users LIMIT 1") !== undefined;
}

function setSessionCookie(c: Context, token: string, expiresAt: Date, now: Date): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: isHttps(c),
    expires: expiresAt,
    maxAge: Math.floor((expiresAt.getTime() - now.getTime()) / 1000),
  });
}

function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", httpOnly: true, sameSite: "Lax", secure: isHttps(c) });
}

/** Reads the session cookie into c.var.user, clearing a cookie that names no live session. */
export function loadSession(deps: SessionDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set("user", null);
    c.set("sessionToken", null);
    const token = getCookie(c, SESSION_COOKIE);
    if (token !== undefined) {
      const user = token === "" ? null : findSession(deps.db, token, deps.now());
      if (user) {
        c.set("user", user);
        c.set("sessionToken", token);
      } else {
        clearSessionCookie(c);
      }
    }
    await next();
  };
}

/** The routes anyone may use; everything else under /api needs a signed-in user. */
const PUBLIC = new Set(["GET /api/health", "GET /api/session", "POST /api/session", "POST /api/setup"]);

export const requireSignIn: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.var.user === null && !PUBLIC.has(`${c.req.method} ${c.req.path}`)) return apiError(c, 401, MESSAGES.signIn);
  await next();
};

export function sessionRoutes(deps: SessionDeps): Hono<AppEnv> {
  const { db, now } = deps;
  const limiter = new LoginLimiter(now);
  const app = new Hono<AppEnv>();

  const respond = (c: Context, user: SessionUser | null) => {
    const body: SessionResponse = { user, setupNeeded: !hasUsers(db) };
    return c.json(body);
  };

  app.get("/session", (c) => respond(c, c.var.user));

  app.post("/session", jsonBody(loginSchema), async (c) => {
    const { email, password } = c.req.valid("json");
    const key = email.toLowerCase();
    const ip = clientIp(c);
    if (limiter.blocked(key, ip)) return apiError(c, 429, TOO_MANY);

    const user = db.get<{ id: number; password_hash: string }>("SELECT id, password_hash FROM users WHERE email = ?", email);
    let ok = false;
    if (user) ok = await verifyPassword(password, user.password_hash);
    else await verifyAgainstDummy(password);
    if (!user || !ok) {
      limiter.fail(key, ip);
      return apiError(c, 401, LOGIN_FAILED);
    }

    limiter.succeed(key);
    // A sign-in replaces whatever session this browser had.
    const previous = c.var.sessionToken;
    if (previous !== null) deleteSession(db, previous);
    const at = now();
    const session = createSession(db, user.id, at);
    setSessionCookie(c, session.token, session.expiresAt, at);
    return respond(c, findSession(db, session.token, at));
  });

  app.delete("/session", (c) => {
    const token = c.var.sessionToken;
    if (token !== null) deleteSession(db, token);
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  app.post("/setup", jsonBody(setupSchema), async (c) => {
    // Checked before hashing too, so a finished setup answers at once.
    if (hasUsers(db)) return apiError(c, 409, ALREADY_SET_UP);
    const input = c.req.valid("json");
    const passwordHash = await hashPassword(input.password);
    const at = now();
    const stamp = at.toISOString();

    // The check and the inserts are one transaction, so two setups racing
    // cannot both create an admin.
    const userId = db.transaction(() => {
      if (hasUsers(db)) return null;
      const household = db.run("INSERT INTO households (name, created_at) VALUES (?, ?)", input.householdName, stamp);
      const user = db.run(
        "INSERT INTO users (household_id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, 1, ?)",
        household.lastInsertRowid,
        input.email,
        input.name,
        passwordHash,
        stamp,
      );
      return user.lastInsertRowid;
    });
    if (userId === null) return apiError(c, 409, ALREADY_SET_UP);
    deps.onSetUp?.();

    const session = createSession(db, userId, at);
    setSessionCookie(c, session.token, session.expiresAt, at);
    return respond(c, findSession(db, session.token, at));
  });

  // Changing your own password. Wrong guesses count toward the same limit as
  // signing in. A wrong current password is a 400, not a 401, which would
  // sign the page out. Your other sessions are signed out; this one stays.
  app.put("/account/password", jsonBody(passwordChangeSchema), async (c) => {
    const user = c.var.user as SessionUser;
    const { currentPassword, newPassword } = c.req.valid("json");
    const key = user.email.toLowerCase();
    const ip = clientIp(c);
    if (limiter.blocked(key, ip)) return apiError(c, 429, TOO_MANY_TRIES);
    const row = db.get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", user.id);
    if (!row || !(await verifyPassword(currentPassword, row.password_hash))) {
      limiter.fail(key, ip);
      return apiError(c, 400, WRONG_CURRENT);
    }
    if (newPassword === currentPassword) return apiError(c, 400, "Choose a new password that is different from your current one.");
    const passwordHash = await hashPassword(newPassword);
    const keep = c.var.sessionToken === null ? "" : hashToken(c.var.sessionToken);
    db.transaction(() => {
      db.run("UPDATE users SET password_hash = ? WHERE id = ?", passwordHash, user.id);
      db.run("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", user.id, keep);
    });
    limiter.succeed(key);
    return c.body(null, 204);
  });

  return app;
}
