// The household's people:
//   GET    /api/users                  everyone in the household
//   POST   /api/users                  add a person (admin)
//   PUT    /api/users/:id              change a person's name, email or admin (admin)
//   PUT    /api/users/:id/password     give someone else a new password (admin)
//   DELETE /api/users/:id              remove someone else (admin)
//
// Everyone in a household can see and change everything else: it is a shared
// effort to manage the household's money, for adults (owner, 2026-11-01).
// Only an admin adds, changes and removes people. An admin sets a new
// person's first password and tells them; they can change it themselves under
// Settings. A household always keeps at least one admin.
//
// Passwords are kept only as hashes (auth.ts) and never sent back. Giving
// someone a new password, or removing them, signs them out everywhere.

import { Hono, type Context } from "hono";
import { z } from "zod";
import { MIN_PASSWORD_LENGTH, type HouseholdUser, type SessionUser, type UserListResponse } from "../shared/api.js";
import { hashPassword } from "./auth.js";
import type { Database } from "./db.js";
import { apiError, householdOf, jsonBody, MESSAGES, type AppEnv } from "./http.js";

export interface UserDeps {
  db: Database;
  now: () => Date;
}

const ADMIN_ONLY = "Only an admin can add, change or remove people.";
const NOT_FOUND = "That person was not found. They may have been removed.";
const EMAIL_TAKEN = "That email address already has an account.";
const LAST_ADMIN = "The household needs at least one admin. Make someone else an admin first.";
const NOT_YOURSELF = "You cannot remove yourself. Another admin can.";
const OWN_PASSWORD = "To change your own password, use Change your password, which asks for your current one.";

// Generous upper limits, as for setup: they only stop silly sizes.
const MAX_TEXT = 200;
const MAX_PASSWORD = 1000;

const ID = /^[1-9]\d{0,15}$/;

const nameField = z
  .string({ error: "Enter their name." })
  .trim()
  .min(1, "Enter their name.")
  .max(MAX_TEXT, `Keep the name under ${MAX_TEXT} characters.`);
const emailField = z
  .string({ error: "Enter their email address." })
  .trim()
  .max(MAX_TEXT, `Keep the email address under ${MAX_TEXT} characters.`)
  .pipe(z.email("Enter a valid email address, like name@example.com."));
const passwordField = z
  .string({ error: "Choose a password." })
  .min(MIN_PASSWORD_LENGTH, `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`)
  .max(MAX_PASSWORD, `Keep the password under ${MAX_PASSWORD} characters.`);
const adminField = z.boolean({ error: MESSAGES.badShape });

const addSchema = z.object({ name: nameField, email: emailField, password: passwordField, isAdmin: adminField }, { error: MESSAGES.badShape });
const updateSchema = z.object({ name: nameField, email: emailField, isAdmin: adminField }, { error: MESSAGES.badShape });
const passwordSchema = z.object({ password: passwordField }, { error: MESSAGES.badShape });

interface UserRow {
  id: number;
  name: string;
  email: string;
  is_admin: number;
  created_at: string;
}

const SELECT_USERS = "SELECT id, name, email, is_admin, created_at FROM users WHERE household_id = ?";

function userOf(row: UserRow, you: number): HouseholdUser {
  return { id: row.id, name: row.name, email: row.email, isAdmin: row.is_admin === 1, createdAt: row.created_at, you: row.id === you };
}

/** The household's people, by name. */
export function householdUsers(db: Database, householdId: number, you: number): HouseholdUser[] {
  return db
    .all<UserRow>(`${SELECT_USERS} ORDER BY name COLLATE NOCASE, id`, householdId)
    .map((row) => userOf(row, you));
}

function findUser(db: Database, householdId: number, id: number): UserRow | undefined {
  return db.get<UserRow>(`${SELECT_USERS} AND id = ?`, householdId, id);
}

/** True when another account anywhere on the install has this email (emails are the sign-in name, so unique across the install). */
function emailTaken(db: Database, email: string, except: number | null): boolean {
  return db.get<{ id: number }>("SELECT id FROM users WHERE email = ? AND id IS NOT ?", email, except) !== undefined;
}

function adminCount(db: Database, householdId: number): number {
  return db.get<{ n: number }>("SELECT count(*) AS n FROM users WHERE household_id = ? AND is_admin = 1", householdId)?.n ?? 0;
}

