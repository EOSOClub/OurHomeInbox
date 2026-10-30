// Accounts and sign-in: password hashing, sessions, and the limit on failed
// sign-ins.
//
// Passwords are kept only as scrypt hashes, with the cost settings stored next
// to each hash so they can be raised later without breaking old ones. A
// session is a random token in an HttpOnly cookie; the database keeps only its
// SHA-256, so a copied database file cannot be used to sign in.

import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { SessionUser } from "../shared/api.js";
import type { Database } from "./db.js";

export const SESSION_COOKIE = "ohi_session";
export const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
/** last_seen_at is written at most this often per session, not on every request. */
const SEEN_EVERY_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Passwords

// N=2^15, r=8 needs 32 MiB per hash and takes tens of milliseconds: slow for
// guessing, fine for a household server.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
// Room for the largest cost verifyPassword accepts (128 * N * r * p bytes).
const MAX_N = 2 ** 17;
const MAX_MEM = 128 * MAX_N * 8 + 1024 * 1024;

function scryptAsync(password: string, salt: Buffer, length: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** `scrypt$N$r$p$<salt base64>$<hash base64>` */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scryptAsync(password, salt, KEY_LENGTH, { ...SCRYPT, maxmem: MAX_MEM });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

/** False for a wrong password and for a stored value that is not a hash this code made. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  const valid = (n: number, max: number) => Number.isSafeInteger(n) && n >= 1 && n <= max;
  if (!valid(N, MAX_N) || (N & (N - 1)) !== 0 || !valid(r, 8) || !valid(p, 4)) return false;
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  if (salt.length === 0 || expected.length === 0) return false;
  const key = await scryptAsync(password, salt, expected.length, { N, r, p, maxmem: MAX_MEM });
  return timingSafeEqual(key, expected);
}

// Checked against when the email is unknown, so an unknown email takes as long
// as a wrong password and the timing does not tell which emails have accounts.
let dummyHash: Promise<string> | undefined;

export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(password, await dummyHash);
}

// ---------------------------------------------------------------------------
// Sessions

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Starts a session for the user. Returns the token for the cookie; only its hash is stored. */
export function createSession(db: Database, userId: number, now: Date): { token: string; expiresAt: Date } {
  deleteExpiredSessions(db, now);
  const token = newSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_MS);
  const stamp = now.toISOString();
  db.run(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
    hashToken(token),
    userId,
    stamp,
    expiresAt.toISOString(),
    stamp,
  );
  return { token, expiresAt };
}

interface SessionRow {
  token_hash: string;
  expires_at: string;
  last_seen_at: string;
  user_id: number;
  email: string;
  name: string;
  is_admin: number;
  household_id: number;
  household_name: string;
}

/** The signed-in user for a session token, or null when the token is unknown or expired. */
export function findSession(db: Database, token: string, now: Date): SessionUser | null {
  const row = db.get<SessionRow>(
    `SELECT s.token_hash, s.expires_at, s.last_seen_at, u.id AS user_id, u.email, u.name, u.is_admin,
            h.id AS household_id, h.name AS household_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN households h ON h.id = u.household_id
      WHERE s.token_hash = ?`,
    hashToken(token),
  );
  if (!row) return null;
  const stamp = now.toISOString();
  if (row.expires_at <= stamp) {
    db.run("DELETE FROM sessions WHERE token_hash = ?", row.token_hash);
    return null;
  }
  if (now.getTime() - Date.parse(row.last_seen_at) >= SEEN_EVERY_MS) {
    db.run("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?", stamp, row.token_hash);
  }
  return {
    id: row.user_id,
    email: row.email,
    name: row.name,
    isAdmin: row.is_admin === 1,
    household: { id: row.household_id, name: row.household_name },
  };
}

export function deleteSession(db: Database, token: string): void {
  db.run("DELETE FROM sessions WHERE token_hash = ?", hashToken(token));
}

export function deleteExpiredSessions(db: Database, now: Date): void {
  db.run("DELETE FROM sessions WHERE expires_at <= ?", now.toISOString());
}

// ---------------------------------------------------------------------------
// Failed sign-in limit

export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
// A ceiling on what the limiter remembers, so a flood of made-up emails cannot
// grow it without end. Past it, the oldest entries are dropped first.
const MAX_TRACKED = 10_000;

/**
 * Counts failed sign-ins per email and per client address, in memory. After
 * LOGIN_MAX_FAILURES failures within LOGIN_WINDOW_MS, further attempts are
 * refused until the oldest failure is out of the window. A restart forgets.
 */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly now: () => Date) {}

  /** True when this email or this address has failed too often recently. */
  blocked(email: string, ip: string): boolean {
    return this.recent(`email:${email}`) >= LOGIN_MAX_FAILURES || this.recent(`ip:${ip}`) >= LOGIN_MAX_FAILURES;
  }

  fail(email: string, ip: string): void {
    for (const key of [`email:${email}`, `ip:${ip}`]) {
      const times = this.prune(key);
      times.push(this.now().getTime());
      this.failures.delete(key); // re-insert so Map order stays oldest-touched first
      this.failures.set(key, times);
    }
    while (this.failures.size > MAX_TRACKED) {
      const oldest = this.failures.keys().next().value;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
  }

  /** A successful sign-in clears the email's failures (not the address's). */
  succeed(email: string): void {
    this.failures.delete(`email:${email}`);
  }

  private recent(key: string): number {
    return this.prune(key).length;
  }

  private prune(key: string): number[] {
    const cutoff = this.now().getTime() - LOGIN_WINDOW_MS;
    const times = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (times.length === 0) this.failures.delete(key);
    else this.failures.set(key, times);
    return times;
  }
}