function userId(c: Context): number | null {
  const text = c.req.param("id") ?? "";
  if (!ID.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : null;
}

export function userRoutes(deps: UserDeps): Hono<AppEnv> {
  const { db, now } = deps;
  const app = new Hono<AppEnv>();
  const me = (c: Context<AppEnv>) => c.var.user as SessionUser;

  app.get("/users", (c) => {
    const body: UserListResponse = { users: householdUsers(db, householdOf(c), me(c).id), canManage: me(c).isAdmin };
    return c.json(body);
  });

  app.post("/users", jsonBody(addSchema), async (c) => {
    if (!me(c).isAdmin) return apiError(c, 403, ADMIN_ONLY);
    const input = c.req.valid("json");
    const householdId = householdOf(c);
    if (emailTaken(db, input.email, null)) return apiError(c, 409, EMAIL_TAKEN);
    const passwordHash = await hashPassword(input.password);
    // Checked again with the insert, in case the email was taken while hashing.
    const id = db.transaction(() => {
      if (emailTaken(db, input.email, null)) return null;
      return Number(
        db.run(
          "INSERT INTO users (household_id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          householdId,
          input.email,
          input.name,
          passwordHash,
          input.isAdmin ? 1 : 0,
          now().toISOString(),
        ).lastInsertRowid,
      );
    });
    if (id === null) return apiError(c, 409, EMAIL_TAKEN);
    return c.json(userOf(findUser(db, householdId, id)!, me(c).id), 201);
  });

  app.put("/users/:id", jsonBody(updateSchema), (c) => {
    if (!me(c).isAdmin) return apiError(c, 403, ADMIN_ONLY);
    const id = userId(c);
    const householdId = householdOf(c);
    const input = c.req.valid("json");
    const result = db.transaction((): "missing" | "taken" | "last" | "ok" => {
      const row = id === null ? undefined : findUser(db, householdId, id);
      if (!row) return "missing";
      if (emailTaken(db, input.email, row.id)) return "taken";
      if (row.is_admin === 1 && !input.isAdmin && adminCount(db, householdId) <= 1) return "last";
      db.run("UPDATE users SET name = ?, email = ?, is_admin = ? WHERE id = ?", input.name, input.email, input.isAdmin ? 1 : 0, row.id);
      return "ok";
    });
    if (result === "missing") return apiError(c, 404, NOT_FOUND);
    if (result === "taken") return apiError(c, 409, EMAIL_TAKEN);
    if (result === "last") return apiError(c, 409, LAST_ADMIN);
    return c.json(userOf(findUser(db, householdId, id!)!, me(c).id));
  });

  app.put("/users/:id/password", jsonBody(passwordSchema), async (c) => {
    if (!me(c).isAdmin) return apiError(c, 403, ADMIN_ONLY);
    const id = userId(c);
    const householdId = householdOf(c);
    if (id === null || !findUser(db, householdId, id)) return apiError(c, 404, NOT_FOUND);
    if (id === me(c).id) return apiError(c, 400, OWN_PASSWORD);
    const passwordHash = await hashPassword(c.req.valid("json").password);
    const changed = db.transaction(() => {
      if (!findUser(db, householdId, id)) return false;
      db.run("UPDATE users SET password_hash = ? WHERE id = ?", passwordHash, id);
      db.run("DELETE FROM sessions WHERE user_id = ?", id);
      return true;
    });
    if (!changed) return apiError(c, 404, NOT_FOUND);
    return c.body(null, 204);
  });

  app.delete("/users/:id", (c) => {
    if (!me(c).isAdmin) return apiError(c, 403, ADMIN_ONLY);
    const id = userId(c);
    const householdId = householdOf(c);
    if (id === me(c).id) return apiError(c, 409, NOT_YOURSELF);
    // Their sessions go with them (ON DELETE CASCADE); their review marks stay, without a name.
    const removed = id !== null && findUser(db, householdId, id) !== undefined && db.run("DELETE FROM users WHERE id = ? AND household_id = ?", id, householdId).changes > 0;
    if (!removed) return apiError(c, 404, NOT_FOUND);
    return c.body(null, 204);
  });

  return app;
}
